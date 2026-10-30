"use client";

import { getCurrentIdToken } from "@/lib/auth";
import type {
  BubbleMember,
  KnowledgeGraph,
  PopState,
  AITriggerMode,
  RetentionPolicy,
  ExportTarget,
  ExportRecord,
  Intelligence,
  ExecutiveBriefing,
} from "@/types";

export const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

async function getAuthHeaders(isJson = true): Promise<HeadersInit> {
  const headers: Record<string, string> = {};
  if (isJson) {
    headers["Content-Type"] = "application/json";
  }

  try {
    const token = await getCurrentIdToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    } else {
      // In local dev mode, the backend accepts Bearer dev-* tokens
      headers["Authorization"] = "Bearer dev-participant";
    }
  } catch {
    headers["Authorization"] = "Bearer dev-participant";
  }

  return headers;
}

export interface CreateBubblePayload {
  title: string;
  duration_minutes?: number;
  retention_policy?: RetentionPolicy;
  anonymous_mode_enabled?: boolean;
  host_avatar_url?: string;
  host_avatar_animal?: string;
  trigger_mode?: AITriggerMode;
  token_budget?: number;
  e2ee_enabled?: boolean;
}

export interface BubbleResponseRaw {
  id: string;
  join_code?: string;
  title: string;
  is_live: boolean;
  expires_at: string;
  member_count: number;
  members: Array<{
    id: string;
    name: string;
    avatar?: string;
    role?: "host" | "participant";
    joined_at?: string;
    last_seen_at?: string;
  }>;
  retention_policy: RetentionPolicy;
  anonymous_mode_enabled: boolean;
  host_id: string;
  pop_state: PopState;
  trigger_mode: AITriggerMode;
  e2ee_enabled: boolean;
  created_at: string;
  expiry_decision_deadline?: string | null;
  view_until?: string | null;
  intelligence?: Intelligence | null;
}

export interface JoinBubblePayload {
  display_name: string;
  avatar_url?: string;
  avatar_animal?: string;
  join_code?: string;
}

export interface UpdateHostIdentityPayload {
  display_name: string;
  avatar_url?: string;
  avatar_animal?: string;
}

