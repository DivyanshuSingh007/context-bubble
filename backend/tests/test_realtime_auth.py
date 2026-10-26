import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from httpx import AsyncClient, ASGITransport
from starlette.websockets import WebSocketDisconnect

from app.main import app
from app.api.v1.pop import _require_internal_secret
from app.core.config import settings, INSECURE_DEFAULT_INTERNAL_SECRET
from app.core.firestore_compat import InMemoryFirestoreClient
from app.services import firebase as fb_svc


@pytest.fixture(autouse=True)
def isolated_env(monkeypatch):
    monkeypatch.setattr(settings, "ENVIRONMENT", "test")
    db = InMemoryFirestoreClient()
    monkeypatch.setattr(fb_svc, "_async_firestore_client", db)
    return db


async def _seed_popped_bubble(db, bubble_id: str):
    # A popped bubble owned by someone else: no auto-join, no dev host match.
    await db.collection("bubbles").document(bubble_id).set({
        "id": bubble_id,
        "title": "Private",
        "host_id": "real-host-uid",
        "pop_state": "POPPED",
        "retention_policy": "temporary",
    })


@pytest.mark.anyio
async def test_stream_requires_token_in_production(monkeypatch):
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/api/v1/bubbles/any-bubble/stream")
    assert res.status_code == 401


@pytest.mark.anyio
async def test_stream_rejects_non_participant(isolated_env):
    await _seed_popped_bubble(isolated_env, "private-bubble")
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/api/v1/bubbles/private-bubble/stream?token=dev-intruder")
    assert res.status_code == 403


def test_audio_socket_rejects_missing_token(monkeypatch):
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    client = TestClient(app)
    with pytest.raises(WebSocketDisconnect) as exc_info:
        with client.websocket_connect("/api/v1/bubbles/any-bubble/audio?user_id=victim&user_name=Victim"):
            pass
    assert exc_info.value.code == 1008


def test_internal_secret_rejects_placeholder_outside_dev(monkeypatch):
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    monkeypatch.setattr(settings, "SERVER_INTERNAL_SECRET", INSECURE_DEFAULT_INTERNAL_SECRET)
    with pytest.raises(HTTPException) as exc_info:
        _require_internal_secret(INSECURE_DEFAULT_INTERNAL_SECRET)
    assert exc_info.value.status_code == 403


def test_internal_secret_requires_exact_match(monkeypatch):
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    monkeypatch.setattr(settings, "SERVER_INTERNAL_SECRET", "a-real-configured-secret")
    _require_internal_secret("a-real-configured-secret")
    for bad in (None, "", "a-real-configured-secreT"):
        with pytest.raises(HTTPException):
            _require_internal_secret(bad)
