"use client";

import { useState, useEffect } from "react";
import {
  signOut as fbSignOut,
  onAuthStateChanged,
  updateProfile,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  GoogleAuthProvider,
} from "firebase/auth";
import { auth } from "@/lib/firebase";

export interface AppUser {
  uid: string;
  displayName: string | null;
  email?: string | null;
  photoURL?: string | null;
  isAnonymous?: boolean;
  getIdToken: () => Promise<string>;
}

type FirebaseErrorLike = { code?: string; message?: string } | null | undefined;

/**
 * Format human-readable Firebase Auth errors
 */
export function formatAuthError(error: unknown): string {
  const err = error as FirebaseErrorLike;
  const code = (err?.code || "").toLowerCase();
  const msg = (err?.message || "").toLowerCase();

  if (
    code === "auth/configuration-not-found" ||
    msg.includes("auth/configuration-not-found") ||
    msg.includes("configuration-not-found")
  ) {
    return "Email and password sign-in is not enabled for this Firebase project.";
  }
  if (code === "auth/popup-blocked" || msg.includes("popup-blocked")) {
    return "Authentication failed. Please try again.";
  }
  if (code === "auth/unauthorized-domain" || msg.includes("unauthorized-domain")) {
    return "This domain is not authorized in Firebase Console.";
  }
  if (code === "auth/operation-not-allowed" || msg.includes("operation-not-allowed")) {
    return "Email and password sign-in is not enabled in Firebase Console.";
  }
  if (code === "auth/cancelled-popup-request" || code === "auth/popup-closed-by-user") {
    return "Sign-in was cancelled.";
  }
  if (code === "auth/credential-already-in-use") {
    return "This account is already in use by another session. Signing out and reconnecting...";
  }
  if (code === "auth/email-already-in-use") return "An account already exists for this email.";
  if (code === "auth/invalid-credential" || code === "auth/user-not-found" || code === "auth/wrong-password") return "Email or password is incorrect.";
  if (code === "auth/weak-password") return "Choose a password with at least 6 characters.";
  if (code === "auth/invalid-email") return "Enter a valid email address.";
  return err?.message || "Authentication failed. Please try again.";
}

/**
 * Helper to get local stored session
 */
export function getLocalStoredSession(): AppUser | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem("context_bubble_user");
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data.uid || !data.displayName || data.isAnonymous || String(data.uid).startsWith("usr-")) return null;
    return {
      uid: data.uid,
      displayName: data.displayName,
      email: data.email || null,
      photoURL: data.photoURL || null,
      isAnonymous: Boolean(data.isAnonymous),
      getIdToken: async () => `dev-${data.uid}`,
    };
  } catch {
    return null;
  }
}

async function persistAuthenticatedUser(user: AppUser): Promise<AppUser> {
  if (typeof window !== "undefined") {
    localStorage.setItem("context_bubble_user", JSON.stringify({
      uid: user.uid, displayName: user.displayName, email: user.email,
      photoURL: user.photoURL, isAnonymous: false,
    }));
    window.dispatchEvent(new Event("context_bubble_auth_change"));
  }
  return user;
}

export async function signInWithEmail(email: string, password: string): Promise<AppUser> {
  try {
    const result = await signInWithEmailAndPassword(auth, email.trim(), password);
    return persistAuthenticatedUser(result.user);
  } catch (err) {
    throw new Error(formatAuthError(err));
  }
}

export async function signInWithGoogle(): Promise<AppUser> {
  const provider = new GoogleAuthProvider();
  provider.addScope("profile");
  provider.addScope("email");
  provider.setCustomParameters({ prompt: "select_account" });

  try {
    const result = await signInWithPopup(auth, provider);
    return await persistAuthenticatedUser(result.user);
  } catch (err) {
    const code = ((err as FirebaseErrorLike)?.code || "").toLowerCase();
    if (code === "auth/popup-blocked" || code.includes("popup-blocked")) {
      try {
        await signInWithRedirect(auth, provider);
        return new Promise(() => {});
      } catch (redirectErr) {
        throw new Error(formatAuthError(redirectErr));
      }
    }
    if (code === "auth/operation-not-allowed") {
      throw new Error("Google sign-in is not enabled for this Firebase project.");
    }
    throw new Error(formatAuthError(err));
  }
}

