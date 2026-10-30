from datetime import datetime, timezone
from fastapi import APIRouter
from app.core.config import settings
from app.llm.factory import get_llm_adapter

router = APIRouter()


@router.get("/liveness")
async def liveness():
    return {"status": "live", "timestamp": datetime.now(timezone.utc).isoformat()}


@router.get("/readiness")
async def readiness():
    return {
        "status": "ready",
        "environment": settings.ENVIRONMENT,
        "llm_provider": settings.LLM_PROVIDER,
        # True when a real model client is available (never exposes the key itself).
        "llm_configured": bool(getattr(getattr(get_llm_adapter(), "primary", None), "is_configured", False)),
        "project": settings.GOOGLE_CLOUD_PROJECT,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
