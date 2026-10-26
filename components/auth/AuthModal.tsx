"use client";

import React, { useState } from "react";
import { createEmailAccount, signInWithEmail, signInWithGoogle, type AppUser } from "@/lib/auth";

interface Props {
  isOpen?: boolean;
  onClose?: () => void;
  onSuccess?: (user: AppUser) => void;
  title?: string;
  subtitle?: string;
  isInline?: boolean;
}

export function AuthModal({
  isOpen = true,
  onClose,
  onSuccess,
  title = "Sign In to Context Bubble",
  subtitle = "Sign in to your account or create one to continue.",
  isInline = false,
}: Props) {
  const [isCreating, setIsCreating] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (isCreating && !name.trim()) {
      setError("Enter your name to create an account.");
      return;
    }
    setLoading(true);
    try {
      if (isCreating) {
        await createEmailAccount(name, email, password);
        setIsCreating(false);
        setPassword("");
        setNotice("Account created. Sign in with your email and password to continue.");
        return;
      }
      const user = await signInWithEmail(email, password);
      onSuccess?.(user);
      onClose?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const submitGoogle = async () => {
    setError(null);
    setNotice(null);
    setGoogleLoading(true);
    try {
      const user = await signInWithGoogle();
      onSuccess?.(user);
      onClose?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Google sign-in failed. Please try again.");
    } finally {
      setGoogleLoading(false);
    }
  };

  const content = (
    <div className="relative flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col gap-5 overflow-y-auto rounded-2xl border border-white/10 bg-[#111827] p-6 shadow-2xl sm:p-7">
      {!isInline && onClose && <button onClick={onClose} className="absolute right-4 top-4 text-slate-400 transition-colors hover:text-white" title="Close">✕</button>}
      <div>
        <div className="mb-2 flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 text-sm font-bold text-white shadow-md">C</div>
          <h2 className="text-xl font-bold tracking-tight text-white">{isCreating ? "Create your account" : title}</h2>
        </div>
        <p className="text-xs leading-relaxed text-slate-400">{isCreating ? "Create an account with your name, email, and password." : subtitle}</p>
      </div>
      {error && <div role="alert" className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-3.5 text-xs leading-relaxed text-amber-200">
        {error}
        {isCreating && error.toLowerCase().includes("account already exists") && <button type="button" onClick={() => { setIsCreating(false); setError(null); }} className="ml-1 font-bold underline underline-offset-2 hover:text-amber-100">Sign in instead</button>}
      </div>}
      {notice && <div role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-3.5 text-xs leading-relaxed text-emerald-200">{notice}</div>}
      <form onSubmit={submit} className="flex flex-col gap-3.5">
        {isCreating && <label className="flex flex-col gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-300">Account name<input required autoComplete="name" maxLength={50} value={name} onChange={e => setName(e.target.value)} placeholder="Your name" className="rounded-xl border border-white/10 bg-[#161d2e] px-3 py-2.5 text-sm normal-case tracking-normal text-white placeholder-slate-500 focus:border-violet-500/50 focus:outline-none" /></label>}
        <label className="flex flex-col gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-300">Email<input required type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" className="rounded-xl border border-white/10 bg-[#161d2e] px-3 py-2.5 text-sm normal-case tracking-normal text-white placeholder-slate-500 focus:border-violet-500/50 focus:outline-none" /></label>
        <label className="flex flex-col gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-300">Password<input required type="password" minLength={6} autoComplete={isCreating ? "new-password" : "current-password"} value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 6 characters" className="rounded-xl border border-white/10 bg-[#161d2e] px-3 py-2.5 text-sm normal-case tracking-normal text-white placeholder-slate-500 focus:border-violet-500/50 focus:outline-none" /></label>
        <button type="submit" disabled={loading || googleLoading || !email.trim() || !password || (isCreating && !name.trim())} className="mt-1 flex w-full items-center justify-center rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-violet-900/30 transition-all hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50">
          {loading ? "Please wait…" : isCreating ? "Create account" : "Sign in"}
        </button>
      </form>
      {!isCreating && <>
        <div className="flex items-center gap-3"><div className="h-px flex-1 bg-white/10" /><span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">or</span><div className="h-px flex-1 bg-white/10" /></div>
        <button type="button" onClick={submitGoogle} disabled={loading || googleLoading} className="flex w-full items-center justify-center gap-3 rounded-xl border border-white/10 bg-[#161d2e] px-4 py-2.5 text-sm font-medium text-slate-200 transition-colors hover:bg-[#1c263c] disabled:opacity-50">
          {googleLoading ? "Connecting…" : <><svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg>Continue with Google</>}
        </button>
      </>}
      <p className="text-center text-xs text-slate-400">
        {isCreating ? "Already have an account?" : "New here?"}{" "}
        <button type="button" onClick={() => { setIsCreating(!isCreating); setError(null); setNotice(null); }} className="font-semibold text-violet-300 hover:text-violet-200">{isCreating ? "Sign in" : "Create account"}</button>
      </p>
    </div>
  );

  if (isInline) return content;
  if (!isOpen) return null;
  return <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/75 p-4 backdrop-blur-md">{content}</div>;
}