export async function createEmailAccount(name: string, email: string, password: string): Promise<void> {
  try {
    const result = await createUserWithEmailAndPassword(auth, email.trim(), password);
    const cleanName = name.trim();
    const avatarUrl = `https://api.dicebear.com/9.x/notionists/svg?seed=${encodeURIComponent(cleanName)}&backgroundColor=b6e3f4`;
    await updateProfile(result.user, { displayName: cleanName, photoURL: avatarUrl });
    // Require an explicit sign-in after registration so the user lands on the sign-in form.
    await signOutUser();
  } catch (err) {
    throw new Error(formatAuthError(err));
  }
}

export async function signOutUser(): Promise<void> {
  try {
    await fbSignOut(auth);
  } catch {
    // Ignored
  }
  if (typeof window !== "undefined") {
    localStorage.removeItem("context_bubble_user");
    window.dispatchEvent(new Event("context_bubble_auth_change"));
  }
}

export function getOrCreateLocalSession(defaultName: string = "Participant"): AppUser {
  if (typeof window === "undefined") {
    return {
      uid: "usr-dev",
      displayName: defaultName,
      getIdToken: async () => "dev-participant",
    };
  }

  const existing = getLocalStoredSession();
  if (existing) return existing;

  const randId = Math.random().toString(36).substring(2, 8);
  const newUid = `usr-${randId}`;
  const newUser: AppUser = {
    uid: newUid,
    displayName: defaultName,
    email: `${newUid}@contextbubble.local`,
    photoURL: `https://api.dicebear.com/9.x/notionists/svg?seed=${newUid}&backgroundColor=b6e3f4`,
    isAnonymous: false,
    getIdToken: async () => `dev-${newUid}`,
  };

  try {
    localStorage.setItem(
      "context_bubble_user",
      JSON.stringify({
        uid: newUser.uid,
        displayName: newUser.displayName,
        email: newUser.email,
        photoURL: newUser.photoURL,
        isAnonymous: false,
      })
    );
  } catch {
    // Ignored
  }

  return newUser;
}

export async function getCurrentIdToken(): Promise<string | null> {
  if (auth.currentUser) {
    try {
      return await auth.currentUser.getIdToken();
    } catch {
      // Fall through to local session
    }
  }

  const session = getOrCreateLocalSession();
  return `dev-${session.uid}`;
}

export function useFirebaseAuth() {
  // Always start with null on both server and client's first render to avoid hydration mismatch.
  // localStorage / Firebase Auth state is loaded in useEffect (client-only).
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error] = useState<string | null>(null);

  useEffect(() => {
    // Only runs on client after hydration — safe to read localStorage and Firebase Auth.
    const syncUser = () => {
      if (auth.currentUser && !auth.currentUser.isAnonymous) {
        setUser(auth.currentUser);
      } else {
        setUser(null);
      }
      setLoading(false);
    };

    syncUser();

    // Catch redirect sign-in result if user returned from redirect flow
    getRedirectResult(auth)
      .then((result) => {
        if (result && result.user && !result.user.isAnonymous) {
          persistAuthenticatedUser(result.user).then((u) => setUser(u));
        }
      })
      .catch((err) => {
        console.debug("Redirect auth check:", err);
      });

    window.addEventListener("context_bubble_auth_change", syncUser);

    const unsubscribe = onAuthStateChanged(
      auth,
      (currentUser) => {
        if (currentUser && !currentUser.isAnonymous) {
          setUser(currentUser);
        } else {
          setUser(null);
        }
        setLoading(false);
      },
      () => {
        syncUser();
      }
    );

    return () => {
      window.removeEventListener("context_bubble_auth_change", syncUser);
      unsubscribe();
    };
  }, []);

  return {
    user,
    loading,
    error,
    signInEmail: signInWithEmail,
    signOut: signOutUser,
  };
}
