from typing import Optional

from fastapi import APIRouter, HTTPException, WebSocket, Query, status
from app.api.deps import get_bubble_participant, get_current_user
from app.services.firebase import get_async_firestore_client
from app.llm.factory import get_llm_adapter
from app.ingest.audio_transcriber import AudioTranscriptionSession
from app.core.logging import logger

router = APIRouter()


@router.websocket("")
async def websocket_audio_transcription(
    websocket: WebSocket,
    bubble_id: str,
    token: Optional[str] = Query(default=None),
):
    # Browsers cannot set headers on a WebSocket handshake, so the ID token is
    # passed as a query parameter. The speaker identity is always derived from
    # the verified token, never from client-supplied fields.
    try:
        user = await get_current_user(authorization=f"Bearer {token}" if token else None)
        member = await get_bubble_participant(bubble_id, user)
    except HTTPException as exc:
        logger.info(f"Rejected audio session for bubble={bubble_id}: {exc.detail}")
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    db = get_async_firestore_client()
    llm = get_llm_adapter()

    session = AudioTranscriptionSession(
        websocket=websocket,
        bubble_id=bubble_id,
        user_id=user.uid,
        user_name=member.get("name") or user.name,
        db=db,
        llm=llm,
    )
    await session.handle_stream()
