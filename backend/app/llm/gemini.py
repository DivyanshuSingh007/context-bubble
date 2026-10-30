import asyncio
import json
import re
from typing import Any, AsyncIterator, Dict, List, Optional, Type, TypeVar
from pydantic import BaseModel

try:
    # pyrefly: ignore[missing-import]
    from google import genai
    from google.genai import types
    HAS_GENAI = True
except ImportError:
    genai = None
    types = None
    HAS_GENAI = False

from app.core.config import settings
from app.core.logging import logger
from app.llm.base import LLMAdapter, LLMResponse

T = TypeVar("T", bound=BaseModel)

# Default candidate models in order of priority for resilient failover (strictly 3.5-flash-lite and 3.1-flash-lite)
_CANDIDATE_GENERATION_MODELS = [
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
]

_CANDIDATE_EMBEDDING_MODELS = [
    "models/gemini-embedding-001",
    "gemini-embedding-001",
    "models/gemini-embedding-2",
]

_RETRY_ATTEMPTS = 3
_INITIAL_BACKOFF = 1.0


def _is_quota_or_rate_limit_error(error: Exception) -> bool:
    message = str(error).lower()
    return any(term in message for term in (
        "resource_exhausted", "quota", "rate limit", "429", "daily limit",
    ))


def _clean_schema_for_gemini(schema: Any) -> Any:
    """
    Transforms JSON Schema into a format acceptable by Google GenAI SDK.
    - Strips 'default' fields (which cause 'Default value is not supported in the response schema' ValueError)
    - Transforms anyOf: [{type: X}, {type: 'null'}] to {type: X, nullable: True}
    - Cleans nested dictionaries and lists recursively
    """
    if isinstance(schema, dict):
        cleaned: Dict[str, Any] = {}

        # Handle anyOf with null (Pydantic Optional fields)
        if "anyOf" in schema and isinstance(schema["anyOf"], list) and len(schema["anyOf"]) == 2:
            subtypes = schema["anyOf"]
            null_t = [t for t in subtypes if isinstance(t, dict) and t.get("type") == "null"]
            other_t = [t for t in subtypes if isinstance(t, dict) and t.get("type") != "null"]
            if len(null_t) == 1 and len(other_t) == 1:
                cleaned = _clean_schema_for_gemini(other_t[0])
                cleaned["nullable"] = True
                for k, v in schema.items():
                    if k not in ("anyOf", "default", "title") and k not in cleaned:
                        cleaned[k] = _clean_schema_for_gemini(v)
                return cleaned

        for k, v in schema.items():
            if k == "default":
                continue
            cleaned[k] = _clean_schema_for_gemini(v)
        return cleaned
    elif isinstance(schema, list):
        return [_clean_schema_for_gemini(item) for item in schema]
    return schema


def _extract_json_substring(text: str) -> str:
    """Extracts valid JSON substring from LLM response text."""
    clean = text.strip()
    if clean.startswith("```"):
        # Strip markdown fence
        lines = clean.split("\n")
        if len(lines) >= 2:
            first_line = lines[0]
            if first_line.startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].strip().endswith("```"):
                lines = lines[:-1]
            clean = "\n".join(lines).strip()

    # If already starts with { or [, return as is
    if (clean.startswith("{") and clean.endswith("}")) or (clean.startswith("[") and clean.endswith("]")):
        return clean

    # Search for outermost JSON object or array
    first_brace = clean.find("{")
    last_brace = clean.rfind("}")
    if first_brace != -1 and last_brace > first_brace:
        return clean[first_brace:last_brace + 1]

    first_bracket = clean.find("[")
    last_bracket = clean.rfind("]")
    if first_bracket != -1 and last_bracket > first_bracket:
        return clean[first_bracket:last_bracket + 1]

    return clean


