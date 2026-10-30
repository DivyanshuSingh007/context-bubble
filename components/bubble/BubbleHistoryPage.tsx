"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { deleteAllBubbleHistory, deleteBubbleHistoryEntry, getBriefing, getBubbleHistory, type BubbleHistoryEntry } from "@/lib/api";
import { useFirebaseAuth } from "@/lib/auth";
import { AmbientBubbles } from "@/components/layout/AmbientBubbles";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DecisionRecordDownloads } from "@/components/bubble/DecisionRecordDownloads";
import type { ExecutiveBriefing } from "@/types";

export function BubbleHistoryPage() {
  const { user, loading: authLoading } = useFirebaseAuth();
  const [entries, setEntries] = useState<BubbleHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [briefing, setBriefing] = useState<{ bubbleId: string; record: ExecutiveBriefing } | null>(null);
  const [openingRecordId, setOpeningRecordId] = useState<string | null>(null);
  const [deletingBubbleId, setDeletingBubbleId] = useState<string | null>(null);
  const [deletingAll, setDeletingAll] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ kind: "one"; id: string; title: string } | { kind: "all" } | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!user) { setLoading(false); return; }
    let active = true;
    getBubbleHistory()
      .then((rows) => { if (active) setEntries(rows); })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : "Could not load history."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [authLoading, user?.uid]);

  const openBriefing = async (bubbleId: string) => {
    setError("");
    setOpeningRecordId(bubbleId);
    try {
      const record = await getBriefing(bubbleId);
      if (record) setBriefing({ bubbleId, record });
      else setError("This decision record is no longer available.");
    } finally {
      setOpeningRecordId(null);
    }
  };

  const removeBubble = async (bubbleId: string, title: string) => {
    setError("");
    setDeletingBubbleId(bubbleId);
    try {
      await deleteBubbleHistoryEntry(bubbleId);
      setEntries((current) => current.filter((entry) => entry.bubble_id !== bubbleId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove this bubble.");
    } finally {
      setDeletingBubbleId(null);
    }
  };

  const removeAllBubbles = async () => {
    setError("");
    setDeletingAll(true);
    try {
      await deleteAllBubbleHistory();
      setEntries([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not clear My Bubbles.");
    } finally {
      setDeletingAll(false);
    }
  };

  return (
    <main className="relative isolate min-h-screen overflow-hidden bg-[#0d0f1a] px-4 py-8 text-slate-100 sm:px-8">
      <AmbientBubbles />
      <div className="relative z-10 mx-auto max-w-5xl">
        <header className="mb-8 flex items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-300">Your workspace</p>
            <h1 className="mt-1 text-3xl font-bold">My Bubbles</h1>
            <p className="mt-2 text-sm text-slate-400">Bubbles you attended, their retained conversations, and shared decision records.</p>
          </div>
          <div className="flex shrink-0 gap-2">
            {user && entries.length > 0 && <button type="button" disabled={deletingAll} onClick={() => setPendingDelete({ kind: "all" })} className="cursor-pointer rounded-xl border border-rose-500/30 px-4 py-2 text-sm text-rose-200 hover:bg-rose-950/40 disabled:opacity-50">{deletingAll ? "Deleting…" : "Delete all"}</button>}
            <Link href="/" className="cursor-pointer rounded-xl border border-white/10 px-4 py-2 text-sm text-slate-300 hover:bg-white/5">Home</Link>
          </div>
        </header>

        {loading || authLoading ? <p className="text-sm text-slate-400">Loading your history…</p> : !user ? <p className="rounded-2xl border border-white/10 bg-[#111827] p-5 text-sm text-slate-300">Sign in with the account you used to attend bubbles to see your history.</p> : null}
        {error && <p className="mb-4 rounded-xl border border-rose-500/30 bg-rose-950/30 p-3 text-sm text-rose-200">{error}</p>}

        {!loading && user && entries.length === 0 && <div className="rounded-2xl border border-white/10 bg-[#111827] p-8 text-center text-slate-400">No bubbles in your list yet.</div>}

        <div className="grid gap-4">
          {entries.map((entry) => (
            <article key={entry.bubble_id} className="rounded-2xl border border-white/10 bg-[#111827] p-5 sm:flex sm:items-center sm:justify-between sm:gap-5">
              <div className="min-w-0">
                <h2 className="truncate text-lg font-semibold text-white">{entry.title || "Ended bubble"}</h2>
                <p className="mt-1 text-xs text-slate-500">Ended {new Date(entry.popped_at).toLocaleString()}</p>
                <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                  <span className="rounded-full border border-white/10 bg-[#161d2e] px-2.5 py-1 text-slate-300">{entry.retention_policy === "view-only" ? `Read-only${entry.view_until ? ` until ${new Date(entry.view_until).toLocaleDateString()}` : ""}` : "Ephemeral"}</span>
                  {entry.decision_record_shared && <span className="rounded-full border border-emerald-500/20 bg-emerald-950/30 px-2.5 py-1 text-emerald-200">Decision record shared</span>}
                </div>
              </div>
              <div className="mt-4 flex shrink-0 flex-wrap gap-2 sm:mt-0">
                {entry.is_viewable && <Link href={`/bubble/${entry.bubble_id}?mode=view`} className="cursor-pointer rounded-xl bg-violet-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-violet-500">View bubble</Link>}
                {entry.decision_record_shared && <button type="button" disabled={openingRecordId === entry.bubble_id} onClick={() => void openBriefing(entry.bubble_id)} className="cursor-pointer rounded-xl border border-white/10 px-3.5 py-2 text-xs font-semibold text-slate-200 hover:bg-white/5 disabled:opacity-50">{openingRecordId === entry.bubble_id ? "Opening…" : "View decision record"}</button>}
                <button type="button" disabled={deletingAll || deletingBubbleId === entry.bubble_id} onClick={() => setPendingDelete({ kind: "one", id: entry.bubble_id, title: entry.title || "Ended bubble" })} className="cursor-pointer rounded-xl border border-rose-500/30 px-3.5 py-2 text-xs font-semibold text-rose-200 hover:bg-rose-950/40 disabled:opacity-50">{deletingBubbleId === entry.bubble_id ? "Deleting…" : "Delete"}</button>
                {!entry.is_viewable && !entry.decision_record_shared && <span className="self-center text-xs text-slate-500">Session content was removed</span>}
              </div>
            </article>
          ))}
        </div>
      </div>

      {briefing && <DecisionRecordModal bubbleId={briefing.bubbleId} briefing={briefing.record} onClose={() => setBriefing(null)} />}

      {pendingDelete && <ConfirmDialog
        title={pendingDelete.kind === "all" ? "Remove all bubbles from My Bubbles?" : `Remove “${pendingDelete.title}”?`}
        description={pendingDelete.kind === "all"
          ? "This clears every bubble from your personal list. It does not delete the bubbles or shared decision records."
          : "This removes the bubble from your personal list. It does not delete the bubble or shared decision record."}
        confirmLabel={pendingDelete.kind === "all" ? "Remove all" : "Remove bubble"}
        busy={deletingAll || Boolean(deletingBubbleId)}
        onCancel={() => setPendingDelete(null)}
        onConfirm={async () => {
          const selected = pendingDelete;
          if (!selected) return;
          setPendingDelete(null);
          if (selected.kind === "all") await removeAllBubbles();
          else await removeBubble(selected.id, selected.title);
        }}
      />}
    </main>
  );
}

function DecisionRecordModal({ bubbleId, briefing, onClose }: { bubbleId: string; briefing: ExecutiveBriefing; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-4" onClick={onClose}>
      <section role="dialog" aria-modal="true" aria-labelledby="decision-record-title" className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-violet-500/20 bg-[#111827] p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wider text-violet-300">Shared Decision Record</p>
            <h2 id="decision-record-title" className="mt-1 text-xl font-bold">{briefing.bubble_title}</h2>
            {briefing.generated_at && (
              <p className="text-xs text-slate-400 mt-0.5">Generated: {new Date(briefing.generated_at).toLocaleString()}</p>
            )}
          </div>
          <button type="button" onClick={onClose} className="cursor-pointer shrink-0 text-slate-400 hover:text-white">Close</button>
        </div>
        <div className="flex justify-end border-b border-white/10 pb-4">
          <DecisionRecordDownloads bubbleId={bubbleId} briefing={briefing} />
        </div>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-200">{briefing.executive_summary}</p>
        {briefing.decisions?.length > 0 && <div><h3 className="text-xs font-semibold uppercase tracking-wider text-emerald-300">Decisions</h3><ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-300">{briefing.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul></div>}
        {briefing.consensus_points?.length > 0 && <div><h3 className="text-xs font-semibold uppercase tracking-wider text-cyan-300">Points of Consensus</h3><ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-300">{briefing.consensus_points.map((c, i) => <li key={i}>{c}</li>)}</ul></div>}
        {briefing.disagreements?.length > 0 && <div><h3 className="text-xs font-semibold uppercase tracking-wider text-amber-300">Open Disagreements</h3><div className="mt-2 space-y-2">{briefing.disagreements.map((dg, i) => <div key={i} className="rounded-lg bg-amber-950/20 border border-amber-500/20 p-2.5 text-xs text-slate-300"><span className="font-semibold text-amber-300">{dg.topic}: </span>{dg.perspective_a} <em>vs</em> {dg.perspective_b}</div>)}</div></div>}
        {briefing.blockers?.length > 0 && <div><h3 className="text-xs font-semibold uppercase tracking-wider text-rose-300">Identified Blockers</h3><ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-300">{briefing.blockers.map((b, i) => <li key={i}>⚠️ {b}</li>)}</ul></div>}
        {briefing.action_items?.length > 0 && <div><h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">Action items</h3><ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-300">{briefing.action_items.map((a, i) => <li key={i}>[{a.priority?.toUpperCase() || "MED"}] {a.task}{a.owner ? ` — ${a.owner}` : ""}</li>)}</ul></div>}
        {briefing.graph_summary && (briefing.graph_summary.total_nodes > 0 || briefing.graph_summary.key_relationships?.length > 0) && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-indigo-300">Knowledge Graph Synthesis</h3>
            <p className="mt-1 text-xs text-slate-400">{briefing.graph_summary.total_nodes} entities · {briefing.graph_summary.total_edges} connections</p>
            {briefing.graph_summary.key_relationships?.length > 0 && (
              <ul className="mt-2 space-y-1 pl-1 text-xs text-slate-300">
                {briefing.graph_summary.key_relationships.map((rel, i) => (
                  <li key={i} className="rounded bg-indigo-950/30 px-2 py-1 border border-indigo-500/20">☍ {rel}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
