"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import type { Bubble, AITriggerMode, ExportTarget, PopState } from "@/types";
import { formatExpiry } from "@/lib/sample-data";
import { extendBubble, updateTriggerMode, configureExportTarget, popBubble } from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

interface Props {
  bubble: Bubble;
  onClose: () => void;
  onToggleAnonymous: () => void;
  onExtendExpiry?: () => void;
  onBubbleUpdated?: (updated: Partial<Bubble>) => void;
  onBubblePopped?: (finalState: PopState) => void;
  onRemoveParticipant?: (participantId: string) => Promise<void>;
}

export function ManageBubblePanel({
  bubble,
  onClose,
  onToggleAnonymous,
  onExtendExpiry,
  onBubbleUpdated,
  onBubblePopped,
  onRemoveParticipant,
}: Props) {
  const router = useRouter();
  const [expiryLabel, setExpiryLabel] = useState<string>(() => formatExpiry(bubble.expiresAt));
  const [copied, setCopied] = useState(false);

  // AI Trigger Mode state
  const [triggerMode, setTriggerMode] = useState<AITriggerMode>(bubble.triggerMode || "auto");
  const [isUpdatingTrigger, setIsUpdatingTrigger] = useState(false);

  // Extend Expiry state
  const [isExtending, setIsExtending] = useState(false);

  // Export targets
  const [exportsConfig, setExportsConfig] = useState<Record<ExportTarget, boolean>>({
    markdown: true,
    pdf: true,
    slack: true,
    notion: false,
    linear: false,
    jira: false,
  });

  // Pop confirmation modal
  const [showPopModal, setShowPopModal] = useState(false);
  const [isPopping, setIsPopping] = useState(false);
  const [popDryRun, setPopDryRun] = useState(false);
  const [customBriefingPrompt, setCustomBriefingPrompt] = useState("");
  const [popStatusText, setPopStatusText] = useState<string | null>(null);
  const [removingParticipantId, setRemovingParticipantId] = useState<string | null>(null);
  const [participantError, setParticipantError] = useState<string | null>(null);
  const [participantToRemove, setParticipantToRemove] = useState<{ id: string; name: string } | null>(null);

  const removeParticipant = async (participantId: string) => {
    if (!onRemoveParticipant) return;
    setRemovingParticipantId(participantId);
    setParticipantError(null);
    try {
      await onRemoveParticipant(participantId);
      setParticipantToRemove(null);
    } catch (err) {
      setParticipantError(err instanceof Error ? err.message : "Could not remove participant.");
    } finally {
      setRemovingParticipantId(null);
    }
  };

  useEffect(() => {
    const timer = setInterval(() => {
      setExpiryLabel(formatExpiry(bubble.expiresAt));
    }, 1000);
    return () => clearInterval(timer);
  }, [bubble.expiresAt]);

  const handleCopyInviteLink = () => {
    const inviteUrl =
      typeof window !== "undefined"
        ? `${window.location.origin}/join?code=${bubble.joinCode || bubble.id}`
        : `/join?code=${bubble.joinCode || bubble.id}`;

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(inviteUrl).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    } else {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleExtend = async (minutes: number) => {
    setIsExtending(true);
    try {
      const res = await extendBubble(bubble.id, minutes);
      const newExpiry = new Date(res.new_expires_at || Date.now() + minutes * 60 * 1000);
      if (onBubbleUpdated) {
        onBubbleUpdated({ expiresAt: newExpiry });
      }
      if (onExtendExpiry) {
        onExtendExpiry();
      }
    } catch (err: unknown) {
      console.warn("Extend bubble notice (falling back locally):", err);
      if (onExtendExpiry) onExtendExpiry();
    } finally {
      setIsExtending(false);
    }
  };

  const handleTriggerModeChange = async (mode: AITriggerMode) => {
    setTriggerMode(mode);
    setIsUpdatingTrigger(true);
    try {
      await updateTriggerMode(bubble.id, mode);
      if (onBubbleUpdated) {
        onBubbleUpdated({ triggerMode: mode });
      }
    } catch (err) {
      console.warn("Update trigger mode notice:", err);
    } finally {
      setIsUpdatingTrigger(false);
    }
  };

  const handleToggleExportTarget = async (target: ExportTarget) => {
    const nextState = !exportsConfig[target];
    setExportsConfig((prev) => ({ ...prev, [target]: nextState }));
    try {
      await configureExportTarget(bubble.id, {
        target,
        enabled: nextState,
        target_channel_or_db: target === "slack" ? "general" : undefined,
      });
    } catch (err) {
      console.debug("Export target update status:", err);
    }
  };

  const handleExecutePop = async () => {
    setIsPopping(true);
    setPopStatusText("Initiating Pop State Machine... Generating Executive Briefing...");

    try {
      const res = await popBubble(bubble.id, {
        dry_run: popDryRun,
        force_shred_on_export_failure: false,
        custom_briefing_prompt: customBriefingPrompt.trim() || undefined,
      });

      if (res.pop_state === "FAILED_EXPORT") {
        setPopStatusText("Export failed. Session data was preserved. Review the export configuration and retry.");
        setIsPopping(false);
        return;
      }

      if (res.pop_state === "ACTIVE") {
        setPopStatusText("Dry run completed. The bubble is still active and its session data was not shredded.");
        setIsPopping(false);
        setShowPopModal(false);
        onBubblePopped?.("ACTIVE");
        return;
      }

      setPopStatusText(`State: ${res.pop_state}. Completing exports & shredding...`);
      setTimeout(() => {
        setIsPopping(false);
        setShowPopModal(false);
        if (onBubblePopped) {
          onBubblePopped(res.pop_state);
        }
        onClose();
      }, 1000);
    } catch (err: unknown) {
      setPopStatusText(err instanceof Error ? err.message : "Pop failed");
      setIsPopping(false);
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40"
        onClick={onClose}
      />

      {/* Main Panel */}
      <div className="fixed top-14 right-4 z-50 w-[400px] max-h-[calc(100vh-5rem)] overflow-y-auto rounded-2xl bg-[#111827] border border-white/10 shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-lg">🔧</span>
            <h2 className="text-white font-semibold text-sm">Host Control Panel</h2>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-5 p-5">
          {/* AI Trigger Mode */}
          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h3 className="text-white text-xs font-semibold uppercase tracking-wider text-slate-300">
                AI Synthesis Trigger Mode
              </h3>
              {isUpdatingTrigger && (
                <span className="text-[10px] text-violet-400 animate-pulse">Saving...</span>
              )}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {(["mention", "auto", "always"] as AITriggerMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => handleTriggerModeChange(mode)}
                  className={`py-2 px-2.5 rounded-xl border text-xs font-medium capitalize transition-all ${
                    triggerMode === mode
                      ? "border-violet-500 bg-violet-900/30 text-white shadow-sm"
                      : "border-white/10 bg-[#161d2e] text-slate-400 hover:text-white hover:border-white/20"
                  }`}
                >
                  {mode === "auto" ? "Auto (3s)" : mode}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-slate-500">
              {triggerMode === "auto"
                ? "Auto-synthesizes in background after a 3s pause in discussion."
                : triggerMode === "mention"
                ? "Only activates when a participant types @AI."
                : "Runs inference immediately on every message."}
            </p>
          </section>

          {/* Participant management */}
          <section className="flex flex-col gap-2 pt-2 border-t border-white/5">
            <h3 className="text-white text-xs font-semibold uppercase tracking-wider">Participants</h3>
            {participantError && <p className="text-xs text-rose-300">{participantError}</p>}
            <div className="flex flex-col gap-1.5">
              {bubble.members.filter((member) => member.id !== bubble.hostId && member.role !== "host" && member.isOnline === true).map((member) => (
                <div key={member.id} className="flex items-center gap-2 rounded-xl border border-white/5 bg-[#161d2e] px-2.5 py-2">
                  {member.avatar_animal ? (
                    <span className="grid h-7 w-7 place-items-center rounded-full bg-slate-800 text-lg" role="img" aria-label={`${member.name}'s animal avatar`}>{member.avatar_animal}</span>
                  ) : (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={member.avatar || `https://api.dicebear.com/9.x/adventurer/svg?seed=${encodeURIComponent(member.id)}`} alt="" className="h-7 w-7 rounded-full bg-slate-800" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-xs text-slate-200">{member.name}</span>
                  {onRemoveParticipant && <button type="button" disabled={removingParticipantId === member.id} onClick={() => setParticipantToRemove({ id: member.id, name: member.name })} className="rounded-md px-2 py-1 text-[10px] font-medium text-rose-300 hover:bg-rose-950/40 disabled:opacity-50">{removingParticipantId === member.id ? "Removing…" : "Remove"}</button>}
                </div>
              ))}
              {bubble.members.filter((member) => member.id !== bubble.hostId && member.role !== "host" && member.isOnline === true).length === 0 && <p className="text-[11px] text-slate-500">No participants are currently in this Bubble.</p>}
            </div>
          </section>

          {/* Anonymous Mode Availability */}
          <section className="flex flex-col gap-2 pt-2 border-t border-white/5">
            <div className="flex items-center justify-between">
              <span className="text-white text-sm font-medium">
                Allow Anonymous Mode{" "}
                <span className={`text-xs font-normal ${bubble.anonymousModeEnabled ? "text-violet-400" : "text-slate-400"}`}>
                  ({bubble.anonymousModeEnabled ? "ON" : "OFF"})
                </span>
              </span>
              <button
                onClick={onToggleAnonymous}
                className={`relative w-11 h-6 rounded-full transition-colors ${
                  bubble.anonymousModeEnabled ? "bg-violet-600" : "bg-slate-700"
                }`}
                aria-label="Toggle anonymous mode"
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                    bubble.anonymousModeEnabled ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>
            <p className="text-slate-400 text-xs leading-relaxed">
              When ON, everyone can choose to hide their own name and avatar on individual messages.
            </p>
          </section>

          {/* Expiry Extension */}
          <section className="flex flex-col gap-2 pt-2 border-t border-white/5">
            <h3 className="text-white text-xs font-semibold uppercase tracking-wider text-slate-300">
              Auto-Destruction Timer
            </h3>
            <div className="rounded-xl border border-white/10 bg-[#161d2e] p-3 flex flex-col gap-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400">Expires in:</span>
                <span className="font-mono text-violet-300 font-semibold">{expiryLabel || "..."}</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleExtend(15)}
                  disabled={isExtending}
                  className="flex-1 py-1.5 rounded-lg border border-white/10 bg-[#1a2236] hover:bg-[#243050] text-xs font-medium text-slate-200 transition-colors"
                >
                  +15m
                </button>
                <button
                  onClick={() => handleExtend(30)}
                  disabled={isExtending}
                  className="flex-1 py-1.5 rounded-lg border border-white/10 bg-[#1a2236] hover:bg-[#243050] text-xs font-medium text-slate-200 transition-colors"
                >
                  +30m
                </button>
                <button
                  onClick={() => handleExtend(60)}
                  disabled={isExtending}
                  className="flex-1 py-1.5 rounded-lg border border-white/10 bg-[#1a2236] hover:bg-[#243050] text-xs font-medium text-slate-200 transition-colors"
                >
                  +1 hr
                </button>
              </div>
            </div>
          </section>

          {/* Export Targets Configuration */}
          <section className="flex flex-col gap-2 pt-2 border-t border-white/5">
            <h3 className="text-white text-xs font-semibold uppercase tracking-wider text-slate-300">
              Export Destinations on Pop
            </h3>
            <p className="text-[11px] text-slate-500">
              Generated executive briefing is automatically dispatched to active targets before shredding.
            </p>
            <div className="grid grid-cols-2 gap-2">
              {(["slack", "notion", "linear", "markdown"] as ExportTarget[]).map((tgt) => (
                <button
                  key={tgt}
                  type="button"
                  onClick={() => handleToggleExportTarget(tgt)}
                  className={`flex items-center justify-between px-3 py-2 rounded-xl border text-xs capitalize transition-colors ${
                    exportsConfig[tgt]
                      ? "border-emerald-500/40 bg-emerald-950/20 text-emerald-300 font-medium"
                      : "border-white/10 bg-[#161d2e] text-slate-400"
                  }`}
                >
                  <span>{tgt}</span>
                  <span>{exportsConfig[tgt] ? "✓" : "+"}</span>
                </button>
              ))}
            </div>
          </section>

          {/* Invite Code */}
          <section className="flex flex-col gap-2 pt-2 border-t border-white/5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-300 font-medium">Join ID</span>
              <span className="font-mono text-violet-300 text-xs font-semibold">{bubble.joinCode || bubble.id}</span>
            </div>
            <button
              onClick={handleCopyInviteLink}
              className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl border border-white/10 bg-[#161d2e] text-xs text-slate-200 hover:bg-[#1a2236] transition-colors"
            >
              {copied ? "✓ Copied invite URL!" : "Copy Invite Link"}
            </button>
            <p className="text-[10px] leading-relaxed text-slate-500">The Join ID changes when you remove a participant. Share the current ID with new participants.</p>
          </section>

          {/* Danger Zone: Pop Bubble */}
          <section className="flex flex-col gap-2 pt-2 border-t border-rose-500/20">
            <h3 className="text-rose-400 text-xs font-semibold uppercase tracking-wider">
              Danger Zone
            </h3>
            <button
              onClick={() => router.push(`/bubble/${bubble.id}/end?reason=host`)}
              className="w-full flex flex-col items-center justify-center gap-1 px-4 py-3 rounded-xl border border-rose-500/40 bg-rose-950/20 text-rose-300 hover:bg-rose-900/30 transition-colors"
            >
              <span className="font-semibold text-sm flex items-center gap-1.5">
                <span>💥</span> End Bubble
              </span>
              <span className="text-[11px] text-rose-400/80">
                Choose what attendees can view after the bubble ends.
              </span>
            </button>
          </section>
        </div>
      </div>

      {/* Pop Confirmation Modal */}
      {showPopModal && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-md z-50 flex items-center justify-center p-4">
          <div className="bg-[#111827] border border-rose-500/30 rounded-2xl max-w-lg w-full p-6 shadow-2xl flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-rose-500/20 border border-rose-500/40 flex items-center justify-center text-rose-400 text-xl">
                ⚠️
              </div>
              <div>
                <h3 className="text-white font-bold text-base">Pop Context Bubble</h3>
                <p className="text-slate-400 text-xs">
                  This initiates the backend Pop State Machine and cryptographic destruction.
                </p>
              </div>
            </div>

            {/* Custom Briefing Prompt */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-slate-300 font-medium">
                Custom Briefing Focus / Instructions (Optional)
              </label>
              <textarea
                rows={2}
                value={customBriefingPrompt}
                onChange={(e) => setCustomBriefingPrompt(e.target.value)}
                placeholder="e.g. Focus primarily on the pricing debate and unresolved risk factors..."
                className="rounded-xl border border-white/10 bg-[#161d2e] p-3 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-violet-500 resize-none"
              />
            </div>

            {/* Dry Run Checkbox */}
            <label className="flex items-center gap-2.5 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={popDryRun}
                onChange={(e) => setPopDryRun(e.target.checked)}
                className="rounded text-violet-600 focus:ring-0"
              />
              <span>Dry run test (generate briefing without deleting session data)</span>
            </label>

            {popStatusText && (
              <div className="rounded-xl bg-violet-950/30 border border-violet-500/30 p-3 text-xs text-violet-300 font-mono">
                {popStatusText}
              </div>
            )}

            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowPopModal(false)}
                disabled={isPopping}
                className="flex-1 py-2.5 rounded-xl border border-white/10 bg-[#161d2e] hover:bg-[#1a2236] text-slate-300 text-xs font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleExecutePop}
                disabled={isPopping}
                className="flex-1 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white text-xs font-semibold shadow-lg shadow-rose-900/40 transition-colors flex items-center justify-center gap-1.5"
              >
                {isPopping ? (
                  <>
                    <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                    <span>Popping...</span>
                  </>
                ) : (
                  <span>Confirm &amp; Pop Bubble</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {participantToRemove && <ConfirmDialog
        title={`Remove ${participantToRemove.name} from this bubble?`}
        description="They will be removed immediately, won’t be able to rejoin with the old link, and the bubble’s join ID will change."
        confirmLabel="Remove participant"
        busy={removingParticipantId === participantToRemove.id}
        error={participantError}
        onCancel={() => { setParticipantToRemove(null); setParticipantError(null); }}
        onConfirm={() => removeParticipant(participantToRemove.id)}
      />}
    </>
  );
}
