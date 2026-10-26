import os
from typing import List, Literal
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field

# Committed placeholder; never valid outside development/test (see pop internal task endpoints).
INSECURE_DEFAULT_INTERNAL_SECRET = "dev-internal-secret-for-cloud-tasks-and-schedulers"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=["backend/.env", ".env"],
        env_file_encoding="utf-8",
        extra="ignore"
    )

    ENVIRONMENT: Literal["development", "staging", "production", "test"] = "development"
    PORT: int = 8000
    HOST: str = "0.0.0.0"
    CORS_ORIGINS: List[str] = ["*"]

    # Google Cloud & Firebase
    GOOGLE_CLOUD_PROJECT: str = "context-bubble-dev"
    GOOGLE_APPLICATION_CREDENTIALS: str = Field(default="", description="Path to service account JSON key")
    FIRESTORE_DATABASE: str = "(default)"
    FIRESTORE_EMULATOR_HOST: str | None = None
    FIREBASE_STORAGE_EMULATOR_HOST: str | None = None
    FIREBASE_AUTH_EMULATOR_HOST: str | None = None
    USE_IN_MEMORY_FIRESTORE: bool = False
    GCS_BUCKET_NAME: str = "context-bubble-artifacts"
    CLOUD_TASKS_QUEUE_PATH: str = "projects/context-bubble-dev/locations/us-central1/queues/bubble-timers"
    CLOUD_TASKS_HANDLER_URL: str = "http://localhost:8000/api/v1/pop/tasks/execute"

    # LLM Settings
    LLM_PROVIDER: Literal["gemini", "anthropic"] = "gemini"
    GEMINI_API_KEY: str = Field(default="", description="Google Gemini API key")
    GEMINI_MODEL: str = "gemini-3.5-flash-lite"
    GEMINI_FALLBACK_MODEL: str = "gemini-3.1-flash-lite"
    GEMINI_EMBEDDING_MODEL: str = "models/gemini-embedding-001"

    ANTHROPIC_API_KEY: str = Field(default="", description="Anthropic Claude API key")
    ANTHROPIC_MODEL: str = "claude-sonnet-4-6"

    # AssemblyAI
    ASSEMBLYAI_API_KEY: str = Field(default="", description="AssemblyAI speech-to-text API key")

    # Cloudinary (media & document storage with auto-expiration)
    CLOUDINARY_CLOUD_NAME: str = Field(default="", description="Cloudinary cloud name")
    CLOUDINARY_API_KEY: str = Field(default="", description="Cloudinary API key")
    CLOUDINARY_API_SECRET: str = Field(default="", description="Cloudinary API secret")

    # Security & Verification
    FIREBASE_APP_CHECK_ENFORCE: bool = False
    SERVER_INTERNAL_SECRET: str = INSECURE_DEFAULT_INTERNAL_SECRET
    REDIS_URL: str | None = None

    # Bubble Constraints & Debouncing
    FIREBASE_SERVICE_ACCOUNT_JSON: str = Field(default="", description="Raw JSON string or base64 of service account key")
    BUBBLE_MAX_PARTICIPANTS: int = 10
    BUBBLE_DEFAULT_TOKEN_BUDGET: int = 250000
    DEBOUNCE_TRAILING_SECONDS: float = 3.0
    DEBOUNCE_MAX_WAIT_SECONDS: float = 10.0
    RATE_LIMIT_PER_USER_RPM: int = 30
    AI_QUIET_PERIOD_SECONDS: float = 2.5


settings = Settings()

# Support inline service account JSON if GOOGLE_APPLICATION_CREDENTIALS is not set or missing
if settings.FIREBASE_SERVICE_ACCOUNT_JSON and not (settings.GOOGLE_APPLICATION_CREDENTIALS and os.path.exists(settings.GOOGLE_APPLICATION_CREDENTIALS)):
    try:
        import tempfile
        import base64
        content = settings.FIREBASE_SERVICE_ACCOUNT_JSON.strip()
        if not content.startswith("{") and (content.startswith("ey") or len(content) > 100):
            try:
                content = base64.b64decode(content).decode("utf-8")
            except Exception:
                pass
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".json", mode="w", encoding="utf-8")
        tmp.write(content)
        tmp.flush()
        tmp.close()
        settings.GOOGLE_APPLICATION_CREDENTIALS = tmp.name
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = tmp.name
    except Exception as e:
        pass

# Propagate service account path to os.environ so Firebase SDK / google-auth picks it up
if settings.GOOGLE_APPLICATION_CREDENTIALS and os.path.exists(settings.GOOGLE_APPLICATION_CREDENTIALS):
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = settings.GOOGLE_APPLICATION_CREDENTIALS