export async function updateBubbleHostIdentity(
  bubbleId: string,
  payload: UpdateHostIdentityPayload
): Promise<void> {
  const headers = await getAuthHeaders();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}/api/v1/bubbles/${bubbleId}/host/identity`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error("Updating your meeting identity timed out. Check that the server is running, then try again.");
    }
    throw err;
  } finally {
    window.clearTimeout(timeout);
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || `Could not update meeting identity (${res.status})`);
  }
}

// ─── API Client Methods ───────────────────────────────────────────────────────

/**
 * Creates a new Context Bubble on the FastAPI backend.
 */
export async function createBubble(payload: CreateBubblePayload): Promise<BubbleResponseRaw> {
  const headers = await getAuthHeaders();
  const res = await fetch(`${BACKEND_URL}/api/v1/bubbles`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: payload.title,
      duration_minutes: payload.duration_minutes || 120,
      retention_policy: payload.retention_policy || "temporary",
      anonymous_mode_enabled: Boolean(payload.anonymous_mode_enabled),
      host_avatar_url: payload.host_avatar_url,
      host_avatar_animal: payload.host_avatar_animal,
      trigger_mode: payload.trigger_mode || "mention",
      token_budget: payload.token_budget || 250000,
      e2ee_enabled: Boolean(payload.e2ee_enabled),
    }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.detail || errData.error?.message || `Failed to create bubble (${res.status})`);
  }

  return res.json();
}

/**
 * Fetches bubble metadata and active participants from the backend.
 */
export async function getBubble(bubbleId: string): Promise<BubbleResponseRaw> {
  const headers = await getAuthHeaders();
  const res = await fetch(`${BACKEND_URL}/api/v1/bubbles/${bubbleId}`, {
    method: "GET",
    headers,
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.detail || errData.error?.message || `Bubble "${bubbleId}" not found (${res.status})`);
  }

  return res.json();
}

/**
 * Joins a bubble as a participant with a display name.
 */
export async function joinBubble(
  bubbleId: string,
  payload: JoinBubblePayload
): Promise<BubbleMember> {
  const headers = await getAuthHeaders();
  const res = await fetch(`${BACKEND_URL}/api/v1/bubbles/${bubbleId}/join`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      display_name: payload.display_name,
      avatar_url: payload.avatar_url,
      avatar_animal: payload.avatar_animal,
      join_code: payload.join_code,
    }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.detail || errData.error?.message || `Failed to join bubble (${res.status})`);
  }

  return res.json();
}

export async function updateAnonymousAvailability(
  bubbleId: string,
  enabled: boolean,
): Promise<{ status: string; anonymous_mode_enabled: boolean }> {
  const headers = await getAuthHeaders();
  const res = await fetch(`${BACKEND_URL}/api/v1/bubbles/${bubbleId}/anonymous-mode`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || `Could not update anonymous mode (${res.status})`);
  }
  return res.json();
}

export async function leaveBubble(bubbleId: string): Promise<void> {
  const headers = await getAuthHeaders();
  const res = await fetch(`${BACKEND_URL}/api/v1/bubbles/${bubbleId}/leave`, { method: "POST", headers });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || `Could not leave bubble (${res.status})`);
  }
}

export async function removeBubbleParticipant(bubbleId: string, participantId: string): Promise<{ join_code: string }> {
  const headers = await getAuthHeaders();
  const res = await fetch(`${BACKEND_URL}/api/v1/bubbles/${bubbleId}/participants/${encodeURIComponent(participantId)}`, {
    method: "DELETE",
    headers,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || `Could not remove participant (${res.status})`);
  }
  return res.json();
}

/**
 * Extends the expiry of an active bubble. Host action.
 */
export async function extendBubble(
  bubbleId: string,
  additionalMinutes: number
): Promise<{ status: string; new_expires_at: string }> {
  const headers = await getAuthHeaders();
  const res = await fetch(`${BACKEND_URL}/api/v1/bubbles/${bubbleId}/extend`, {
    method: "POST",
    headers,
    body: JSON.stringify({ additional_minutes: additionalMinutes }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.detail || errData.error?.message || `Failed to extend bubble (${res.status})`);
  }

  return res.json();
}

/**
 * Updates AI trigger mode ('mention' | 'auto' | 'always'). Host action.
 */
export async function updateTriggerMode(
  bubbleId: string,
  triggerMode: AITriggerMode
): Promise<{ status: string; trigger_mode: AITriggerMode }> {
  const headers = await getAuthHeaders();
  const res = await fetch(`${BACKEND_URL}/api/v1/bubbles/${bubbleId}/trigger-mode`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ trigger_mode: triggerMode }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.detail || errData.error?.message || `Failed to update trigger mode (${res.status})`);
  }

  return res.json();
}

/**
 * Initiates bubble destruction (pop), briefing generation, export, and crypto-shredding.
 */
export async function popBubble(
  bubbleId: string,
  req?: {
    force_shred_on_export_failure?: boolean;
    dry_run?: boolean;
    custom_briefing_prompt?: string;
    retention_policy?: RetentionPolicy;
    share_decision_record?: boolean;
    view_retention_days?: number;
  }
): Promise<{ status: string; pop_state: PopState }> {
  const headers = await getAuthHeaders();
  const res = await fetch(`${BACKEND_URL}/api/v1/bubbles/${bubbleId}/pop`, {
    method: "POST",
    headers,
    body: JSON.stringify(req || {}),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.detail || errData.error?.message || `Failed to pop bubble (${res.status})`);
  }

  return res.json();
}

export async function startBubblePop(
  bubbleId: string,
  req: {
    retention_policy: RetentionPolicy;
    share_decision_record: boolean;
    view_retention_days?: number;
  },
): Promise<{ status: string; pop_state: PopState }> {
  const headers = await getAuthHeaders();
  const res = await fetch(`${BACKEND_URL}/api/v1/bubbles/${bubbleId}/pop/start`, {
    method: "POST",
    headers,
    body: JSON.stringify(req),
    keepalive: true,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || `Failed to start ending bubble (${res.status})`);
  }
  return res.json();
}

export interface BubbleHistoryEntry {
  bubble_id: string;
  title: string;
  popped_at: string;
  pop_reason: string;
  retention_policy: RetentionPolicy;
  view_until?: string | null;
  is_viewable: boolean;
  decision_record_shared: boolean;
}

export async function getBubbleHistory(): Promise<BubbleHistoryEntry[]> {
  const headers = await getAuthHeaders(false);
  const res = await fetch(`${BACKEND_URL}/api/v1/bubbles/history`, { headers });
  if (!res.ok) throw new Error("Could not load previous bubbles.");
  return res.json();
}

export async function deleteBubbleHistoryEntry(bubbleId: string): Promise<void> {
  const headers = await getAuthHeaders(false);
  const res = await fetch(`${BACKEND_URL}/api/v1/bubbles/history/${encodeURIComponent(bubbleId)}`, {
    method: "DELETE",
    headers,
  });
  if (!res.ok) throw new Error("Could not remove this bubble from My Bubbles.");
}

export async function deleteAllBubbleHistory(): Promise<void> {
  const headers = await getAuthHeaders(false);
  const res = await fetch(`${BACKEND_URL}/api/v1/bubbles/history`, {
    method: "DELETE",
    headers,
  });
  if (!res.ok) throw new Error("Could not clear My Bubbles.");
}

/**
 * Fetches the real executive briefing generated during bubble pop.
 */
export async function getBriefing(bubbleId: string): Promise<ExecutiveBriefing | null> {
  const headers = await getAuthHeaders(false);
  try {
    const res = await fetch(`${BACKEND_URL}/api/v1/bubbles/${bubbleId}/pop/briefing`, { headers });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

/**
 * Downloads the decision record PDF rendered by the backend.
 * Fetched with the auth header (a plain link cannot send it), then saved as a file.
 */
export async function downloadBriefingPdf(bubbleId: string, filename: string): Promise<void> {
  const headers = await getAuthHeaders(false);
  const res = await fetch(`${BACKEND_URL}/api/v1/bubbles/${bubbleId}/pop/briefing/pdf`, { headers });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || `Could not download the decision record (${res.status})`);
  }
  saveBlob(await res.blob(), filename);
}

/** Triggers a browser download for in-memory content. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke after the click has been handled so the download is not cancelled.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Fetches current pop status and list of external export records.
 */
export async function getPopStatus(
  bubbleId: string
): Promise<{
  bubble_id: string;
  pop_state: PopState;
  popped_at?: string;
  pop_reason?: string;
  retention_policy?: RetentionPolicy;
  expiry_decision_deadline?: string | null;
  view_until?: string | null;
  exports: ExportRecord[];
}> {
  const headers = await getAuthHeaders();
  const res = await fetch(`${BACKEND_URL}/api/v1/bubbles/${bubbleId}/pop/status`, {
    method: "GET",
    headers,
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.detail || errData.error?.message || `Failed to get pop status (${res.status})`);
  }

  return res.json();
}

/**
 * Configures an external export target (Slack, Notion, Linear, Jira). Host action.
 */
export async function configureExportTarget(
  bubbleId: string,
  config: {
    target: ExportTarget;
    enabled?: boolean;
    workspace_id?: string;
    target_channel_or_db?: string;
  }
): Promise<{ status: string; target: ExportTarget }> {
  const headers = await getAuthHeaders();
  const res = await fetch(`${BACKEND_URL}/api/v1/bubbles/${bubbleId}/pop/export-config`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      target: config.target,
      enabled: config.enabled !== undefined ? config.enabled : true,
      workspace_id: config.workspace_id,
      target_channel_or_db: config.target_channel_or_db,
    }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.detail || errData.error?.message || `Failed to configure export (${res.status})`);
  }

  return res.json();
}

/**
 * Fetches React Flow Knowledge Graph for the bubble.
 */
export async function getKnowledgeGraph(bubbleId: string): Promise<KnowledgeGraph> {
  const headers = await getAuthHeaders();
  const res = await fetch(`${BACKEND_URL}/api/v1/bubbles/${bubbleId}/graph`, {
    method: "GET",
    headers,
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.detail || errData.error?.message || `Failed to fetch knowledge graph (${res.status})`);
  }

  return res.json();
}

/**
 * Updates user typing status and online presence.
 */
export async function updatePresence(
  bubbleId: string,
  isTyping: boolean,
  status: "online" | "away" | "offline" = "online"
): Promise<{ status: string }> {
  const headers = await getAuthHeaders();
  const params = new URLSearchParams({
    is_typing: String(isTyping),
    status,
  });

  const res = await fetch(
    `${BACKEND_URL}/api/v1/bubbles/${bubbleId}/messages/presence?${params.toString()}`,
    {
      method: "POST",
      headers,
    }
  );

  if (!res.ok) {
    return { status: "ignored" };
  }

  return res.json();
}

export interface ActivePresence {
  user_id: string;
  display_name: string;
  status: "online" | "away" | "offline";
  is_typing: boolean;
}

export async function getActivePresence(bubbleId: string): Promise<ActivePresence[]> {
  const headers = await getAuthHeaders(false);
  const res = await fetch(
    `${BACKEND_URL}/api/v1/bubbles/${bubbleId}/messages/presence/active`,
    { headers },
  );
  if (!res.ok) return [];
  return res.json();
}

/**
 * Handles direct file upload to the backend (which uploads to Cloudinary),
 * extracts text, indexes in RAG, and triggers AI document review.
 */
export async function uploadAndProcessFile(
  bubbleId: string,
  file: File
): Promise<{ file_id: string; filename: string; char_count: number; secure_url: string; upload_url: string; preview_text: string }> {
  const token = await getCurrentIdToken().catch(() => null);
  const headers: Record<string, string> = {};
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  } else {
    headers["Authorization"] = "Bearer dev-participant";
  }

  const formData = new FormData();
  formData.append("file", file, file.name);

  const res = await fetch(`${BACKEND_URL}/api/v1/bubbles/${bubbleId}/files/upload`, {
    method: "POST",
    headers, // No Content-Type — browser sets multipart boundary automatically
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Upload failed (${res.status})`);
  }

  const data = await res.json();
  return {
    file_id: data.file_id,
    filename: data.filename,
    char_count: data.char_count || 0,
    secure_url: data.secure_url || "",
    upload_url: data.secure_url || "",
    preview_text: data.preview_text || "",
  };
}

