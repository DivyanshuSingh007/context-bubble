"use client";

import { useState } from "react";
import { downloadBriefingPdf, saveBlob } from "@/lib/api";
import type { ExecutiveBriefing } from "@/types";

function recordFilename(title: string, extension: string): string {
  const slug = title.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 60) || "bubble";
  return `decision-record-${slug}.${extension}`;
}

interface Props {
  bubbleId: string;
  briefing: ExecutiveBriefing;
}

export function DecisionRecordDownloads({ bubbleId, briefing }: Props) {
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = briefing.bubble_title || bubbleId;

  const handlePdf = async () => {
    setDownloadingPdf(true);
    setError(null);
    try {
      await downloadBriefingPdf(bubbleId, recordFilename(title, "pdf"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not download the PDF.");
    } finally {
      setDownloadingPdf(false);
    }
  };

  const handleMarkdown = () => {
    if (!briefing.markdown_content) return;
    saveBlob(new Blob([briefing.markdown_content], { type: "text/markdown;charset=utf-8" }), recordFilename(title, "md"));
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void handlePdf()}
          disabled={downloadingPdf}
          className="cursor-pointer rounded-xl bg-violet-600 px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-violet-500 disabled:opacity-60"
        >
          {downloadingPdf ? "Preparing PDF…" : "Download PDF"}
        </button>
        {briefing.markdown_content && (
          <button
            type="button"
            onClick={handleMarkdown}
            className="cursor-pointer rounded-xl border border-white/10 bg-[#161d2e] px-3.5 py-2 text-xs font-medium text-slate-200 transition-colors hover:bg-[#1a2236]"
          >
            Download Markdown
          </button>
        )}
      </div>
      {error && <p role="alert" className="text-xs text-rose-300">{error}</p>}
    </div>
  );
}
