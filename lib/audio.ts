"use client";

import { BACKEND_URL } from "@/lib/api";
import { getCurrentIdToken } from "@/lib/auth";

export interface AudioStreamHandlers {
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (err: Error) => void;
}

// Minimal Web Speech API surface (not yet in TypeScript's DOM lib).
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  start(): void;
  stop(): void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/**
 * LiveAudioSession — records audio via MediaRecorder and streams it to the
 * backend over WebSocket. The backend transcribes the complete recording
 * via AssemblyAI (or Gemini fallback) and sends back the final text.
 *
 * Flow:
 * 1. start() — opens WebSocket, starts MediaRecorder
 * 2. Chunks are sent to backend as they arrive
 * 3. stop() — sends "END_SPEECH", waits for the "final" response, then closes
 */
export class LiveAudioSession {
  private bubbleId: string;
  private ws: WebSocket | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private handlers: AudioStreamHandlers;
  private isRecording = false;
  private finalReceived = false;
  private speechRecognition: SpeechRecognitionLike | null = null;
  private clientTranscript: string = "";

  constructor(bubbleId: string, handlers: AudioStreamHandlers) {
    this.bubbleId = bubbleId;
    this.handlers = handlers;
  }

  async start(): Promise<void> {
    if (this.isRecording) return;
    this.clientTranscript = "";
    this.finalReceived = false;

    // 1. Initialize browser-native Web Speech API for instant (<1s) local speech recognition
    const speechWindow = typeof window !== "undefined"
      ? (window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor })
      : null;
    const SpeechRecognitionClass = speechWindow?.SpeechRecognition || speechWindow?.webkitSpeechRecognition;

    if (SpeechRecognitionClass) {
      try {
        const recognition = new SpeechRecognitionClass();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = "en-US";

        recognition.onresult = (event) => {
          let fullText = "";
          for (let i = 0; i < event.results.length; i++) {
            const res = event.results[i];
            if (res && res[0]) {
              fullText += (i > 0 ? " " : "") + res[0].transcript;
            }
          }
          this.clientTranscript = fullText.trim();
          if (this.clientTranscript) {
            this.handlers.onPartial?.(this.clientTranscript);
          }
        };

        recognition.onerror = (e) => {
          console.debug("Web Speech API notice:", e?.error || e);
        };

        recognition.start();
        this.speechRecognition = recognition;
      } catch (speechErr) {
        console.debug("SpeechRecognition initialization notice:", speechErr);
      }
    }

    try {
      // 2. Get microphone access for MediaRecorder audio buffer
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000,
        },
      });

      // 3. Build WebSocket URL to backend. The server derives the speaker from the
      // verified token; browsers cannot set headers on a WebSocket handshake.
      const token = await getCurrentIdToken().catch(() => null);
      const wsUrl = new URL(`${BACKEND_URL}/api/v1/bubbles/${this.bubbleId}/audio`);
      wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
      if (token) wsUrl.searchParams.set("token", token);

      this.ws = new WebSocket(wsUrl);
      this.ws.binaryType = "arraybuffer";

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "partial" && data.text && !this.clientTranscript) {
            this.handlers.onPartial?.(data.text);
          } else if (data.type === "final") {
            if (!this.finalReceived) {
              this.finalReceived = true;
              const finalText = data.text || this.clientTranscript || "";
              this.handlers.onFinal?.(finalText);
              this.cleanup();
            }
          }
        } catch {
          // Ignored
        }
      };

      this.ws.onerror = () => {
        if (!this.clientTranscript) {
          this.handlers.onError?.(new Error("Audio WebSocket connection error"));
        }
      };

      // Start MediaRecorder in parallel for backup/multimodal streaming
      this.mediaRecorder = new MediaRecorder(this.stream, {
        mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm",
      });

      this.mediaRecorder.ondataavailable = async (e) => {
        if (e.data.size > 0 && this.ws && this.ws.readyState === WebSocket.OPEN) {
          const buffer = await e.data.arrayBuffer();
          this.ws.send(buffer);
        }
      };

      this.mediaRecorder.start(400); // Send chunks every 400ms
      this.isRecording = true;
    } catch (err: unknown) {
      this.cleanup();
      throw err;
    }
  }

  stop(): void {
    if (!this.isRecording) return;
    this.isRecording = false;

    // 1. Stop SpeechRecognition
    if (this.speechRecognition) {
      try {
        this.speechRecognition.stop();
      } catch {
        // Ignored
      }
    }

    // 2. Stop MediaRecorder
    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      try {
        this.mediaRecorder.stop();
      } catch {
        // Ignored
      }
    }

    // 3. Fast path: If client speech recognition already captured words, return in <0.3s!
    const captured = this.clientTranscript.trim();
    if (captured.length > 0) {
      this.finalReceived = true;
      this.handlers.onFinal?.(captured);
      this.cleanup();
      return;
    }

    // 4. Fallback path: Tell backend to transcribe via fast Gemini multimodal (1-2s)
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send("END_SPEECH");
      } catch {
        // Ignored
      }
    }

    this.handlers.onPartial?.("Transcribing...");

    // Safety fallback timeout in case WebSocket or network drops
    setTimeout(() => {
      if (!this.finalReceived) {
        this.finalReceived = true;
        this.handlers.onFinal?.(this.clientTranscript.trim());
        this.cleanup();
      }
    }, 4000);
  }

  private cleanup(): void {
    this.isRecording = false;

    if (this.speechRecognition) {
      try {
        this.speechRecognition.stop();
      } catch {
        // Ignored
      }
      this.speechRecognition = null;
    }

    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      try {
        this.mediaRecorder.stop();
      } catch {
        // Ignored
      }
    }
    this.mediaRecorder = null;

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignored
      }
      this.ws = null;
    }
  }
}