class GeminiAdapter(LLMAdapter):
    def __init__(
        self,
        api_key: Optional[str] = None,
        model_name: Optional[str] = None,
        embedding_model: Optional[str] = None,
    ):
        self._api_key = api_key or settings.GEMINI_API_KEY
        self._model_name = model_name or settings.GEMINI_MODEL
        self._embedding_model = embedding_model or settings.GEMINI_EMBEDDING_MODEL

        if HAS_GENAI and self._api_key and not self._api_key.startswith("AIzaSyFake"):
            try:
                assert genai is not None
                self._client = genai.Client(api_key=self._api_key)
            except Exception as e:
                logger.error(f"Failed to initialize Google GenAI Client: {e}")
                self._client = None
        else:
            self._client = None
            if settings.ENVIRONMENT == "test":
                logger.info("GeminiAdapter initialized in mock mode for tests")
            else:
                logger.error("GEMINI_API_KEY is not configured; AI synthesis and briefings are disabled.")

    @property
    def model_name(self) -> str:
        return self._model_name

    @property
    def is_configured(self) -> bool:
        return self._client is not None

    def _require_client_outside_tests(self) -> None:
        # The mock fabricates "insights" by quoting chat messages back. That is only
        # acceptable in the test suite; anywhere else it reads as the AI echoing users.
        if settings.ENVIRONMENT != "test":
            raise RuntimeError("Gemini is not configured (missing or invalid GEMINI_API_KEY).")

    def _get_generation_models(self) -> List[str]:
        """Returns ordered list of candidate models with preferred model first, strictly constrained."""
        allowed = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]
        pref = self._model_name if self._model_name in allowed else "gemini-3.5-flash-lite"
        models = [pref]
        for m in _CANDIDATE_GENERATION_MODELS:
            if m in allowed and m not in models:
                models.append(m)
        return models

    def _get_embedding_models(self) -> List[str]:
        """Returns ordered list of candidate embedding models."""
        models = [self._embedding_model]
        for m in _CANDIDATE_EMBEDDING_MODELS:
            if m not in models:
                models.append(m)
        return models

    async def generate(
        self,
        prompt: str,
        system_prompt: Optional[str] = None,
        temperature: float = 0.2,
        max_tokens: int = 4096,
        response_schema: Optional[Type[T]] = None,
    ) -> LLMResponse:
        if not self._client:
            self._require_client_outside_tests()
            content = self._mock_generate(prompt, response_schema)
            parsed = None
            if response_schema:
                try:
                    parsed = response_schema.model_validate_json(content)
                except Exception as e:
                    logger.warning(f"Mock validation error: {e}")
            return LLMResponse(
                content=content,
                parsed=parsed,
                prompt_tokens=len(prompt) // 4,
                completion_tokens=len(content) // 4,
                total_tokens=(len(prompt) + len(content)) // 4,
                model=self._model_name,
            )

        config_dict: Dict[str, Any] = {
            "temperature": temperature,
            "max_output_tokens": max_tokens,
        }
        if system_prompt:
            config_dict["system_instruction"] = system_prompt

        schema_dict = None
        if response_schema:
            config_dict["response_mime_type"] = "application/json"
            # flash-lite models have a tokenizer/grammar bug with deep nested response_schema, causing token repetition loops.
            # For flash-lite models, response_mime_type='application/json' with Pydantic model validation is optimal and avoids the bug.
            is_flash_lite = "flash-lite" in (self._model_name or "").lower()
            if not is_flash_lite:
                if hasattr(response_schema, "model_json_schema"):
                    schema_dict = _clean_schema_for_gemini(response_schema.model_json_schema())
                    config_dict["response_schema"] = schema_dict
                elif isinstance(response_schema, dict):
                    schema_dict = _clean_schema_for_gemini(response_schema)
                    config_dict["response_schema"] = schema_dict
                else:
                    config_dict["response_schema"] = response_schema

        assert types is not None
        config = types.GenerateContentConfig(**config_dict)

        candidate_models = self._get_generation_models()
        last_exception = None

        for model in candidate_models:
            for attempt in range(_RETRY_ATTEMPTS):
                try:
                    response = await self._client.aio.models.generate_content(
                        model=model,
                        contents=prompt,
                        config=config,
                    )

                    # Extract content safely
                    content = ""
                    try:
                        content = getattr(response, "text", "") or ""
                    except Exception:
                        pass

                    if not content and getattr(response, "candidates", None) and response.candidates:
                        cand = response.candidates[0]
                        if getattr(cand, "content", None) and getattr(cand.content, "parts", None):
                            parts_text = [
                                getattr(p, "text", "") for p in cand.content.parts if getattr(p, "text", None)
                            ]
                            content = "".join(parts_text)

                    # Extract or parse structured output
                    parsed = None
                    if response_schema:
                        if getattr(response, "parsed", None) is not None and isinstance(response.parsed, response_schema):
                            parsed = response.parsed
                        else:
                            try:
                                clean_json = _extract_json_substring(content)
                                parsed = response_schema.model_validate_json(clean_json)
                            except Exception as parse_err:
                                logger.warning(f"Failed to parse structured output from Gemini ({model}): {parse_err}")

                    usage = getattr(response, "usage_metadata", None)
                    prompt_tokens = getattr(usage, "prompt_token_count", None) or (len(prompt) // 4)
                    candidate_tokens = getattr(usage, "candidates_token_count", None) or (len(content) // 4)

                    return LLMResponse(
                        content=content,
                        parsed=parsed,
                        prompt_tokens=prompt_tokens or 0,
                        completion_tokens=candidate_tokens or 0,
                        total_tokens=(prompt_tokens or 0) + (candidate_tokens or 0),
                        model=model,
                    )

                except Exception as e:
                    last_exception = e
                    err_msg = str(e)
                    is_transient = "503" in err_msg or "UNAVAILABLE" in err_msg or "429" in err_msg or "RESOURCE_EXHAUSTED" in err_msg
                    is_not_found = "404" in err_msg or "NOT_FOUND" in err_msg
                    is_invalid_arg = "400" in err_msg or "INVALID_ARGUMENT" in err_msg or "Default value" in err_msg
                    if _is_quota_or_rate_limit_error(e):
                        logger.warning(f"Gemini quota/rate limit reached for '{model}'; trying the next configured model.")
                        break

                    if is_not_found:
                        logger.warning(f"Gemini model '{model}' not found (404). Falling back to next candidate model.")
                        break  # Break retry loop, try next model immediately

                    # If schema caused a 400 or invalid argument, retry without response_schema in config
                    if is_invalid_arg and "response_schema" in config_dict:
                        logger.warning(f"Gemini schema rejected for '{model}': {err_msg[:60]}. Retrying in JSON mode without schema.")
                        config_dict.pop("response_schema", None)
                        config_dict["response_mime_type"] = "application/json"
                        config = types.GenerateContentConfig(**config_dict)
                        continue

                    if is_transient and attempt < _RETRY_ATTEMPTS - 1:
                        wait = _INITIAL_BACKOFF * (2 ** attempt)
                        logger.warning(f"Gemini model '{model}' busy ({err_msg[:60]}), retrying in {wait:.1f}s (attempt {attempt+1}/{_RETRY_ATTEMPTS})")
                        await asyncio.sleep(wait)
                    else:
                        logger.warning(f"Gemini model '{model}' failed ({err_msg[:80]}). Trying next candidate model.")
                        break

        raise last_exception or RuntimeError("All Gemini candidate models failed to generate content.")

    # pyrefly: ignore[bad-override]
    async def stream(
        self,
        prompt: str,
        system_prompt: Optional[str] = None,
        temperature: float = 0.3,
        max_tokens: int = 2048,
    ) -> AsyncIterator[str]:
        if not self._client:
            self._require_client_outside_tests()
            mock_tokens = ["Hello ", "from ", "Bubble ", "AI. ", "I ", "am ", "analyzing ", "your ", "session."]
            for token in mock_tokens:
                yield token
            return

        config_dict = {
            "temperature": temperature,
            "max_output_tokens": max_tokens,
        }
        if system_prompt:
            # pyrefly: ignore[bad-assignment]
            config_dict["system_instruction"] = system_prompt

        assert types is not None
        config = types.GenerateContentConfig(**config_dict)

        candidate_models = self._get_generation_models()
        last_exception: Optional[Exception] = None
        for model in candidate_models:
            for attempt in range(_RETRY_ATTEMPTS):
                try:
                    stream_resp = await self._client.aio.models.generate_content_stream(
                        model=model,
                        contents=prompt,
                        config=config,
                    )
                    emitted = False
                    # pyrefly: ignore[not-iterable]
                    async for chunk in stream_resp:
                        try:
                            text = getattr(chunk, "text", None)
                            if text:
                                emitted = True
                                yield text
                            elif getattr(chunk, "candidates", None) and chunk.candidates:
                                cand = chunk.candidates[0]
                                if getattr(cand, "content", None) and getattr(cand.content, "parts", None):
                                    for p in cand.content.parts:
                                        p_text = getattr(p, "text", None)
                                        if p_text:
                                            emitted = True
                                            yield p_text
                        except Exception:
                            continue
                    if emitted:
                        return
                    last_exception = RuntimeError(f"Gemini returned an empty stream for model '{model}'.")
                    logger.warning(str(last_exception))
                    break
                except Exception as e:
                    last_exception = e
                    err_msg = str(e)
                    is_transient = "503" in err_msg or "UNAVAILABLE" in err_msg
                    is_not_found = "404" in err_msg or "NOT_FOUND" in err_msg
                    if _is_quota_or_rate_limit_error(e):
                        logger.warning(f"Gemini stream quota/rate limit reached for '{model}'; trying the next configured model.")
                        break

                    if is_not_found:
                        break

                    if is_transient and attempt < _RETRY_ATTEMPTS - 1:
                        wait = _INITIAL_BACKOFF * (2 ** attempt)
                        logger.warning(f"Gemini stream on '{model}' failed; retrying in {wait:.1f}s (attempt {attempt + 1}/{_RETRY_ATTEMPTS}).")
                        await asyncio.sleep(wait)
                    else:
                        logger.warning(f"Gemini stream on '{model}' failed ({err_msg[:160]}). Trying next candidate model.")
                        break

        raise last_exception or RuntimeError("All Gemini candidate models failed to stream content.")

    async def embed(self, texts: List[str]) -> List[List[float]]:
        if not texts:
            return []

        if not self._client:
            return self._local_embeddings(texts)

        candidate_models = self._get_embedding_models()
        embed_config = None
        if types is not None:
            try:
                embed_config = types.EmbedContentConfig(output_dimensionality=768)
            except Exception:
                embed_config = None

        for model in candidate_models:
            try:
                # 1. Attempt batch embedding first for high throughput
                response = await self._client.aio.models.embed_content(
                    model=model,
                    contents=texts,
                    config=embed_config,
                )
                if getattr(response, "embeddings", None) and len(response.embeddings) == len(texts):
                    return [list(emb.values)[:768] if len(emb.values) > 2048 else list(emb.values) for emb in response.embeddings]
                elif getattr(response, "embedding", None) and len(texts) == 1:
                    vals = list(response.embedding.values)
                    return [vals[:768] if len(vals) > 2048 else vals]
            except Exception as batch_err:
                logger.debug(f"Gemini batch embedding on '{model}' fell back to sequential: {batch_err}")

            # 2. Sequential fallback if batch is not supported on this model
            try:
                results = []
                for text in texts:
                    response = await self._client.aio.models.embed_content(
                        model=model,
                        contents=text,
                        config=embed_config,
                    )
                    vals = None
                    if getattr(response, "embeddings", None) and response.embeddings:
                        vals = getattr(response.embeddings[0], "values", None)
                    elif getattr(response, "embedding", None):
                        vals = getattr(response.embedding, "values", None)

                    if vals is not None:
                        v_list = list(vals)
                        if len(v_list) > 2048:
                            v_list = v_list[:768]
                        results.append(v_list)
                    else:
                        raise ValueError(f"No embedding values returned in response from model {model}")

                return results
            except Exception as e:
                logger.warning(f"Gemini embedding model '{model}' failed ({e}). Trying next embedding model.")

        logger.warning("All Gemini embedding models failed. Falling back to local deterministic embeddings.")
        return self._local_embeddings(texts)

    def _local_embeddings(self, texts: List[str]) -> List[List[float]]:
        """Deterministic local embeddings fallback for test/offline use."""
        import hashlib
        embeddings = []
        for t in texts:
            h = int(hashlib.md5(t.encode("utf-8")).hexdigest(), 16)
            emb = [((h >> (i % 64)) & 1) * 0.1 for i in range(768)]
            embeddings.append(emb)
        return embeddings

    def _mock_generate(self, prompt: str, schema: Optional[Type[BaseModel]]) -> str:
        if schema and "ExecutiveBriefing" in schema.__name__:
            return json.dumps({
                "bubble_id": "demo",
                "bubble_title": "Executive Decision",
                "generated_at": "2026-10-18T16:00:00Z",
                "executive_summary": "Team converged on onboarding overhaul before pricing adjustments.",
                "decisions": ["Prioritize onboarding flow overhaul"],
                "consensus_points": ["Retention drop is hurting growth"],
                "disagreements": [{
                    "topic": "Pricing vs Onboarding",
                    "perspective_a": "Onboarding is too complex",
                    "perspective_b": "Pricing is 40% too high",
                    "unresolved_questions": ["Will price drop actually increase retention?"]
                }],
                "blockers": ["Lack of recent churn survey data"],
                "action_items": [{
                    "task": "Export churn analysis",
                    "owner": "Priya",
                    "priority": "high",
                    "deadline_hint": "Friday"
                }],
                "markdown_content": "# Executive Briefing\n\n- Onboarding overhaul agreed."
            })
        elif schema and "Insight" in schema.__name__:
            # Dynamically parse participant messages from prompt to synthesize from live chats
            lines = [ln.strip() for ln in prompt.split("\n") if ln.strip().startswith("[") and "]:" in ln]
            parsed_msgs = []
            for ln in lines:
                try:
                    auth_part, msg_text = ln.split("]:", 1)
                    author = auth_part.lstrip("[").strip()
                    parsed_msgs.append((author, msg_text.strip()))
                except Exception:
                    pass

            if parsed_msgs:
                authors = list(dict.fromkeys([a for a, _ in parsed_msgs]))
                first_author, first_msg = parsed_msgs[0]
                latest_author, latest_msg = parsed_msgs[-1]
                author_names = ", ".join(authors[:3]) + (" et al." if len(authors) > 3 else "")

                clean_first = first_msg[:100].rstrip(".?!")
                clean_latest = latest_msg[:100].rstrip(".?!")

                summary = (
                    f"Team deliberation with {author_names} focused on {clean_first.lower()}. "
                    f"Recent input from {latest_author} highlights {clean_latest.lower()}. "
                    f"The group is actively synthesizing trade-offs to reach team consensus."
                )

                disagreements = []
                if len(parsed_msgs) >= 2:
                    p1_author, p1_text = parsed_msgs[0]
                    p2_author, p2_text = parsed_msgs[-1] if parsed_msgs[-1][0] != p1_author else (parsed_msgs[1] if len(parsed_msgs) > 1 else (p1_author, p1_text))
                    disagreements.append({
                        "id": "d1",
                        "sideA": {"count": max(1, len(parsed_msgs) // 2), "label": p1_text[:40].strip() or "primary proposal"},
                        "sideB": {"count": max(1, (len(parsed_msgs) + 1) // 2), "label": p2_text[:40].strip() or "alternative approach"}
                    })
                else:
                    disagreements.append({
                        "id": "d1",
                        "sideA": {"count": 1, "label": parsed_msgs[0][1][:40] or "current direction"},
                        "sideB": {"count": 1, "label": "competing priority"}
                    })

                questions = [m for _, m in parsed_msgs if "?" in m]
                missing_desc = questions[0].replace("?", "").strip() if questions else f"Verified data for {parsed_msgs[-1][1][:45].strip()}"
                missing_pieces = [{
                    "id": "mp1",
                    "description": missing_desc,
                    "action": "request",
                    "actionLabel": "Request data"
                }]

                action_cues = ("let's", "lets", "will", "need to", "should", "plan", "todo", "review", "schedule")
                action_msgs = [m for _, m in parsed_msgs if any(c in m.lower() for c in action_cues)]
                next_steps = [m[:80].strip() for m in action_msgs[:3]]
                if not next_steps:
                    next_steps = [f"Synthesize decisions on {parsed_msgs[-1][1][:50].strip()}", "Align on next milestones"]

                insights = [
                    {
                        "insight_id": "ins-1",
                        "type": "consensus",
                        "text": f"Core deliberation focus: {parsed_msgs[0][1][:70]}",
                        "confidence": 0.9,
                        "supporting_contribution_ids": []
                    },
                    {
                        "insight_id": "ins-2",
                        "type": "debate",
                        "text": f"Differing perspectives raised between {authors[0]} and {authors[-1] if len(authors) > 1 else 'team'}",
                        "confidence": 0.85,
                        "supporting_contribution_ids": []
                    }
                ]

                return json.dumps({
                    "summary": summary,
                    "disagreements": disagreements,
                    "missing_pieces": missing_pieces,
                    "insights": insights,
                    "next_steps": next_steps
                })
            else:
                return json.dumps({
                    "summary": "Team session in progress. Deliberation insights will dynamically populate as participants contribute.",
                    "disagreements": [],
                    "missing_pieces": [],
                    "insights": [],
                    "next_steps": ["Begin sharing viewpoints and questions to synthesize live intelligence"]
                })
        elif schema:
            # Generic valid JSON object for arbitrary test schemas
            try:
                inst = schema()
                return inst.model_dump_json()
            except Exception:
                return "{}"
        return "Analysis completed successfully."
