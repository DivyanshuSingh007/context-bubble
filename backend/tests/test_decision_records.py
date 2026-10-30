import pytest
from httpx import AsyncClient, ASGITransport

from app.main import app
from app.api.deps import AuthenticatedUser, get_current_user
from app.core.config import settings
from app.core.firestore_compat import InMemoryFirestoreClient
from app.llm.base import LLMAdapter
from app.llm.gemini import GeminiAdapter
from app.models.export import ExecutiveBriefing
from app.pop.briefing_generator import BriefingGenerator
from app.services import firebase as fb_svc

# Shape produced by IntelligenceSynthesizer and stored in intelligence/latest.
LIVE_INTELLIGENCE = {
    "summary": "The team is debating whether onboarding or pricing caused the retention drop.",
    "disagreements": [{
        "id": "d1",
        "sideA": {"count": 2, "label": "Onboarding friction at setup step 3"},
        "sideB": {"count": 1, "label": "Pro plan price increase"},
    }],
    "missingPieces": [{"id": "mp1", "description": "Churn cohorts split by plan", "action": "request", "actionLabel": "Request data"}],
    "nextSteps": ["Revert setup step 3 as an experiment"],
    "raw_insights": [{"insight_id": "i1", "type": "consensus", "text": "Retention fell after the onboarding release", "confidence": 0.9}],
}


class FailingLLM(LLMAdapter):
    @property
    def model_name(self) -> str:
        return "failing"

    async def generate(self, *args, **kwargs):
        raise RuntimeError("model unavailable")

    async def stream(self, *args, **kwargs):
        raise RuntimeError("model unavailable")
        yield ""  # pragma: no cover

    async def embed(self, texts):
        return [[0.0] for _ in texts]


@pytest.mark.anyio
async def test_briefing_survives_llm_failure_using_live_intelligence():
    briefing = await BriefingGenerator(FailingLLM()).generate_briefing(
        bubble_id="b1",
        bubble_title="Retention review",
        session_text="[Priya]: retention dropped",
        intelligence=LIVE_INTELLIGENCE,
    )
    assert briefing.executive_summary == LIVE_INTELLIGENCE["summary"]
    assert briefing.disagreements[0].perspective_a == "Onboarding friction at setup step 3"
    assert briefing.disagreements[0].perspective_b == "Pro plan price increase"
    assert briefing.blockers == ["Churn cohorts split by plan"]
    assert briefing.consensus_points == ["Retention fell after the onboarding release"]
    assert briefing.action_items[0].task == "Revert setup step 3 as an experiment"
    assert "Viewpoint A" not in (briefing.markdown_content or "")


def test_pdf_renders_markup_characters_safely():
    briefing = ExecutiveBriefing(
        bubble_id="b1",
        bubble_title="Q3 <launch> & pricing",
        executive_summary="Use <b>bold</b> & keep 5 < 10 intact",
        decisions=["Ship if latency < 200ms & errors <1%"],
        blockers=["Vendor contract <unsigned>"],
    )
    pdf = BriefingGenerator(FailingLLM()).render_pdf(briefing)
    assert pdf.startswith(b"%PDF")


def test_mock_generation_refused_outside_tests(monkeypatch):
    adapter = GeminiAdapter(api_key="", model_name="gemini-3.5-flash-lite")
    assert not adapter.is_configured
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    with pytest.raises(RuntimeError):
        adapter._require_client_outside_tests()


@pytest.fixture
def records_db(monkeypatch):
    db = InMemoryFirestoreClient()
    monkeypatch.setattr(fb_svc, "_async_firestore_client", db)
    yield db
    app.dependency_overrides.pop(get_current_user, None)


async def _seed_record(db):
    ref = db.collection("bubbles").document("rec1")
    await ref.set({"id": "rec1", "title": "Retention review", "host_id": "host-uid", "pop_state": "POPPED"})
    await ref.collection("briefing").document("latest").set(
        ExecutiveBriefing(bubble_id="rec1", bubble_title="Retention review", executive_summary="Done.").model_dump(mode="json")
    )


@pytest.mark.anyio
async def test_host_can_download_decision_record_pdf(records_db, monkeypatch):
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    await _seed_record(records_db)
    app.dependency_overrides[get_current_user] = lambda: AuthenticatedUser(uid="host-uid", name="Host")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res = await client.get("/api/v1/bubbles/rec1/pop/briefing/pdf")
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/pdf"
    assert 'filename="decision-record-retention-review.pdf"' in res.headers["content-disposition"]
    assert res.content.startswith(b"%PDF")


@pytest.mark.anyio
async def test_unshared_decision_record_pdf_is_forbidden(records_db, monkeypatch):
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    await _seed_record(records_db)
    app.dependency_overrides[get_current_user] = lambda: AuthenticatedUser(uid="stranger", name="Stranger")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res = await client.get("/api/v1/bubbles/rec1/pop/briefing/pdf")
    assert res.status_code == 403
