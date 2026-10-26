"use client";

import React, { useEffect, useRef } from "react";
import type { Contribution, Attachment } from "@/types";
import { ContributionCard } from "./ContributionCard";
import { InputBar } from "./InputBar";

interface Props {
  bubbleId?: string;
  contributions: Contribution[];
  isAnonymous: boolean;
  isLive?: boolean;
  hideAttachments?: boolean;
  onToggleAnonymous?: () => void;
  typingUsers?: string[];
  onNewContribution: (text: string, attachments?: Attachment[]) => void;
}

export function ContributionFeed({
  bubbleId = "demo",
  contributions,
  isAnonymous,
  isLive = true,
  hideAttachments = false,
  onToggleAnonymous,
  typingUsers = [],
  onNewContribution,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Track whether the user has manually scrolled up — if so, don't force-scroll
  const isAtBottomRef = useRef(true);

  // Keep track of whether user is near the bottom
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 80; // px from bottom
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  };

  // Auto-scroll to bottom when new messages arrive, but only if already at bottom
  useEffect(() => {
    if (!isAtBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [contributions.length]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Feed header */}
      <div className="flex items-center justify-between shrink-0 mb-3">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          <h2 className="text-white font-semibold text-sm">{isLive ? "Live Deliberation Feed" : "Bubble Chat"}</h2>
          <span className="text-xs text-slate-500">({contributions.length})</span>
        </div>
        <div className="flex items-center gap-2">
          {typingUsers.length > 0 && (
            <div className="flex items-center gap-1.5 text-[11px] text-violet-300 bg-violet-950/40 border border-violet-500/30 px-2.5 py-0.5 rounded-full animate-pulse">
              <span className="w-1.5 h-1.5 rounded-full bg-violet-400" />
              <span>{typingUsers.join(", ")} typing…</span>
            </div>
          )}
        </div>
      </div>

      {/* Scrollable message list — oldest at top, newest at bottom (WhatsApp style) */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 flex flex-col gap-2 overflow-y-auto min-h-0 pr-0.5"
      >
        {contributions.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8 text-slate-500">
            <div className="w-10 h-10 rounded-full bg-violet-500/10 flex items-center justify-center text-violet-400 mb-2 text-lg">
              💬
            </div>
            <p className="text-sm font-medium text-slate-400">No contributions yet</p>
            <p className="text-xs mt-1 text-slate-500">Share your thoughts below to start the deliberation.</p>
          </div>
        ) : (
          contributions.map((c) => (
            <ContributionCard key={c.id} contribution={c} hideAttachments={hideAttachments} />
          ))
        )}

        {/* Typing indicator at the bottom */}
        {typingUsers.length > 0 && (
          <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-slate-500">
            <span className="flex gap-0.5">
              <span className="w-1.5 h-1.5 rounded-full bg-slate-500 animate-bounce" style={{ animationDelay: "0ms" }} />
              <span className="w-1.5 h-1.5 rounded-full bg-slate-500 animate-bounce" style={{ animationDelay: "150ms" }} />
              <span className="w-1.5 h-1.5 rounded-full bg-slate-500 animate-bounce" style={{ animationDelay: "300ms" }} />
            </span>
            <span>{typingUsers.join(", ")} {typingUsers.length === 1 ? "is" : "are"} typing…</span>
          </div>
        )}
      </div>

      {/* Input bar — fixed at bottom */}
      <div className="shrink-0 mt-3">
        {isLive ? (
          <InputBar
            bubbleId={bubbleId}
            isAnonymous={isAnonymous}
            onToggleAnonymous={onToggleAnonymous}
            onSubmit={onNewContribution}
          />
        ) : (
          <div className="rounded-xl border border-amber-500/20 bg-amber-950/20 px-4 py-3 text-center text-xs text-amber-200/80">
            This session has ended. Contributions are closed.
          </div>
        )}
      </div>
    </div>
  );
}