// ─── SSE Stream Subscription ─────────────────────────────────────────────────

export interface SSECallbacks {
  onConnected?: (data: { status: string; bubble_id: string }) => void;
  onToken?: (token: string, seq?: number) => void;
  onAIToken?: (token: string) => void;
  onAIComplete?: (text: string) => void;
  onAIError?: (message: string) => void;
  onDelta?: (delta: Record<string, unknown>) => void;
  onComplete?: (intelligence: Intelligence) => void;
  onGraph?: (graph: KnowledgeGraph) => void;
  onPresence?: (presence: { user_id: string; display_name: string; is_typing: boolean; status: string }) => void;
  onPopState?: (state: PopState, receiptId?: string, popReason?: string, retentionPolicy?: string, message?: string, expiryDecisionDeadline?: string) => void;
  onMessage?: (message: Record<string, unknown>) => void;
  onMemberJoined?: (member: BubbleMember) => void;
  onMemberLeft?: (payload: { user_id: string; display_name: string }) => void;
  onMemberRemoved?: (payload: { user_id: string; removed_by_host?: boolean }) => void;
  onAnonymousModeUpdated?: (payload: { enabled: boolean }) => void;
  onError?: (error: Event) => void;
}

/**
 * Connects to the backend Server-Sent Events stream (/bubbles/{bubble_id}/stream).
 * EventSource cannot send headers, so the ID token travels as a query parameter.
 * Returns an unsubscribe teardown function.
 */
