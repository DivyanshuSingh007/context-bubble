import hmac
import re
from typing import List, Optional
from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Response, status
from pydantic import BaseModel
from app.core.firestore_compat import firestore

from app.api.deps import require_bubble_host, get_bubble_participant, AuthenticatedUser, get_current_user
from app.core.config import settings, INSECURE_DEFAULT_INTERNAL_SECRET
from app.models.export import PopBubbleRequest, ExportConfig, ExportRecord, ExecutiveBriefing
from app.llm.factory import get_llm_adapter
from app.pop.briefing_generator import BriefingGenerator
from app.services.firebase import get_async_firestore_client
from app.pop.state_machine import PopStateMachine
from app.pop.scheduler import PopScheduler

router = APIRouter()


class TaskExecutePayload(BaseModel):
    bubble_id: str


def _require_internal_secret(provided: Optional[str]) -> None:
    """Guards Cloud Tasks / Scheduler webhooks. Outside development/test the
    committed placeholder secret is rejected, so these endpoints stay closed
    until a real SERVER_INTERNAL_SECRET is configured."""
    if settings.ENVIRONMENT in ("development", "test"):
        return
    expected = settings.SERVER_INTERNAL_SECRET
    if (
        not provided
        or expected == INSECURE_DEFAULT_INTERNAL_SECRET
        or not hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8"))
    ):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid internal task secret.")


@router.post("")
async def pop_bubble(
    bubble_id: str,
    req: PopBubbleRequest = PopBubbleRequest(),
    host=Depends(require_bubble_host),
    user: AuthenticatedUser = Depends(get_current_user),
):
    """Host confirms end options and starts the finalization pipeline."""
    db = get_async_firestore_client()
    state_machine = PopStateMachine(db)
    final_state = await state_machine.initiate_pop(
        bubble_id=bubble_id,
        actor_id=user.uid,
        req=req,
        is_timer_expiry=False,
    )
    return {"status": "ok", "pop_state": final_state}


@router.post("/start", status_code=status.HTTP_202_ACCEPTED)
async def start_pop_bubble(
    bubble_id: str,
    background_tasks: BackgroundTasks,
    req: PopBubbleRequest = PopBubbleRequest(),
    host=Depends(require_bubble_host),
    user: AuthenticatedUser = Depends(get_current_user),
):
    """Queue the normal end flow and return so the host can leave immediately."""
    db = get_async_firestore_client()
    state_machine = PopStateMachine(db)
    background_tasks.add_task(
        state_machine.initiate_pop,
        bubble_id=bubble_id,
        actor_id=user.uid,
        req=req,
        is_timer_expiry=False,
    )
    return {"status": "accepted", "pop_state": "POPPING"}


@router.get("/status")
async def get_pop_status(
    bubble_id: str,
    participant=Depends(get_bubble_participant),
):
    db = get_async_firestore_client()
    snap = await db.collection("bubbles").document(bubble_id).get()
    if not snap.exists:
        if bubble_id == "demo":
            return {
                "bubble_id": "demo",
                "pop_state": "ACTIVE",
                "is_live": True,
                "retention_policy": "temporary-plus-record",
                "exports": [],
            }
        return {"pop_state": "POPPED"}

    bdata = snap.to_dict() or {}
    exports_snap = await db.collection("bubbles").document(bubble_id).collection("exports").get()
    exports = [ExportRecord(**e.to_dict()) for e in exports_snap]

    return {
        "bubble_id": bubble_id,
        "pop_state": bdata.get("pop_state", "ACTIVE"),
        "popped_at": bdata.get("popped_at"),
        "pop_reason": bdata.get("pop_reason"),
        "retention_policy": bdata.get("retention_policy", "temporary"),
        "expiry_decision_deadline": bdata.get("expiry_decision_deadline"),
        "view_until": bdata.get("view_until"),
        "exports": exports,
    }


async def _load_briefing(bubble_id: str, user: AuthenticatedUser) -> dict:
    """Loads the stored decision record if this user may read it (host, or shared with them)."""
    db = get_async_firestore_client()
    history_snap = await (
        db.collection("user_bubble_history").document(user.uid)
        .collection("bubbles").document(bubble_id).get()
    )
    history = history_snap.to_dict() or {}
    if not history_snap.exists or not (
        history.get("decision_record_shared") or history.get("host_id") == user.uid
    ):
        b_snap = await db.collection("bubbles").document(bubble_id).get()
        b_data = b_snap.to_dict() or {}
        if b_data.get("host_id") != user.uid and settings.ENVIRONMENT not in ("development", "test"):
            raise HTTPException(status_code=403, detail="This decision record was not shared with your account.")
    snap = await db.collection("bubbles").document(bubble_id).collection("briefing").document("latest").get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="Briefing not found for this bubble.")
    return snap.to_dict() or {}


@router.get("/briefing")
async def get_briefing(
    bubble_id: str,
    user: AuthenticatedUser = Depends(get_current_user),
):
    """Returns the real executive briefing generated during pop."""
    return await _load_briefing(bubble_id, user)


@router.get("/briefing/pdf")
async def download_briefing_pdf(
    bubble_id: str,
    user: AuthenticatedUser = Depends(get_current_user),
):
    """Returns the decision record as a downloadable PDF."""
    briefing = ExecutiveBriefing(**(await _load_briefing(bubble_id, user)))
    pdf_bytes = BriefingGenerator(get_llm_adapter()).render_pdf(briefing)
    filename = _record_filename(briefing.bubble_title or bubble_id, "pdf")
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _record_filename(title: str, extension: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "-", title).strip("-").lower()[:60] or "bubble"
    return f"decision-record-{slug}.{extension}"


@router.post("/export-config")
async def configure_export_target(
    bubble_id: str,
    config: ExportConfig,
    host=Depends(require_bubble_host),
):
    db = get_async_firestore_client()
    cfg_ref = db.collection("bubbles").document(bubble_id).collection("export_configs").document(config.target)
    await cfg_ref.set(config.model_dump(mode="json"))
    return {"status": "configured", "target": config.target}


@router.post("/tasks/execute")
async def execute_cloud_task_pop(
    payload: TaskExecutePayload,
    x_server_internal_secret: Optional[str] = Header(None, alias="X-Server-Internal-Secret"),
):
    """Internal webhook called by Google Cloud Tasks when the timer hits zero."""
    _require_internal_secret(x_server_internal_secret)

    db = get_async_firestore_client()
    state_machine = PopStateMachine(db)
    state = await state_machine.begin_expiry_grace(payload.bubble_id)
    return {"status": "expiry_grace_started", "bubble_id": payload.bubble_id, "pop_state": state}


@router.post("/tasks/sweeper")
async def execute_sweeper(
    x_server_internal_secret: Optional[str] = Header(None, alias="X-Server-Internal-Secret"),
):
    """Internal webhook called by Google Cloud Scheduler to check for missed expired bubbles."""
    _require_internal_secret(x_server_internal_secret)

    db = get_async_firestore_client()
    scheduler = PopScheduler(db)
    state_machine = PopStateMachine(db)

    await scheduler.run_sweeper_backstop()
    return {"status": "sweeper_completed"}
