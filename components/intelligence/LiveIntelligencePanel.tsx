"use client";

import React, { useMemo, useState } from "react";
import type { Contribution, Intelligence, KnowledgeGraph, Insight, NodeType, ReactFlowNode } from "@/types";
import { KnowledgeGraphVisualizer } from "./KnowledgeGraphVisualizer";

function keepOverviewSentences(value: string, maxSentences = 3): string {
  const sentenceEnds: number[] = [];
  for (const match of value.matchAll(/[.!?](?=\s+[A-Z0-9])/g)) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    const preceding = value.slice(Math.max(0, index - 4), index + 1);
    if (/\b(?:Mr|Mrs|Ms|Dr)\.$/i.test(preceding)) continue;
    sentenceEnds.push(index);
  }
  if (sentenceEnds.length >= maxSentences) {
    return value.slice(0, sentenceEnds[maxSentences - 1] + 1).trim();
  }
  return value.trim();
}

function cleanLiveSummary(value: string): string {
  const text = value.trim();
  const words = [...text.matchAll(/[\p{L}\p{N}]+/gu)];
  if (text.length <= 500 || words.length < 40) return keepOverviewSentences(text);

  let repeatedStart = Number.POSITIVE_INFINITY;
  for (let size = 10; size >= 5; size -= 1) {
    const occurrences = new Map<string, number[]>();
    for (let index = 0; index <= words.length - size; index += 1) {
      const phrase = words.slice(index, index + size).map((word) => word[0].toLowerCase()).join(" ");
      const positions = occurrences.get(phrase) || [];
      positions.push(index);
      occurrences.set(phrase, positions);
    }
    for (const positions of occurrences.values()) {
      if (positions.length >= 3) repeatedStart = Math.min(repeatedStart, positions[1]);
    }
  }

  const maxLength = 800;
  const maxWordIndex = words.findIndex((word) => (word.index ?? 0) >= maxLength);
  const cutWordIndex = Math.min(repeatedStart, maxWordIndex < 0 ? words.length : maxWordIndex);
  if (!Number.isFinite(cutWordIndex) || cutWordIndex >= words.length) return keepOverviewSentences(text);

  const cutAt = words[cutWordIndex]?.index ?? maxLength;
  const prefix = text.slice(0, cutAt).trim();
  const sentenceEnd = Math.max(prefix.lastIndexOf("."), prefix.lastIndexOf("!"), prefix.lastIndexOf("?"));
  if (sentenceEnd >= Math.min(120, prefix.length * 0.55)) return keepOverviewSentences(prefix.slice(0, sentenceEnd + 1).trim());
  return keepOverviewSentences(`${prefix.replace(/[\s,;:]+$/, "")}…`);
}

// The backend may send snake_case keys alongside the client's camelCase shape.
type IntelligenceWire = Intelligence & {
  missing_pieces?: Intelligence["missingPieces"];
  next_steps?: string[];
};

interface Props {
  intelligence: Intelligence;
  knowledgeGraph?: KnowledgeGraph | null;
  contributions?: Contribution[];
  bubbleTitle?: string;
  streamingToken?: string;
  isSynthesizing?: boolean;
  onRefreshGraph?: () => void;
}