export function subscribeToBubbleStream(
  bubbleId: string,
  callbacks: SSECallbacks
): () => void {
  let eventSource: EventSource | null = null;
  let closed = false;
  let retryTimer: number | undefined;

  const connect = async () => {
    const token = await getCurrentIdToken().catch(() => null);
    if (closed) return;
    const query = token ? `?token=${encodeURIComponent(token)}` : "";
    const source = new EventSource(`${BACKEND_URL}/api/v1/bubbles/${bubbleId}/stream${query}`);
    eventSource = source;
    attachStreamListeners(source, callbacks);

    source.onerror = (err) => {
      callbacks.onError?.(err);
      // The browser retries dropped connections itself, but gives up for good on an
      // HTTP error (e.g. an expired token). Reconnect with a freshly minted token.
      if (source.readyState === EventSource.CLOSED && !closed) {
        window.clearTimeout(retryTimer);
        retryTimer = window.setTimeout(() => void connect(), 5000);
      }
    };
  };

  void connect();

  return () => {
    closed = true;
    window.clearTimeout(retryTimer);
    eventSource?.close();
  };
}

function attachStreamListeners(source: EventSource, callbacks: SSECallbacks): void {
  const on = (event: string, handle: (data: Record<string, unknown>) => void, onMalformed?: () => void) => {
    source.addEventListener(event, (e) => {
      try {
        handle(JSON.parse((e as MessageEvent).data));
      } catch {
        onMalformed?.();
      }
    });
  };

  on("connected", (data) => callbacks.onConnected?.(data as { status: string; bubble_id: string }));
  // Unnamed events also arrive as "message"; one listener covers both.
  on("message", (data) => callbacks.onMessage?.(data));
  on("member_joined", (data) => callbacks.onMemberJoined?.(data as unknown as BubbleMember));
  on("member_removed", (data) =>
    callbacks.onMemberRemoved?.({ user_id: String(data.user_id), removed_by_host: Boolean(data.removed_by_host) }));
  on("member_left", (data) =>
    callbacks.onMemberLeft?.({ user_id: String(data.user_id), display_name: String(data.display_name || "A participant") }));
  on("anonymous_mode_updated", (data) => callbacks.onAnonymousModeUpdated?.({ enabled: Boolean(data.enabled) }));
  on("token", (data) => callbacks.onToken?.(String(data.token ?? ""), data.seq as number | undefined));

  // AI participant events — routed to the intelligence panel, not the chat feed
  on("ai_token", (data) => callbacks.onAIToken?.(String(data.token ?? "")));
  on("ai_complete", (data) => callbacks.onAIComplete?.(String(data.text || "")));
  const aiErrorFallback = "Bubble AI could not generate a response.";
  on(
    "ai_error",
    (data) => callbacks.onAIError?.(String(data.message || aiErrorFallback)),
    () => callbacks.onAIError?.(aiErrorFallback),
  );

  on("delta", (data) => {
    if (data.type === "pop_state_change") {
      callbacks.onPopState?.(
        data.status as PopState,
        data.receipt_id as string | undefined,
        data.pop_reason as string | undefined,
        data.retention_policy as string | undefined,
        data.message as string | undefined,
        data.expiry_decision_deadline as string | undefined,
      );
    } else {
      callbacks.onDelta?.(data);
    }
  });
  on("complete", (data) => callbacks.onComplete?.(data as unknown as Intelligence));
  on("graph", (data) => callbacks.onGraph?.(data as unknown as KnowledgeGraph));
  on("presence", (data) => callbacks.onPresence?.(data as Parameters<NonNullable<SSECallbacks["onPresence"]>>[0]));
}
