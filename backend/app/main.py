import asyncio
import os
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

# Ensure backend root is always on sys.path
_backend_dir = str(Path(__file__).resolve().parent.parent)
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

try:
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
    HAS_OTEL_INSTRUMENTOR = True
except ImportError:
    FastAPIInstrumentor = None
    HAS_OTEL_INSTRUMENTOR = False

from app.core.config import settings, INSECURE_DEFAULT_INTERNAL_SECRET
from app.core.logging import logger
from app.core.telemetry import init_telemetry
from app.core.exceptions import BubbleException
from app.services.firebase import init_firebase, get_async_firestore_client
from app.api.v1 import api_v1_router



from app.core.firestore_compat import InMemoryFirestoreClient


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    logger.info(f"Starting Context Bubble backend (Env: {settings.ENVIRONMENT})")
    if settings.ENVIRONMENT not in ("development", "test") and settings.SERVER_INTERNAL_SECRET == INSECURE_DEFAULT_INTERNAL_SECRET:
        logger.warning(
            "SERVER_INTERNAL_SECRET is unset; internal task webhooks are disabled and shred receipts "
            "are signed with a public placeholder key. Set SERVER_INTERNAL_SECRET in the environment."
        )
    init_telemetry("context-bubble-backend")
    init_firebase()
    # Eagerly initialize Firestore async client
    db = get_async_firestore_client()
    if settings.ENVIRONMENT in ("development", "test") and not isinstance(db, InMemoryFirestoreClient):
        try:
            await asyncio.wait_for(db.collection("bubbles").limit(1).get(), timeout=2.5)
            logger.info("Cloud Firestore connectivity verified successfully.")
        except Exception as exc:
            logger.warning(
                f"Cloud Firestore probe failed ({exc}). Automatically switching to InMemoryFirestoreClient for development."
            )
            from app.services import firebase as fb_svc
            fb_svc._async_firestore_client = InMemoryFirestoreClient()
            db = fb_svc._async_firestore_client

    if isinstance(db, InMemoryFirestoreClient) and not db.store:
        try:
            from scripts.seed_demo import seed_demo
            await seed_demo()
            logger.info("Seeded demo bubble into InMemoryFirestoreClient.")
        except Exception as seed_err:
            logger.warning(f"Demo bubble seed notice: {seed_err}")

    from app.intelligence.stream_manager import stream_manager
    await stream_manager.initialize_redis()
    from app.pop.scheduler import PopScheduler
    scheduler = PopScheduler(get_async_firestore_client())
    sweeper_task = asyncio.create_task(scheduler.start_background_loop(interval_seconds=15.0))
    yield
    # Shutdown
    sweeper_task.cancel()
    if stream_manager._redis:
        await stream_manager._redis.aclose()
    logger.info("Shutting down Context Bubble backend")




app = FastAPI(
    title="Context Bubble Backend API",
    description="High-velocity ephemeral collaboration backend with live intelligence and auto-pop shredding",
    version="0.1.0",
    lifespan=lifespan,
)

# OpenTelemetry Instrumentation
if HAS_OTEL_INSTRUMENTOR and FastAPIInstrumentor:
    FastAPIInstrumentor.instrument_app(app)


# CORS Configuration: allow all origins with credentials support for local development
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://.*$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Response-Time-Ms"],
)


def _public_error_message(exc: Exception) -> str:
    # Raw exception text can leak internals (paths, queries, credentials) to clients.
    if settings.ENVIRONMENT in ("development", "test"):
        return str(exc)
    return "An unexpected error occurred."


@app.middleware("http")
async def logging_and_timing_middleware(request: Request, call_next):
    start_time = time.time()
    try:
        response = await call_next(request)
        duration_ms = round((time.time() - start_time) * 1000, 2)
        logger.info(
            f"{request.method} {request.url.path} -> {response.status_code} ({duration_ms}ms)"
        )
        response.headers["X-Response-Time-Ms"] = str(duration_ms)
        return response
    except Exception as exc:
        duration_ms = round((time.time() - start_time) * 1000, 2)
        logger.error(
            f"Unhandled error on {request.method} {request.url.path} ({duration_ms}ms): {exc}",
            exc_info=True,
        )
        origin = request.headers.get("origin") or "*"
        return JSONResponse(
            status_code=500,
            content={
                "error": {
                    "code": "INTERNAL_SERVER_ERROR",
                    "message": _public_error_message(exc),
                }
            },
            headers={
                "X-Response-Time-Ms": str(duration_ms),
                "Access-Control-Allow-Origin": origin,
                "Access-Control-Allow-Credentials": "true",
                "Access-Control-Allow-Methods": "*",
                "Access-Control-Allow-Headers": "*",
            },
        )


@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    logger.error(
        f"Global unhandled error on {request.method} {request.url.path}: {exc}",
        exc_info=True,
    )
    origin = request.headers.get("origin") or "*"
    return JSONResponse(
        status_code=500,
        content={
            "error": {
                "code": "INTERNAL_SERVER_ERROR",
                "message": _public_error_message(exc),
            }
        },
        headers={
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Allow-Methods": "*",
            "Access-Control-Allow-Headers": "*",
        },
    )


@app.exception_handler(BubbleException)
async def bubble_exception_handler(request: Request, exc: BubbleException):
    origin = request.headers.get("origin") or "*"
    headers = dict(exc.headers or {})
    headers.setdefault("Access-Control-Allow-Origin", origin)
    headers.setdefault("Access-Control-Allow-Credentials", "true")
    headers.setdefault("Access-Control-Allow-Methods", "*")
    headers.setdefault("Access-Control-Allow-Headers", "*")
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error": {
                "code": exc.code,
                "message": exc.detail,
                "extra": exc.extra,
            }
        },
        headers=headers,
    )


# Mount API v1 router
app.include_router(api_v1_router, prefix="/api/v1")


@app.get("/")
async def root():
    return {
        "service": "Context Bubble Backend",
        "version": "0.1.0",
        "status": "operational",
        "docs_url": "/docs",
    }


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "Context Bubble Backend",
        "version": "0.1.0",
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host=settings.HOST, port=settings.PORT, reload=True, app_dir=_backend_dir)