export function LiveIntelligencePanel({
  intelligence,
  knowledgeGraph,
  contributions = [],
  bubbleTitle = "Discussion",
  streamingToken,
  isSynthesizing = false,
  onRefreshGraph,
}: Props) {
  const [activeTab, setActiveTab] = useState<"synthesis" | "graph">("synthesis");
  const [showFullSummary, setShowFullSummary] = useState(false);
  const [viewingEvidence, setViewingEvidence] = useState<{
    label: string;
    sideA: { count: number; label: string };
    sideB: { count: number; label: string };
  } | null>(null);

  const validHumanContributions = useMemo(() => {
    return (contributions || []).filter(
      (c) => c && typeof c.text === "string" && c.text.trim().length > 0 && c.authorId !== "bubble-ai" && c.authorName !== "Bubble AI"
    );
  }, [contributions]);

  const isStaleDemo = useMemo(() => {
    const sum = (intelligence.summary || "").toLowerCase();
    const hasDemoSummary = sum.includes("retention is a major concern") || sum.includes("team aligned on key product priorities");
    const hasDemoDisagreement = (intelligence.disagreements || []).some(
      (d) => d.sideA?.label?.toLowerCase().includes("retention") && d.sideB?.label?.toLowerCase().includes("pricing")
    );
    const hasDemoMissingPiece = (intelligence.missingPieces || (intelligence as IntelligenceWire).missing_pieces || []).some(
      (mp) => mp.description?.toLowerCase().includes("churn")
    );

    if (hasDemoSummary || hasDemoDisagreement || hasDemoMissingPiece) {
      const contribsText = validHumanContributions.map((c) => c.text.toLowerCase()).join(" ");
      const isPurelyOriginalScript = contribsText.includes("churn") && contribsText.includes("retention dropped 18%") && validHumanContributions.length === 5;
      return !isPurelyOriginalScript;
    }
    return false;
  }, [intelligence, validHumanContributions]);

  const derivedIntelligence = useMemo(() => {
    if (validHumanContributions.length === 0) {
      return {
        summary: "",
        disagreements: [],
        missingPieces: [],
        nextSteps: [],
        raw_insights: [],
      };
    }

    const authors = Array.from(new Set(validHumanContributions.map((c) => c.authorName || "User")));
    const recentMsgs = validHumanContributions.slice(-10);
    const latestMsg = recentMsgs[recentMsgs.length - 1];
    const firstMsg = recentMsgs[0];

    const cleanSnippet = (text: string, maxLen = 80) => {
      const trimmed = text.replace(/[\n\r]+/g, " ").trim();
      if (trimmed.length <= maxLen) return trimmed.replace(/[.?!]+$/, "");
      const cut = trimmed.slice(0, maxLen);
      const lastSpace = cut.lastIndexOf(" ");
      return (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim().replace(/[.?!]+$/, "");
    };

    let derivedSummary = "";
    if (validHumanContributions.length === 1) {
      derivedSummary = `${firstMsg.authorName} opened deliberation: "${firstMsg.text.trim()}". Awaiting team perspectives to map alignment and trade-offs.`;
    } else if (validHumanContributions.length === 2) {
      derivedSummary = `Deliberation is underway between ${authors.join(" and ")}. ${firstMsg.authorName} noted that ${cleanSnippet(firstMsg.text, 90).toLowerCase()}, while ${latestMsg.authorName} emphasized ${cleanSnippet(latestMsg.text, 90).toLowerCase()}. The team is establishing initial points of alignment.`;
    } else {
      const authorSummary = authors.slice(0, 3).join(", ") + (authors.length > 3 ? ` and ${authors.length - 3} others` : "");
      const mainTopic = cleanSnippet(firstMsg.text, 90).toLowerCase();
      const contrastKeywords = ["but", "however", "instead", "disagree", "versus", "vs", "prefer", "rather", "pricing", "timing", "risk", "delay"];
      const contrastingMsg = recentMsgs.find((m) => m !== firstMsg && contrastKeywords.some((k) => m.text.toLowerCase().includes(k))) || latestMsg;
      const contrastSnippet = cleanSnippet(contrastingMsg.text, 80).toLowerCase();
      derivedSummary = `Active deliberation with ${authorSummary} centers on ${mainTopic}. Discussion highlights key trade-offs, particularly regarding ${contrastSnippet}. The group is weighing practical next steps to reach consensus.`;
    }

    const derivedDisagreements: Array<{ id: string; sideA: { count: number; label: string }; sideB: { count: number; label: string } }> = [];
    if (validHumanContributions.length >= 2) {
      const side1Text = cleanSnippet(firstMsg.text, 45);
      let side2Text = cleanSnippet(latestMsg.text, 45);
      if (side1Text.toLowerCase() === side2Text.toLowerCase() && recentMsgs.length > 2) {
        side2Text = cleanSnippet(recentMsgs[1].text, 45);
      }
      const half = Math.max(1, Math.floor(validHumanContributions.length / 2));
      derivedDisagreements.push({
        id: "live-d1",
        sideA: { count: half, label: side1Text || "initial proposal" },
        sideB: { count: Math.max(1, validHumanContributions.length - half), label: side2Text || "alternative viewpoint" },
      });

      if (validHumanContributions.length >= 4) {
        const otherMsgs = recentMsgs.filter((m) => m !== firstMsg && m !== latestMsg);
        if (otherMsgs.length >= 2) {
          derivedDisagreements.push({
            id: "live-d2",
            sideA: { count: 1, label: cleanSnippet(otherMsgs[0].text, 40) },
            sideB: { count: 1, label: cleanSnippet(otherMsgs[1].text, 40) },
          });
        }
      }
    }

    const questions = recentMsgs.filter((m) => m.text.includes("?"));
    const derivedMissingPieces: Array<{ id: string; description: string; action: string; actionLabel: string }> = [];
    if (questions.length > 0) {
      questions.slice(0, 2).forEach((q, idx) => {
        const qText = q.text.replace(/[\n\r]+/g, " ").trim();
        const firstQ = qText.split("?")[0] + "?";
        derivedMissingPieces.push({
          id: `live-mp-${idx}`,
          description: cleanSnippet(firstQ, 90),
          action: "request",
          actionLabel: "Request info",
        });
      });
    } else {
      derivedMissingPieces.push({
        id: "live-mp-0",
        description: `Verification data for: ${cleanSnippet(latestMsg.text, 70)}`,
        action: "request",
        actionLabel: "Request data",
      });
    }

    const actionCues = ["let's", "lets", "will", "need to", "should", "plan to", "todo", "action", "review", "schedule", "verify", "test", "build"];
    const actionMsgs = recentMsgs.filter((m) => actionCues.some((c) => m.text.toLowerCase().includes(c)));
    const derivedNextSteps: string[] = [];
    if (actionMsgs.length > 0) {
      actionMsgs.slice(0, 3).forEach((m) => {
        derivedNextSteps.push(cleanSnippet(m.text, 80));
      });
    } else {
      derivedNextSteps.push(`Finalize decision on ${cleanSnippet(firstMsg.text, 50).toLowerCase()}`);
      if (validHumanContributions.length > 1) {
        derivedNextSteps.push(`Address points raised by ${latestMsg.authorName}`);
      }
    }

    return {
      summary: derivedSummary,
      disagreements: derivedDisagreements,
      missingPieces: derivedMissingPieces,
      nextSteps: derivedNextSteps,
      raw_insights: [],
    };
  }, [validHumanContributions]);

  const rawInsights = intelligence.raw_insights || [];
  const effectiveSummary = useMemo(() => {
    if (validHumanContributions.length === 0) return "";
    if (isStaleDemo || !intelligence.summary || !intelligence.summary.trim()) {
      return derivedIntelligence.summary;
    }
    return intelligence.summary;
  }, [validHumanContributions.length, isStaleDemo, intelligence.summary, derivedIntelligence.summary]);

  const summaryText = cleanLiveSummary(effectiveSummary);

  const disagreementsList = useMemo(() => {
    if (validHumanContributions.length === 0) return [];
    if (isStaleDemo || !intelligence.disagreements || intelligence.disagreements.length === 0) {
      return derivedIntelligence.disagreements;
    }
    return intelligence.disagreements;
  }, [validHumanContributions.length, isStaleDemo, intelligence.disagreements, derivedIntelligence.disagreements]);

  const missingPiecesList = useMemo(() => {
    if (validHumanContributions.length === 0) return [];
    const existing = intelligence.missingPieces || (intelligence as IntelligenceWire).missing_pieces;
    if (isStaleDemo || !existing || existing.length === 0) {
      return derivedIntelligence.missingPieces;
    }
    return existing;
  }, [validHumanContributions.length, isStaleDemo, intelligence, derivedIntelligence.missingPieces]);

  const nextSteps = useMemo(() => {
    if (validHumanContributions.length === 0) return [];
    const existing = (intelligence.nextSteps || (intelligence as IntelligenceWire).next_steps || []).filter(
      (s) => typeof s === "string" && s.trim()
    );
    if (isStaleDemo || !existing || existing.length === 0) {
      return derivedIntelligence.nextSteps;
    }
    return existing;
  }, [validHumanContributions.length, isStaleDemo, intelligence, derivedIntelligence.nextSteps]);

  const displayGraph = useMemo(() => {
    // If backend provided a knowledgeGraph without old claim nodes, prefer it
    if (knowledgeGraph && knowledgeGraph.nodes.length > 0) {
      const hasOldClaims = knowledgeGraph.nodes.some((node) => node.data.node_type === "claim");
      if (!hasOldClaims) {
        return knowledgeGraph;
      }
    }

    const topicId = "local-topic";
    const topicLabel = intelligence.summary?.trim() || bubbleTitle;

    // Categorize semantic items
    const debates: Array<{ id: string; label: string; conf: number; contribIds: string[] }> = [];
    const consensusDecisions: Array<{ id: string; label: string; type: NodeType; conf: number; contribIds: string[] }> = [];
    const blockers: Array<{ id: string; label: string; conf: number; contribIds: string[] }> = [];
    const actionItems: Array<{ id: string; label: string; conf: number; contribIds: string[] }> = [];

    // 1. From raw_insights
    for (const [idx, ins] of rawInsights.entries()) {
      if (!ins.text?.trim()) continue;
      const text = ins.text.trim();
      const id = ins.insight_id || `ins-${idx}`;
      if (ins.type === "debate") {
        debates.push({ id, label: text, conf: ins.confidence, contribIds: ins.supporting_contribution_ids || [] });
      } else if (ins.type === "blocker") {
        blockers.push({ id, label: text, conf: ins.confidence, contribIds: ins.supporting_contribution_ids || [] });
      } else if (ins.type === "action_item") {
        actionItems.push({ id, label: text, conf: ins.confidence, contribIds: ins.supporting_contribution_ids || [] });
      } else if (ins.type === "consensus" || ins.type === "decision") {
        consensusDecisions.push({ id, label: text, type: ins.type, conf: ins.confidence, contribIds: ins.supporting_contribution_ids || [] });
      }
    }

    // 2. From disagreements
    const seenDebates = new Set(debates.map((d) => d.label.toLowerCase()));
    for (const [idx, d] of disagreementsList.entries()) {
      const label = [d.sideA?.label, d.sideB?.label].filter(Boolean).join(" vs ");
      if (label && !seenDebates.has(label.toLowerCase())) {
        seenDebates.add(label.toLowerCase());
        debates.push({ id: d.id || `dispute-${idx}`, label, conf: 0.85, contribIds: [] });
      }
    }

    // 3. From missing pieces
    const seenBlockers = new Set(blockers.map((b) => b.label.toLowerCase()));
    for (const [idx, mp] of missingPiecesList.entries()) {
      const desc = mp.description?.trim();
      if (desc && !seenBlockers.has(desc.toLowerCase())) {
        seenBlockers.add(desc.toLowerCase());
        blockers.push({ id: mp.id || `mp-${idx}`, label: desc, conf: 0.8, contribIds: [] });
      }
    }

    // 4. From next steps
    const seenActions = new Set(actionItems.map((a) => a.label.toLowerCase()));
    for (const [idx, step] of nextSteps.entries()) {
      const text = step.trim();
      if (text && !seenActions.has(text.toLowerCase())) {
        seenActions.add(text.toLowerCase());
        actionItems.push({ id: `step-${idx}`, label: text, conf: 0.85, contribIds: [] });
      }
    }

    const hasAnySemanticItems = debates.length > 0 || consensusDecisions.length > 0 || blockers.length > 0 || actionItems.length > 0;
    if (!hasAnySemanticItems) {
      return { bubble_id: knowledgeGraph?.bubble_id || "local", nodes: [], edges: [], version: knowledgeGraph?.version || 0 };
    }

    const topicNode: ReactFlowNode = {
      id: topicId,
      type: "topicNode",
      data: { label: topicLabel, node_type: "topic", status: "consensus", stance: { agree_count: 1, disagree_count: 0, neutral_count: 0 }, supporting_contribution_ids: [], confidence: 1 },
      position: { x: 360, y: 40 },
    };

    const nodes: ReactFlowNode[] = [topicNode];
    const edges: Array<{ id: string; source: string; target: string; type: "supports" | "disputes" | "depends_on" | "resolves" }> = [];

    const debateIds: string[] = [];
    const blockerIds: string[] = [];

    // Add Debates
    debates.slice(0, 4).forEach((item, i) => {
      debateIds.push(item.id);
      nodes.push({
        id: item.id,
        type: "customBubbleNode",
        data: {
          label: item.label,
          node_type: "debate",
          status: "contested",
          stance: { agree_count: 1, disagree_count: 2, neutral_count: 0 },
          supporting_contribution_ids: item.contribIds,
          confidence: item.conf,
        },
        position: { x: 60, y: 180 + i * 150 },
      });
      edges.push({
        id: `edge-${topicId}-${item.id}`,
        source: topicId,
        target: item.id,
        type: "disputes",
      });
    });

    // Add Consensus & Decisions
    consensusDecisions.slice(0, 4).forEach((item, i) => {
      nodes.push({
        id: item.id,
        type: "customBubbleNode",
        data: {
          label: item.label,
          node_type: item.type,
          status: "consensus",
          stance: { agree_count: Math.max(2, item.contribIds.length), disagree_count: 0, neutral_count: 0 },
          supporting_contribution_ids: item.contribIds,
          confidence: item.conf,
        },
        position: { x: 640, y: 180 + i * 150 },
      });
      edges.push({
        id: `edge-${topicId}-${item.id}`,
        source: topicId,
        target: item.id,
        type: "supports",
      });
    });

    // Add Blockers
    const blockerBaseY = 180 + Math.max(debateIds.length, 1) * 150;
    blockers.slice(0, 3).forEach((item, i) => {
      blockerIds.push(item.id);
      nodes.push({
        id: item.id,
        type: "customBubbleNode",
        data: {
          label: item.label,
          node_type: "blocker",
          status: "unresolved",
          stance: { agree_count: 1, disagree_count: 1, neutral_count: 0 },
          supporting_contribution_ids: item.contribIds,
          confidence: item.conf,
        },
        position: { x: 80, y: blockerBaseY + i * 140 },
      });
      const srcId = debateIds.length ? debateIds[i % debateIds.length] : topicId;
      edges.push({
        id: `edge-${srcId}-${item.id}`,
        source: srcId,
        target: item.id,
        type: "depends_on",
      });
    });

    // Add Action Items
    const actionBaseY = Math.max(
      blockerBaseY + blockerIds.length * 140,
      180 + Math.max(consensusDecisions.length, 1) * 150
    );
    actionItems.slice(0, 3).forEach((item, i) => {
      nodes.push({
        id: item.id,
        type: "customBubbleNode",
        data: {
          label: item.label,
          node_type: "action_item",
          status: "consensus",
          stance: { agree_count: 2, disagree_count: 0, neutral_count: 0 },
          supporting_contribution_ids: item.contribIds,
          confidence: item.conf,
        },
        position: { x: 360 + (i % 2) * 220, y: actionBaseY + Math.floor(i / 2) * 140 },
      });

      if (blockerIds.length > 0) {
        const targetBlocker = blockerIds[i % blockerIds.length];
        edges.push({
          id: `edge-${item.id}-${targetBlocker}`,
          source: item.id,
          target: targetBlocker,
          type: "resolves",
        });
      } else if (debateIds.length > 0) {
        const targetDebate = debateIds[i % debateIds.length];
        edges.push({
          id: `edge-${item.id}-${targetDebate}`,
          source: item.id,
          target: targetDebate,
          type: "resolves",
        });
      } else {
        edges.push({
          id: `edge-${topicId}-${item.id}`,
          source: topicId,
          target: item.id,
          type: "supports",
        });
      }
    });

    return { bubble_id: knowledgeGraph?.bubble_id || "local", nodes, edges, version: knowledgeGraph?.version || 0 };
  }, [bubbleTitle, disagreementsList, intelligence.summary, knowledgeGraph, missingPiecesList, nextSteps, rawInsights]);
  const hasContent = Boolean(
    summaryText || disagreementsList.length || missingPiecesList.length || intelligence.nextSteps?.length || rawInsights.length
  );

  const [requestedToast, setRequestedToast] = useState<string | null>(null);

  const handleRequestData = (description: string) => {
    setRequestedToast(`Request sent for: ${description}`);
    setTimeout(() => setRequestedToast(null), 3500);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[#0a0c16]">

      {/* ── Panel Header ──────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-white/[0.06] shrink-0">
        <div className="flex items-center gap-2.5">
          {/* Circled question-mark icon matching screenshot */}
          <div className="w-5 h-5 rounded-full bg-violet-600/30 border border-violet-400/40 flex items-center justify-center shrink-0">
            <span className="text-violet-300 text-xs font-bold leading-none">?</span>
          </div>
          <h2 className="text-white font-bold text-sm tracking-wide">Live Intelligence</h2>
        </div>

        {/* Tab switcher */}
        <div className="flex items-center gap-1 text-xs">
          <button
            onClick={() => setActiveTab("synthesis")}
            className={`px-3 py-1 rounded-md font-medium transition-colors ${
              activeTab === "synthesis"
                ? "bg-[#1e2536] text-white"
                : "text-slate-500 hover:text-slate-300"
            }`}
          >
            Insights
          </button>
          <button
            onClick={() => setActiveTab("graph")}
            className={`px-3 py-1 rounded-md font-medium transition-colors flex items-center gap-1.5 ${
              activeTab === "graph"
                ? "bg-[#1e2536] text-white"
                : "text-slate-500 hover:text-slate-300"
            }`}
          >
            Graph
            {knowledgeGraph && knowledgeGraph.nodes.length > 0 && (
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            )}
          </button>
        </div>
      </div>

      {/* Toast notification */}
      {requestedToast && (
        <div className="mx-4 mt-2 px-3 py-1.5 rounded-lg bg-emerald-950/60 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2">
          <span>✓</span>
          <span>{requestedToast}</span>
        </div>
      )}

      {/* ── Synthesizing indicator ────────────────────────────── */}
      {(isSynthesizing || streamingToken) && (
        <div className="mx-4 mt-3 px-3 py-1.5 rounded-lg bg-violet-950/30 border border-violet-500/20 flex items-center gap-2 shrink-0">
          <svg className="w-3 h-3 text-violet-400 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          <span className="text-[11px] text-violet-300">Synthesizing live deliberation…</span>
        </div>
      )}

      {/* ── Tab: Synthesis ───────────────────────────────────── */}
      {activeTab === "synthesis" ? (
        <div className="flex-1 overflow-y-auto min-h-0 px-4 pb-4 flex flex-col gap-5 pt-3">

          {/* ── ⚡ Live Summary ──────────────────────────────── */}
          <section>
            <div className="flex items-center gap-2 mb-2">
              <svg className="w-4 h-4 text-violet-400" fill="currentColor" viewBox="0 0 24 24">
                <path d="M13 2L3 14h8v8l10-12h-8z" />
              </svg>
              <h3 className="text-white font-bold text-xs tracking-wide">Live Summary</h3>
            </div>

            {/* Summary card — matching screenshot */}
            <div className="rounded-2xl bg-[#141226] border border-violet-500/20 px-4 py-3.5 relative shadow-sm">
              <div className="absolute top-3 right-3 flex items-center gap-1.5 text-[10px] text-slate-400">
                <svg className="w-3 h-3 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                <span>Auto-updating</span>
              </div>
              <p
                className="text-slate-200 text-xs sm:text-[13px] leading-relaxed pr-24 break-words"
                style={showFullSummary ? undefined : {
                  display: "-webkit-box",
                  WebkitBoxOrient: "vertical",
                  WebkitLineClamp: 5,
                  overflow: "hidden",
                }}
              >
                {summaryText || "Waiting for contributions before generating a live summary."}
              </p>
              {summaryText.length > 320 && (
                <button
                  type="button"
                  aria-expanded={showFullSummary}
                  onClick={() => setShowFullSummary((expanded) => !expanded)}
                  className="mt-2 text-[11px] font-semibold text-violet-300 hover:text-violet-200"
                >
                  {showFullSummary ? "Show less" : "Show more"}
                </button>
              )}
            </div>
          </section>

          {/* ── ⚠️ Disagreements & Tensions ─────────────────── */}
          <section>
            <div className="flex items-center gap-2 mb-2">
              <svg className="w-4 h-4 text-amber-400" fill="currentColor" viewBox="0 0 24 24">
                <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
              </svg>
              <h3 className="text-white font-bold text-xs tracking-wide">Disagreements &amp; Tensions</h3>
            </div>

            <div className="flex flex-col gap-2.5">
              {disagreementsList.length === 0 ? (
                <p className="text-slate-500 text-xs">No active disagreements detected yet.</p>
              ) : disagreementsList.map((d) => (
                <div
                  key={d.id}
                  className="rounded-2xl bg-[#171328] border border-violet-500/20 px-4 py-3 flex items-center justify-between gap-3 shadow-sm"
                >
                  <p className="text-slate-300 text-xs sm:text-[13px] leading-relaxed min-w-0">
                    <span className="text-[#a78bfa] font-bold">{d.sideA.count} members</span>
                    {" point to "}
                    <span className="text-white">{d.sideA.label}</span>
                    {" vs "}
                    <span className="text-[#f87171] font-bold">{d.sideB.count} members</span>
                    {" suspect "}
                    <span className="text-slate-300">{d.sideB.label}</span>
                  </p>
                  <button
                    onClick={() => setViewingEvidence({ label: `${d.sideA.label} vs ${d.sideB.label}`, sideA: d.sideA, sideB: d.sideB })}
                    className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#211b3b] border border-white/10 hover:border-violet-500/40 text-slate-300 hover:text-white text-xs font-medium transition-colors"
                  >
                    <svg className="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                    View evidence
                  </button>
                </div>
              ))}
            </div>
          </section>

          {/* ── 🔍 Missing Pieces ───────────────────────────── */}
          <section>
            <div className="flex items-center gap-2 mb-2">
              <svg className="w-4 h-4 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <h3 className="text-white font-bold text-xs tracking-wide">Missing Pieces</h3>
            </div>

            <div className="flex flex-col gap-2.5">
              {missingPiecesList.length === 0 ? (
                <p className="text-slate-500 text-xs">No missing information has been identified yet.</p>
              ) : missingPiecesList.map((mp) => (
                <div
                  key={mp.id}
                  className="rounded-2xl bg-[#14152a] border border-violet-500/20 px-4 py-3 flex items-center justify-between gap-3 shadow-sm"
                >
                  <p className="text-slate-300 text-xs sm:text-[13px] leading-relaxed min-w-0">{mp.description}</p>
                  <button
                    onClick={() => handleRequestData(mp.description)}
                    className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#211b3b] border border-white/10 hover:border-cyan-500/40 text-slate-300 hover:text-white text-xs font-medium transition-colors"
                  >
                    <svg className="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                    </svg>
                    {mp.actionLabel || "Request data"}
                  </button>
                </div>
              ))}
            </div>
          </section>

          {/* ── 🚀 Next Steps ───────────────────────────────── */}
          <section className="pt-5">
              <div className="flex items-center gap-1.5 mb-2.5">
                <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                </svg>
                <span className="text-[11px] font-bold text-slate-200 tracking-wide uppercase">Next Steps</span>
              </div>
              {nextSteps.length > 0 ? <div className="flex flex-col gap-1.5">
                {nextSteps.map((step, i) => (
                  <div
                    key={i}
                    className="rounded-xl bg-[#111827] border border-white/[0.06] px-4 py-3 flex items-start gap-2.5"
                  >
                    <span className="w-4 h-4 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400 text-[9px] font-bold shrink-0 mt-0.5">
                      {i + 1}
                    </span>
                    <p className="text-slate-300 text-xs leading-relaxed">{step}</p>
                  </div>
                ))}
              </div> : <p className="text-slate-500 text-xs">No concrete next steps identified yet. They’ll appear here when supported by the discussion.</p>}
            </section>

          {/* ── Semantic Insights (collapsed by default) ────── */}
          {rawInsights.length > 0 && (
            <SemanticInsights insights={rawInsights} />
          )}

          {/* Footer */}
          {hasContent && (
            <div className="mt-auto pt-4 flex items-center justify-between text-[10px] text-slate-600 shrink-0">
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                Live Intelligence Engine
              </span>
              <span>RAG + LLM</span>
            </div>
          )}
        </div>
      ) : (
        /* ── Tab: Knowledge Graph ─────────────────────────── */
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden px-1">
          <KnowledgeGraphVisualizer
            graph={displayGraph}
            isLoading={isSynthesizing}
            onRefresh={onRefreshGraph}
          />
        </div>
      )}

      {/* ── Evidence Modal ────────────────────────────────── */}
      {viewingEvidence && (
        <div
          className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={() => setViewingEvidence(null)}
        >
          <div
            className="bg-[#111827] border border-white/10 rounded-2xl max-w-sm w-full p-5 shadow-2xl flex flex-col gap-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-white font-semibold text-sm">Dispute Evidence</h3>
              <button
                onClick={() => setViewingEvidence(null)}
                className="text-slate-500 hover:text-white text-xs transition-colors"
              >
                ✕
              </button>
            </div>
            <p className="text-[11px] text-slate-400 font-medium">{viewingEvidence.label}</p>
            <div className="flex flex-col gap-2">
              <div className="rounded-lg bg-[#161d2e] border border-violet-500/20 px-3.5 py-3">
                <div className="text-[10px] text-violet-400 font-semibold uppercase tracking-wider mb-1">Side A · {viewingEvidence.sideA.count} members</div>
                <p className="text-slate-200 text-xs">{viewingEvidence.sideA.label}</p>
              </div>
              <div className="rounded-lg bg-[#161d2e] border border-rose-500/20 px-3.5 py-3">
                <div className="text-[10px] text-rose-400 font-semibold uppercase tracking-wider mb-1">Side B · {viewingEvidence.sideB.count} members</div>
                <p className="text-slate-200 text-xs">{viewingEvidence.sideB.label}</p>
              </div>
            </div>
            <button
              onClick={() => setViewingEvidence(null)}
              className="w-full py-2 rounded-xl bg-[#1e2536] hover:bg-[#263050] text-slate-200 text-xs font-medium transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Semantic Insights — collapsible section ────────────────────────────────────

const TYPE_CONFIG: Record<string, { label: string; color: string; dot: string }> = {
  consensus:   { label: "Consensus",   color: "text-emerald-400", dot: "bg-emerald-400" },
  debate:      { label: "Debate",      color: "text-amber-400",   dot: "bg-amber-400"   },
  blocker:     { label: "Blocker",     color: "text-rose-400",    dot: "bg-rose-400"    },
  decision:    { label: "Decision",    color: "text-purple-400",  dot: "bg-purple-400"  },
  action_item: { label: "Action",      color: "text-teal-400",    dot: "bg-teal-400"    },
};

function SemanticInsights({ insights }: { insights: Insight[] }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <section className="pt-5">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 mb-2.5 w-full text-left group"
      >
        <svg
          className={`w-3 h-3 text-slate-500 transition-transform ${expanded ? "rotate-90" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M9 5l7 7-7 7" />
        </svg>
        <span className="text-[11px] font-bold text-slate-400 tracking-wide uppercase group-hover:text-slate-300 transition-colors">
          Semantic Insights ({insights.length})
        </span>
      </button>

      {expanded && (
        <div className="flex flex-col gap-1.5">
          {insights.map((ins) => {
            const cfg = TYPE_CONFIG[ins.type] || { label: ins.type, color: "text-slate-400", dot: "bg-slate-400" };
            const pct = Math.round(ins.confidence * 100);
            return (
              <div
                key={ins.insight_id}
                className="rounded-xl bg-[#111827] border border-white/[0.06] px-4 py-3 flex flex-col gap-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dot}`} />
                    <span className={`text-[10px] font-bold uppercase tracking-wider ${cfg.color}`}>{cfg.label}</span>
                  </div>
                  <span className="text-[10px] text-slate-600">{pct}% conf.</span>
                </div>
                <p className="text-slate-300 text-xs leading-relaxed">{ins.text}</p>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
