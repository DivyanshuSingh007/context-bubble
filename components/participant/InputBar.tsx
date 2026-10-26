"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import type { Attachment } from "@/types";
import { uploadAndProcessFile, updatePresence } from "@/lib/api";
import { LiveAudioSession } from "@/lib/audio";
import { DocumentPreview } from "./DocumentPreview";

interface Props {
  bubbleId: string;
  isAnonymous: boolean;
  onToggleAnonymous?: () => void;
  onSubmit: (text: string, attachments?: Attachment[]) => void;
}

const ACCEPTED_TYPES = [
  "image/*",
  "audio/*",
  ".pdf",
  ".xlsx", ".xls",
  ".docx", ".doc",
  ".pptx", ".ppt",
  ".txt", ".md",
  ".json", ".csv",
].join(",");

function getFileIcon(type: Attachment["type"], mimeType?: string): string {
  if (type === "image") return "🖼️";
  if (type === "audio") return "🎙️";
  if (mimeType?.includes("pdf")) return "📕";
  if (mimeType?.includes("spreadsheet") || mimeType?.includes("excel")) return "📊";
  if (mimeType?.includes("wordprocessingml") || mimeType?.includes("msword")) return "📝";
  if (mimeType?.includes("presentation") || mimeType?.includes("powerpoint")) return "📊";
  return "📎";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function InputBar({
  bubbleId,
  isAnonymous,
  onToggleAnonymous,
  onSubmit,
}: Props) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null);

  // Voice recording state
  const [isRecording, setIsRecording] = useState(false);
  const [audioSession, setAudioSession] = useState<LiveAudioSession | null>(null);
  const [liveTranscript, setLiveTranscript] = useState<string>("");

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const typingTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Auto-grow textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [text]);

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    else updatePresence(bubbleId, true).catch(() => {});
    typingTimerRef.current = setTimeout(() => {
      updatePresence(bubbleId, false).catch(() => {});
      typingTimerRef.current = null;
    }, 2500);
  };

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    onSubmit(trimmed, attachments.length > 0 ? attachments : undefined);
    setText("");
    setAttachments([]);
    setLiveTranscript("");
    if (typingTimerRef.current) {
      clearTimeout(typingTimerRef.current);
      typingTimerRef.current = null;
      updatePresence(bubbleId, false).catch(() => {});
    }
  }, [text, attachments, onSubmit, bubbleId]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  // File upload — multipart POST to backend → Cloudinary
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const isImage = file.type.startsWith("image/");
    const isAudio = file.type.startsWith("audio/");
    const isDoc = file.type.startsWith("application/") || file.type.startsWith("text/");
    const typeLabel = isImage ? "image" : isAudio ? "audio" : "document";

    setIsUploading(true);
    setUploadProgress(`Uploading ${typeLabel}: ${file.name} (${formatBytes(file.size)})...`);
    setUploadStatus(null);

    try {
      const res = await uploadAndProcessFile(bubbleId, file);

      const attachType: Attachment["type"] = isImage ? "image" : isAudio ? "audio" : "file";
      const label = isImage
        ? `${file.name}`
        : isDoc
        ? `${file.name} — ${res.char_count.toLocaleString()} chars indexed`
        : file.name;

      const newAttachment: Attachment = {
        type: attachType,
        label,
        file_id: res.file_id,
        url: res.secure_url || res.upload_url,
        mime_type: file.type,
        size_bytes: file.size,
        preview_text: res.preview_text,
      };

      setAttachments((prev) => [...prev, newAttachment]);
      setPreviewAttachment(newAttachment);
      setUploadProgress(null);
      setUploadStatus(
        isImage
          ? `✅ Image uploaded to Cloudinary`
          : isAudio
          ? `✅ Audio uploaded — AI will transcribe`
          : `✅ ${file.name} — ${res.char_count.toLocaleString()} chars extracted & indexed. AI is reviewing...`
      );
      setTimeout(() => setUploadStatus(null), 4000);
    } catch (err: unknown) {
      console.warn("File upload error:", err);
      setUploadProgress(null);
      setUploadStatus(`❌ ${err instanceof Error ? err.message : "Upload failed"}`);
      setTimeout(() => setUploadStatus(null), 5000);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // Voice recording
  const handleToggleVoice = async () => {
    if (isRecording) {
      audioSession?.stop();
      setAudioSession(null);
      setIsRecording(false);
      return;
    }

    try {
      setIsRecording(true);
      setLiveTranscript("Listening...");

      const session = new LiveAudioSession(bubbleId, {
        onPartial: (partial) => setLiveTranscript(partial),
        onFinal: (finalText) => {
          if (finalText) setText((prev) => (prev ? `${prev} ${finalText}` : finalText));
          setLiveTranscript("");
          setIsRecording(false);
        },
        onError: () => {
          setIsRecording(false);
          setLiveTranscript("");
        },
      });

      await session.start();
      setAudioSession(session);
    } catch (err) {
      console.warn("Audio recording error:", err);
      setIsRecording(false);
      setLiveTranscript("");
    }
  };

  return (
    <div className="border border-white/10 rounded-xl bg-[#161d2e] overflow-hidden">
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        onChange={handleFileChange}
        className="hidden"
        accept={ACCEPTED_TYPES}
      />

      {onToggleAnonymous && (
        <button
          type="button"
          onClick={onToggleAnonymous}
          aria-pressed={isAnonymous}
          className="flex w-full items-center justify-between border-b border-white/5 bg-[#1a2236] px-4 py-2 text-left hover:bg-[#202942]"
        >
          <span className="flex items-center gap-2 text-xs text-slate-300">
            <span aria-hidden="true">🔒</span>
            Post anonymously
          </span>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${isAnonymous ? "bg-violet-600/30 text-violet-200" : "bg-slate-800 text-slate-400"}`}>
            {isAnonymous ? "ON" : "OFF"}
          </span>
        </button>
      )}

      {/* Voice Recording Banner */}
      {isRecording && (
        <div className="px-4 py-2 bg-rose-950/40 border-b border-rose-500/30 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-rose-300 text-xs min-w-0">
            <span className="w-2 h-2 rounded-full bg-rose-500 animate-ping shrink-0" />
            <span className="font-semibold shrink-0">Recording:</span>
            <span className="italic text-slate-300 truncate">{liveTranscript || "Listening..."}</span>
          </div>
          <button
            onClick={handleToggleVoice}
            className="shrink-0 text-[10px] bg-rose-600 hover:bg-rose-500 text-white font-bold px-2 py-0.5 rounded"
          >
            Stop &amp; Transcribe
          </button>
        </div>
      )}

      {/* Upload Progress */}
      {uploadProgress && (
        <div className="px-4 py-2 bg-violet-950/30 border-b border-violet-500/20 flex items-center gap-2 text-[11px] text-violet-300">
          <svg className="w-3 h-3 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          <span>{uploadProgress}</span>
        </div>
      )}

      {/* Upload Status Toast */}
      {uploadStatus && (
        <div className={`px-4 py-1.5 border-b text-[11px] font-medium ${
          uploadStatus.startsWith("✅")
            ? "bg-emerald-950/30 border-emerald-500/20 text-emerald-300"
            : "bg-rose-950/30 border-rose-500/20 text-rose-300"
        }`}>
          {uploadStatus}
        </div>
      )}

      {/* Pending Attachments */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 px-4 pt-3 pb-1 border-b border-white/5 bg-[#121826]">
          {attachments.map((att, idx) => (
            <div
              key={idx}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-[#1a2236] border border-white/10 text-xs text-slate-200 max-w-[280px]"
            >
              {/* Image preview if it's a Cloudinary image URL */}
              {att.type === "image" && att.url ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={att.url}
                  alt={att.label}
                  className="w-8 h-8 rounded object-cover border border-white/10 shrink-0"
                />
              ) : (
                <span className="text-base shrink-0">{getFileIcon(att.type, att.mime_type)}</span>
              )}
              <span className="truncate">{att.label}</span>
              <button type="button" onClick={() => setPreviewAttachment(att)} className="shrink-0 text-[10px] font-medium text-violet-300 hover:text-violet-200">Preview</button>
              {att.size_bytes && (
                <span className="text-slate-500 text-[10px] shrink-0">{formatBytes(att.size_bytes)}</span>
              )}
              <button
                type="button"
                onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== idx))}
                className="text-slate-400 hover:text-rose-400 text-xs font-bold shrink-0 ml-auto"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {previewAttachment && <DocumentPreview attachment={previewAttachment} onClose={() => setPreviewAttachment(null)} />}

      {/* Textarea */}
      <textarea
        ref={textareaRef}
        value={text}
        onChange={handleTextChange}
        onKeyDown={handleKeyDown}
        placeholder="Share a thought, evidence, or @AI to trigger synthesis..."
        rows={2}
        className="w-full bg-transparent px-4 py-3 text-slate-200 placeholder-slate-500 text-sm resize-none focus:outline-none min-h-[60px] max-h-[200px]"
      />

      {/* Action row */}
      <div className="flex items-center justify-between px-3 pb-3">
        <span className="font-mono text-[10px] bg-[#0d1117] px-2 py-0.5 rounded border border-white/5 text-slate-500">
          Shift+Enter for new line
        </span>

        <div className="flex items-center gap-2">

          {/* File upload button — opens picker */}
          <div className="relative group">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              title="Upload PDF, Excel, Word, PPT, image, or audio"
              className="w-9 h-9 rounded-lg border border-white/10 bg-[#0d1117] flex items-center justify-center text-slate-400 hover:text-violet-300 hover:border-violet-500/40 transition-colors disabled:opacity-40"
            >
              {isUploading ? (
                <svg className="w-4 h-4 animate-spin text-violet-400" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
                    d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                </svg>
              )}
            </button>
            {/* Tooltip */}
            <div className="absolute bottom-full right-0 mb-1.5 hidden group-hover:flex flex-col items-end z-10">
              <div className="bg-[#1a2236] border border-white/10 rounded-lg px-2.5 py-1.5 text-[10px] text-slate-300 whitespace-nowrap shadow-xl">
                PDF · Excel · Word · PPT · Image · Audio
              </div>
            </div>
          </div>

          {/* Voice recording button */}
          <button
            type="button"
            onClick={handleToggleVoice}
            title={isRecording ? "Stop recording" : "Record voice (AssemblyAI transcription)"}
            className={`w-9 h-9 rounded-lg border flex items-center justify-center transition-colors ${
              isRecording
                ? "bg-rose-600 border-rose-500 text-white animate-pulse"
                : "border-white/10 bg-[#0d1117] text-slate-400 hover:text-slate-200 hover:border-white/20"
            }`}
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1 1.93c-3.94-.49-7-3.85-7-7.93H2c0 4.97 3.63 9.11 8.49 9.87V21h3v-2.2C18.37 18.11 22 13.97 22 9h-2c0 4.08-3.06 7.44-7 7.93V16z" />
            </svg>
          </button>

          {/* Send */}
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!text.trim() && attachments.length === 0}
            className="w-9 h-9 rounded-lg bg-violet-600 flex items-center justify-center text-white hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
