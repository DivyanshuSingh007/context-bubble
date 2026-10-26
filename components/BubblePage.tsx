"use client";

import React, { useState, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import type { Bubble, BubbleMember, Role, Contribution, Attachment, KnowledgeGraph, ExecutiveBriefing } from "@/types";
import { Header } from "@/components/layout/Header";
import { ContributionFeed } from "@/components/participant/ContributionFeed";
import { LiveIntelligencePanel } from "@/components/intelligence/LiveIntelligencePanel";
import { ManageBubblePanel } from "@/components/host/ManageBubblePanel";
import { useFirebaseAuth } from "@/lib/auth";
import { subscribeToBubbleMessages, sendMessageToFirestore } from "@/lib/messages";
import { getBubble, getKnowledgeGraph, subscribeToBubbleStream, getPopStatus, joinBubble, getBriefing, updatePresence, getActivePresence, extendBubble, leaveBubble, removeBubbleParticipant, updateAnonymousAvailability } from "@/lib/api";
import { getAvatarUrl, getSavedAvatarProfile } from "@/lib/avatar-profile";
import { AuthModal } from "@/components/auth/AuthModal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

interface Props {
  initialBubble: Bubble;
  initialRole?: Role;
  initialUserName?: string;
  joinCode?: string;
  readOnly?: boolean;
}

function mergeIntelligence(previous: Bubble["intelligence"], incoming: Partial<Bubble["intelligence"]>, allowEmptyLists = false) {
  const keepOrReplace = <T,>(oldItems: T[], nextItems: T[] | undefined) =>
    Array.isArray(nextItems) && (allowEmptyLists || nextItems.length > 0) ? nextItems : oldItems;
  // The backend may send snake_case keys; normalize them to the client shape.
  const wire = incoming as Partial<Bubble["intelligence"]> & {
    missing_pieces?: Bubble["intelligence"]["missingPieces"];
    next_steps?: string[];
  };
  const missingPiecesIncoming = incoming.missingPieces ?? wire.missing_pieces;
  const nextStepsIncoming = incoming.nextSteps ?? wire.next_steps;
  return {
    ...previous,
    ...incoming,
    summary: typeof incoming.summary === "string" && incoming.summary.trim() ? incoming.summary : previous.summary,
    disagreements: keepOrReplace(previous.disagreements, incoming.disagreements),
    missingPieces: keepOrReplace(previous.missingPieces, missingPiecesIncoming),
    nextSteps: keepOrReplace(previous.nextSteps, nextStepsIncoming),
    raw_insights: keepOrReplace(previous.raw_insights || [], incoming.raw_insights),
  };
}

export function BubblePage({ initialBubble, initialRole, initialUserName, joinCode, readOnly = false }: Props) {
  // Firebase Auth state
  const { user, loading: authLoading } = useFirebaseAuth();
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const router = useRouter();

  // Bubble state
  const [bubble, setBubble] = useState<Bubble>(() => {
    return {
      ...initialBubble,
      contributions: initialBubble.contributions.filter((contribution) => contribution.authorId !== "bubble-ai" && contribution.authorName !== "Bubble AI"),
      expiresAt: initialBubble.expiresAt,
      popState: initialBubble.popState || "ACTIVE",
    };
  });

  // Role: genuinely determined by whether user.uid matches bubble.hostId or initialRole
  const [role, setRole] = useState<Role>(() => {
    if (initialRole) return initialRole;
    if (bubble.hostId && user?.uid && bubble.hostId === user.uid) return "host";
    return "participant";
  });

  const [isManageOpen, setIsManageOpen] = useState(false);
  const [showLeaveConfirmation, setShowLeaveConfirmation] = useState(false);
  const [isLeavingBubble, setIsLeavingBubble] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [anonymousPreference, setAnonymousPreference] = useState(false);

  // Live SSE stream state
  const [streamingToken, setStreamingToken] = useState<string>("");
  const [isSynthesizing, setIsSynthesizing] = useState<boolean>(false);
  const [knowledgeGraph, setKnowledgeGraph] = useState<KnowledgeGraph | null>(null);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);


  // Popped / Executive Briefing Modal State
  const [showBriefingModal, setShowBriefingModal] = useState<boolean>(false);
  const briefingModalStartedRef = useRef(false);
  const briefingRedirectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [briefing, setBriefing] = useState<ExecutiveBriefing | null>(null);
  const [copiedBriefing, setCopiedBriefing] = useState<boolean>(false);

  // Pop notification state — set from SSE pop_state_change events
  const [popReason, setPopReason] = useState<string>("");
  const [popMessage, setPopMessage] = useState<string>("");
  const [retentionPolicy, setRetentionPolicy] = useState<string>(bubble.retentionPolicy || "temporary");
  const [graceSeconds, setGraceSeconds] = useState<number | null>(null);
  const [isExtendingExpiry, setIsExtendingExpiry] = useState(false);
  const [expiryError, setExpiryError] = useState("");
  const [removedByHost, setRemovedByHost] = useState(false);
  const [memberNotice, setMemberNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!memberNotice) return;
    const timer = window.setTimeout(() => setMemberNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [memberNotice]);

  // 1. Fetch live Bubble metadata from backend & auto-register participant
  useEffect(() => {
    if (!bubble.id) return;
    let isMounted = true;

    // If user is authenticated, ensure they are registered in the backend participant roster
    if (!readOnly && user && user.displayName) {
      const avatarProfile = getSavedAvatarProfile(user.uid);
      const meetingDisplayName = initialUserName?.trim() || user.displayName;
      const ensureMembership = initialRole === "host" && meetingDisplayName !== user.displayName
        ? Promise.resolve(null)
        : joinBubble(bubble.id, {
          display_name: meetingDisplayName,
          join_code: joinCode,
          avatar_url: avatarProfile.kind === "human" ? getAvatarUrl(user.uid, meetingDisplayName, avatarProfile.style) : undefined,
          avatar_animal: avatarProfile.kind === "animal" ? avatarProfile.animal : undefined,
        });
      ensureMembership.then((member) => {
        if (!member) return;
        if (isMounted) {
          setBubble((prev) => {
            const members = prev.members.some((item) => item.id === member.id)
              ? prev.members.map((item) => item.id === member.id ? { ...item, ...member, isOnline: true } : item)
              : [...prev.members, { ...member, isOnline: true }];
            members.sort((a, b) => a.id.localeCompare(b.id));
            return { ...prev, members, memberCount: new Set(members.filter((item) => item.isOnline !== false).map((item) => item.id)).size };
          });
        }
        return updatePresence(bubble.id, false, "online");
      }).catch((err) => {
        console.debug("Participant join check notice:", err);
        if (String(err?.message || "").toLowerCase().includes("removed by the host")) {
          setRemovedByHost(true);
        }
      });
    }

    getBubble(bubble.id)
      .then((data) => {
        if (!isMounted) return;
        setBubble((prev) => ({
          ...prev,
          title: data.title || prev.title,
          joinCode: data.join_code || prev.joinCode,
          isLive: data.is_live ?? prev.isLive,
          expiresAt: data.expires_at ? new Date(data.expires_at) : prev.expiresAt,
          memberCount: data.member_count ?? prev.memberCount,
          members: data.members && data.members.length > 0
            ? (data.members as BubbleMember[]).map((member) => {
              if (member.id !== user?.uid) return member;
              const current = prev.members.find((item) => item.id === member.id);
              return current?.avatar ? { ...member, avatar: current.avatar, avatar_animal: current.avatar_animal } : member;
            }).sort((a, b) => a.id.localeCompare(b.id))
            : prev.members,
          retentionPolicy: data.retention_policy || prev.retentionPolicy,
          anonymousModeEnabled: data.anonymous_mode_enabled ?? prev.anonymousModeEnabled,
          triggerMode: data.trigger_mode || prev.triggerMode,
          popState: data.pop_state || prev.popState,
          hostId: data.host_id || prev.hostId,
          expiryDecisionDeadline: data.expiry_decision_deadline ? new Date(data.expiry_decision_deadline) : undefined,
          viewUntil: data.view_until ? new Date(data.view_until) : undefined,
          intelligence: data.intelligence
            ? mergeIntelligence(prev.intelligence, data.intelligence)
            : prev.intelligence,
        }));
        if (data.retention_policy) setRetentionPolicy(data.retention_policy);

        // Dynamically compute authentic role based on hostId
        if (data.host_id && user?.uid) {
          if (data.host_id === user.uid) {
            setRole("host");
          } else if (initialRole !== "host") {
            setRole("participant");
          }
        }
      })
      .catch((err) => {
        console.debug("Backend bubble fetch status:", err);
      });

    // Fetch initial knowledge graph
    getKnowledgeGraph(bubble.id)
      .then((g) => {
        if (isMounted && g && g.nodes?.length) {
          setKnowledgeGraph((previous) => !previous || g.version >= previous.version ? g : previous);
        }
      })
      .catch(() => {});

    return () => {
      isMounted = false;
    };
  }, [bubble.id, user?.uid, user?.displayName, initialUserName, joinCode, readOnly]);

  useEffect(() => {
    if (!bubble.id || !user?.uid) {
      setAnonymousPreference(false);
      return;
    }
    const key = `context_bubble_anonymous:${bubble.id}:${user.uid}`;
    setAnonymousPreference(window.localStorage.getItem(key) === "true");
  }, [bubble.id, user?.uid, bubble.anonymousModeEnabled]);

  useEffect(() => {
    if (bubble.popState !== "EXPIRY_PENDING" || !bubble.expiryDecisionDeadline) return;
    const update = () => {
      const remaining = Math.max(0, Math.ceil((bubble.expiryDecisionDeadline!.getTime() - Date.now()) / 1000));
      setGraceSeconds(remaining);
      if (remaining <= 0 && role === "host") {
        router.replace(`/bubble/${bubble.id}/end?reason=expired`);
      } else if (remaining <= 0 && role === "participant") {
        router.replace("/");
      }
    };
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [bubble.id, bubble.expiryDecisionDeadline, bubble.popState, role, router]);

  const handleExtendFromExpiry = async () => {
    setIsExtendingExpiry(true);
    setExpiryError("");
    try {
      const result = await extendBubble(bubble.id, 15);
      setBubble((prev) => ({ ...prev, popState: "ACTIVE", isLive: true, expiresAt: new Date(result.new_expires_at), expiryDecisionDeadline: undefined }));
      setGraceSeconds(null);
    } catch (err) {
      setExpiryError(err instanceof Error ? err.message : "Could not extend the bubble.");
    } finally {
      setIsExtendingExpiry(false);
    }
  };

  // Report a short-lived presence heartbeat so the header counts people who are
  // actually connected, instead of every account that has ever joined.
  useEffect(() => {
    if (!bubble.id || readOnly) return;
    let isMounted = true;

    const refreshPresence = async () => {
      try {
        await updatePresence(bubble.id, false, "online");
        const active = await getActivePresence(bubble.id);
        if (!isMounted) return;

        setBubble((prev) => {
          const activeById = new Map(active.map((presence) => [presence.user_id, presence]));
          const membersById = new Map(prev.members.map((member) => [member.id, member]));
          for (const presence of active) {
            const old = membersById.get(presence.user_id);
            membersById.set(presence.user_id, {
              ...(old || { id: presence.user_id, role: "participant" as const }),
              name: presence.display_name,
              isOnline: true,
            });
          }
          const members = [...membersById.values()]
            .map((member) => ({ ...member, isOnline: activeById.has(member.id) }))
            .sort((a, b) => a.id.localeCompare(b.id));
          const unchanged = prev.memberCount === activeById.size && members.length === prev.members.length && members.every((member, index) => {
            const old = prev.members[index];
            return old?.id === member.id && old.name === member.name && old.avatar === member.avatar && old.avatar_animal === member.avatar_animal && old.isOnline === member.isOnline;
          });
          return unchanged ? prev : { ...prev, members, memberCount: activeById.size };
        });
      } catch (err) {
        console.debug("Presence refresh notice:", err);
      }
    };

    const markOffline = () => {
      void updatePresence(bubble.id, false, "offline");
    };

    void refreshPresence();
    const interval = window.setInterval(refreshPresence, 10000);
    window.addEventListener("pagehide", markOffline);
    window.addEventListener("pageshow", refreshPresence);
    return () => {
      isMounted = false;
      window.clearInterval(interval);
      window.removeEventListener("pagehide", markOffline);
      window.removeEventListener("pageshow", refreshPresence);
      markOffline();
    };
  }, [bubble.id, readOnly]);

  // SSE provides immediate updates; refresh the persisted snapshot periodically
  // so a dropped event or temporary stream disconnect cannot leave the panel stale.
  useEffect(() => {
    if (!bubble.id || bubble.popState !== "ACTIVE" || isSynthesizing) return;
    let isMounted = true;

    const refreshIntelligence = async () => {
      try {
        const data = await getBubble(bubble.id);
        const intelligence = data.intelligence;
        if (!isMounted || !intelligence || isSynthesizing) return;
        setBubble((prev) => ({
          ...prev,
          intelligence: mergeIntelligence(prev.intelligence, intelligence),
        }));
      } catch (err) {
        console.debug("Intelligence refresh status:", err);
      }
    };

    const interval = window.setInterval(refreshIntelligence, 8000);
    return () => {
      isMounted = false;
      window.clearInterval(interval);
    };
  }, [bubble.id, bubble.popState, isSynthesizing]);

  // When bubble is popped: fetch real briefing, show modal briefly, then redirect
  const loadBriefingModal = useCallback(async () => {
    if (briefingModalStartedRef.current) return;
    briefingModalStartedRef.current = true;
    try {
      // Fetch the real generated briefing from backend
      const realBriefing = await getBriefing(bubble.id);
      if (realBriefing) {
        setBriefing(realBriefing);
      }
    } catch {
      // Non-fatal — we'll still redirect
    }
    setShowBriefingModal(true);

    // After 8 seconds redirect to home — session is over
    briefingRedirectTimerRef.current = setTimeout(() => {
      router.push(`/?popped=${encodeURIComponent(bubble.title)}`);
    }, 8000);
  }, [bubble.id, bubble.title, router]);

  useEffect(() => {
    briefingModalStartedRef.current = false;
    return () => {
      if (briefingRedirectTimerRef.current) clearTimeout(briefingRedirectTimerRef.current);
    };
  }, [bubble.id, readOnly]);

  useEffect(() => {
    if (bubble.popState !== "POPPED") return;
    if (retentionPolicy === "view-only" && !readOnly) {
      router.replace(`/bubble/${bubble.id}?mode=view`);
      return;
    }
    if (role !== "participant" || retentionPolicy === "view-only") return;
    const timer = window.setTimeout(() => router.replace("/history"), 5000);
    return () => window.clearTimeout(timer);
  }, [bubble.id, bubble.popState, retentionPolicy, role, readOnly, router]);

  // Recover the end-of-session state if the client missed an SSE event.
  useEffect(() => {
    if (!bubble.id) return;
    if (bubble.popState === "POPPED") return;
    if (bubble.popState === "FAILED_EXPORT") return;

    let isMounted = true;
    const refreshPopState = async () => {
      try {
        const status = await getPopStatus(bubble.id);
        if (!isMounted || !status.pop_state) return;
        setBubble((prev) => ({
          ...prev,
          popState: status.pop_state,
          isLive: status.pop_state === "ACTIVE",
          expiryDecisionDeadline: status.expiry_decision_deadline ? new Date(status.expiry_decision_deadline) : undefined,
          viewUntil: status.view_until ? new Date(status.view_until) : prev.viewUntil,
        }));
        if (status.pop_reason) setPopReason(status.pop_reason);
        if (status.retention_policy) setRetentionPolicy(status.retention_policy);
        if (status.pop_state === "POPPED" && !readOnly && role === "host") void loadBriefingModal();
      } catch (err) {
        console.debug("Bubble end-state refresh status:", err);
      }
    };

    void refreshPopState();
    const interval = window.setInterval(refreshPopState, 5000);
    return () => {
      isMounted = false;
      window.clearInterval(interval);
    };
  }, [bubble.id, bubble.popState, loadBriefingModal, readOnly, role]);

  // fetchMessages ref — used by SSE onMessage to trigger an immediate poll
  const fetchMessagesRef = useRef<(() => void) | null>(null);

  // 2. Connect to Backend SSE Stream (/bubbles/{id}/stream)
  useEffect(() => {
    if (!bubble.id || readOnly) return;

    const unsubscribeSSE = subscribeToBubbleStream(bubble.id, {
      onConnected: () => {
        console.info(`Connected to live SSE stream for bubble ${bubble.id}`);
      },
      onMessage: () => {
        // New message arrived — trigger immediate poll instead of adding directly
        // (prevents duplicates: polling is the single source of truth)
        fetchMessagesRef.current?.();
      },
      onMemberJoined: (member) => {
        if (!member) return;
        setBubble((prev) => {
          const exists = prev.members.some((m) => m.id === member.id);
          const updatedMembers = exists
            ? prev.members.map((m) => (m.id === member.id ? { ...m, ...member, isOnline: true } : m))
            : [...prev.members, { ...member, isOnline: true }];
          updatedMembers.sort((a, b) => a.id.localeCompare(b.id));
          return {
            ...prev,
            memberCount: new Set(updatedMembers.filter((m) => m.isOnline !== false).map((m) => m.id)).size,
            members: updatedMembers,
          };
        });
      },
      onMemberLeft: ({ user_id, display_name }) => {
        setBubble((prev) => {
          const members = prev.members.filter((member) => member.id !== user_id);
          return { ...prev, members, memberCount: members.filter((member) => member.isOnline !== false).length };
        });
        setMemberNotice(`${display_name} left the Bubble.`);
      },
      onMemberRemoved: ({ user_id, removed_by_host }) => {
        setBubble((prev) => {
          const members = prev.members.filter((member) => member.id !== user_id);
          return { ...prev, members, memberCount: members.filter((member) => member.isOnline !== false).length };
        });
        if (user_id === user?.uid && removed_by_host) setRemovedByHost(true);
      },
      onAnonymousModeUpdated: ({ enabled }) => {
        setBubble((prev) => ({ ...prev, anonymousModeEnabled: enabled }));
        if (!enabled && user?.uid) {
          window.localStorage.removeItem(`context_bubble_anonymous:${bubble.id}:${user.uid}`);
          setAnonymousPreference(false);
        }
      },
      onToken: (token) => {
        setIsSynthesizing(true);
        setStreamingToken(token);
      },
      onAIToken: () => {},
      onAIComplete: () => {},
      onAIError: () => {},
      onComplete: (intel) => {
        setIsSynthesizing(false);
        setStreamingToken("");
        if (intel) {
          setBubble((prev) => ({
            ...prev,
            intelligence: mergeIntelligence(prev.intelligence, intel),
          }));
        }
      },
      onDelta: (delta) => {
        setIsSynthesizing(false);
        setStreamingToken("");
        if (delta) {
          setBubble((prev) => ({
            ...prev,
            intelligence: mergeIntelligence(prev.intelligence, delta as Partial<Bubble["intelligence"]>),
          }));
        }
      },
      onGraph: (graph) => {
        if (graph && Array.isArray(graph.nodes) && graph.nodes.length) {
          setKnowledgeGraph((previous) => !previous || graph.version >= previous.version ? graph : previous);
        }
      },
      onPresence: (pres) => {
        setBubble((prev) => {
          const byId = new Map(prev.members.map((member) => [member.id, member]));
          if (pres.status === "offline") {
            const existing = byId.get(pres.user_id);
            if (existing) byId.set(pres.user_id, { ...existing, isOnline: false });
          } else {
            const existing = byId.get(pres.user_id);
            byId.set(pres.user_id, existing
              ? { ...existing, name: pres.display_name, isOnline: true }
              : { id: pres.user_id, name: pres.display_name, role: "participant", isOnline: true });
          }
          const members = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
          return { ...prev, members, memberCount: new Set(members.filter((member) => member.isOnline !== false).map((member) => member.id)).size };
        });
        if (pres.is_typing) {
          setTypingUsers((prev) => (prev.includes(pres.display_name) ? prev : [...prev, pres.display_name]));
        } else {
          setTypingUsers((prev) => prev.filter((name) => name !== pres.display_name));
        }
      },
      onPopState: (state, receiptId, reason, policy, message, expiryDecisionDeadline) => {
        setBubble((prev) => ({ ...prev, popState: state, isLive: state === "ACTIVE", expiryDecisionDeadline: expiryDecisionDeadline ? new Date(expiryDecisionDeadline) : undefined }));
        if (reason) setPopReason(reason);
        if (policy) setRetentionPolicy(policy);
        if (message) setPopMessage(message);
        if (state === "POPPED" && !readOnly && role === "host") {
          loadBriefingModal();
        }
      },
    });

    return () => { unsubscribeSSE(); };
  }, [bubble.id, loadBriefingModal, readOnly, role, user?.uid, router]);

  // 3. Subscribe to messages — backend is the single source of truth
  useEffect(() => {
    if (!bubble.id) return;

    const sub = subscribeToBubbleMessages(
      bubble.id,
      (backendMsgs) => {
        setBubble((prev) => {
          // A live room cannot intentionally lose its entire chat feed. Treat an
          // empty polling snapshot as transient while the bubble is still active.
          if (backendMsgs.length === 0 && prev.contributions.length > 0 && prev.popState === "ACTIVE") {
            return prev;
          }
          const now = Date.now();
          const confirmedSignatures = new Set(
            backendMsgs.map((m) => `${m.authorId || m.authorName}:::${(m.text || "").trim()}`)
          );
          const confirmedIds = new Set(backendMsgs.map((m) => m.id));

          // Filter out optimistic contributions that have already been confirmed by the backend
          const stillPending = prev.contributions.filter((c) => {
            if (!c.id.startsWith("c-")) return false;
            if (confirmedIds.has(c.id)) return false;
            const sig = `${c.authorId || c.authorName}:::${(c.text || "").trim()}`;
            if (confirmedSignatures.has(sig)) return false;
            // Discard unconfirmed optimistic messages older than 6 seconds to prevent zombie duplicates
            const ts = c.timestamp instanceof Date ? c.timestamp.getTime() : now;
            if (now - ts > 6000) return false;
            return true;
          });

          // Strictly deduplicate by id and filter out any AI messages from the deliberation feed
          const seen = new Set<string>();
          const deduped: Contribution[] = [];
          for (const item of [...backendMsgs, ...stillPending]) {
            if (item.authorId === "bubble-ai" || item.authorName === "Bubble AI") continue;
            if (!seen.has(item.id)) {
              seen.add(item.id);
              deduped.push(item);
            }
          }

          return {
            ...prev,
            contributions: deduped,
          };
        });
      },
      (err) => { console.debug("Messages sync error:", err); }
    );

    // Expose refresh so SSE onMessage can trigger an immediate poll
    fetchMessagesRef.current = sub.refresh;

    return () => {
      sub.unsubscribe();
      fetchMessagesRef.current = null;
    };
  }, [bubble.id, bubble.popState]);


  // Submit a new contribution
  const handleNewContribution = useCallback(
    (text: string, attachments?: Attachment[]) => {
      if (!bubble.isLive || bubble.popState !== "ACTIVE") return;
      // If user is not authenticated yet, open Auth Modal
      if (!user || !user.displayName) {
        setIsAuthModalOpen(true);
        return;
      }

      const authorDisplayName = anonymousPreference
        ? "Anonymous"
        : initialUserName || user.displayName || "You";

      const authorUid = user.uid;
      const authorAvatar = anonymousPreference
        ? undefined
        : getAvatarUrl(user.uid, authorDisplayName, getSavedAvatarProfile(user.uid).style);

      // 1. Optimistic UI update — append to end (newest at bottom, like WhatsApp)
      const newContribution: Contribution = {
        id: `c-${Date.now()}`,
        authorId: authorUid,
        authorName: authorDisplayName,
        authorAvatar,
        isAnonymous: anonymousPreference,
        authorAnimal: anonymousPreference || getSavedAvatarProfile(user.uid).kind !== "animal"
          ? undefined
          : getSavedAvatarProfile(user.uid).animal,
        text,
        attachments,
        timestamp: new Date(),
      };

      setBubble((prev) => ({
        ...prev,
        contributions: [...prev.contributions, newContribution],
      }));

      // 2. Persist to Firestore & notify backend AI pipeline
      sendMessageToFirestore({
        bubbleId: bubble.id,
        authorId: authorUid,
        authorName: authorDisplayName,
        text,
        isAnonymous: anonymousPreference,
        attachments,
      }).catch((err) => {
        console.warn("Failed to write message:", err);
      });
    },
    [bubble.id, anonymousPreference, bubble.isLive, bubble.popState, initialUserName, user]
  );

  // Refresh knowledge graph
  const handleRefreshGraph = useCallback(() => {
    getKnowledgeGraph(bubble.id)
      .then((g) => {
        if (g && g.nodes?.length) setKnowledgeGraph((previous) => !previous || g.version >= previous.version ? g : previous);
      })
      .catch(() => {});
  }, [bubble.id]);

  const userUid = user?.uid;

  const handleToggleAnonymousPreference = useCallback(() => {
    if (!userUid || !bubble.anonymousModeEnabled) return;
    setAnonymousPreference((prev) => {
      const next = !prev;
      window.localStorage.setItem(`context_bubble_anonymous:${bubble.id}:${userUid}`, String(next));
      return next;
    });
  }, [bubble.id, bubble.anonymousModeEnabled, userUid]);

  const handleToggleAnonymousAvailability = useCallback(async () => {
    const enabled = !bubble.anonymousModeEnabled;
    try {
      await updateAnonymousAvailability(bubble.id, enabled);
      setBubble((prev) => ({ ...prev, anonymousModeEnabled: enabled }));
      if (!enabled) {
        setAnonymousPreference(false);
        if (userUid) window.localStorage.removeItem(`context_bubble_anonymous:${bubble.id}:${userUid}`);
      }
    } catch (err) {
      console.warn("Could not update anonymous availability:", err);
    }
  }, [bubble.id, bubble.anonymousModeEnabled, userUid]);

  const handleLeaveBubble = useCallback(async () => {
    setIsLeavingBubble(true);
    setLeaveError(null);
    try {
      await updatePresence(bubble.id, false, "offline").catch(() => {});
      await leaveBubble(bubble.id);
      router.replace("/");
    } catch (err) {
      setLeaveError(err instanceof Error ? err.message : "Could not leave this bubble. Please try again.");
    } finally {
      setIsLeavingBubble(false);
    }
  }, [bubble.id, router]);

  const handleRemoveParticipant = useCallback(async (participantId: string) => {
    const result = await removeBubbleParticipant(bubble.id, participantId);
    setBubble((prev) => {
      const removedWasOnline = prev.members.some((member) => member.id === participantId && member.isOnline !== false);
      return {
        ...prev,
        joinCode: result.join_code,
        members: prev.members.filter((member) => member.id !== participantId),
        memberCount: Math.max(0, prev.memberCount - (removedWasOnline ? 1 : 0)),
      };
    });
  }, [bubble.id]);

  // Copy Executive Briefing Markdown
  const handleCopyBriefingMarkdown = () => {
    if (!briefing?.markdown_content) return;
    navigator.clipboard.writeText(briefing.markdown_content).then(() => {
      setCopiedBriefing(true);
      setTimeout(() => setCopiedBriefing(false), 2000);
    });
  };

  const isPopped = bubble.popState === "POPPED" || bubble.popState === "SHREDDING" || bubble.popState === "POPPING" || bubble.popState === "EXPORTING" || bubble.popState === "FAILED_EXPORT";

  // Build the appropriate notification message based on pop state, reason, and retention
  const popBanner = (() => {
    if (!isPopped) return null;

    const isTimer = popReason === "timer_expired";
    const isPermanent = retentionPolicy === "permanent";
    const isPlusRecord = retentionPolicy === "temporary-plus-record";

    let icon = "⏱️";
    let title = "";
    let detail = popMessage || "";
    let color = "amber";

    if (bubble.popState === "POPPING") {
      icon = "⏱️";
      title = isTimer ? "Time's up — popping bubble..." : "Host initiated pop...";
      detail = "Generating executive briefing and exporting records. Please wait.";
      color = "amber";
    } else if (bubble.popState === "EXPORTING") {
      icon = "📤";
      title = "Exporting executive briefing...";
      detail = "Delivering records to configured destinations (Slack, Notion, Linear, Jira).";
      color = "blue";
    } else if (bubble.popState === "SHREDDING") {
      icon = "🔐";
      title = "Crypto-shredding session data...";
      detail = retentionPolicy === "view-only"
        ? "Removing uploaded documents while retaining chat and intelligence for read-only access."
        : isPermanent ? "Not shredding — permanent retention." : "Session content is being permanently destroyed.";
      color = "rose";
    } else if (bubble.popState === "POPPED") {
      icon = isTimer ? "⏱️" : "💥";
      title = isTimer ? "This bubble's timer has expired" : "This bubble has been popped";
      if (!detail) {
        if (retentionPolicy === "view-only") {
          detail = bubble.viewUntil
            ? `This bubble is read-only. Chat and intelligence remain available until ${bubble.viewUntil.toLocaleDateString()}; uploaded documents were removed.`
            : "This bubble is read-only. Chat and intelligence are retained; uploaded documents were removed.";
        } else if (isPermanent) {
          detail = "All session data is retained for permanent reference.";
        } else if (isPlusRecord) {
          detail = "Session data has been crypto-shredded. Executive briefing and export records are retained.";
        } else {
          detail = "All session data has been permanently crypto-shredded. Executive records have been exported.";
        }
      }
      color = "rose";
    } else if (bubble.popState === "FAILED_EXPORT") {
      icon = "⚠️";
      title = "Export did not complete";
      detail = popMessage || "The session data is preserved. The host can review the export settings and retry.";
      color = "amber";
    }

    const colorClasses: Record<string, { bg: string; border: string; text: string }> = {
      amber: { bg: "bg-amber-950/80", border: "border-amber-500/40", text: "text-amber-200" },
      blue:  { bg: "bg-blue-950/80",  border: "border-blue-500/40",  text: "text-blue-200" },
      rose:  { bg: "bg-rose-950/80",  border: "border-rose-500/40",  text: "text-rose-200" },
    };
    const c = colorClasses[color] || colorClasses.rose;

    return (
      <div className={`${c.bg} ${c.border} border-b px-5 py-2.5 flex items-center justify-between text-xs ${c.text} shrink-0`}>
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="text-base shrink-0">{icon}</span>
          <div className="min-w-0">
            <strong className="block">{title}</strong>
            <span className="opacity-90 text-[11px]">{detail}</span>
          </div>
        </div>
      </div>
    );
  })();

  return (
    <div className="flex flex-col h-screen bg-[#0d0f1a] text-slate-100 overflow-hidden selection:bg-violet-500/30">
      <Header
        bubble={bubble}
        role={readOnly ? "participant" : role}
        onOpenManage={() => setIsManageOpen(true)}
        onLeave={role === "participant" && !readOnly ? () => { setLeaveError(null); setShowLeaveConfirmation(true); } : undefined}
        hideTimer={readOnly}
        readOnly={readOnly}
      />

      {memberNotice && <div role="status" className="fixed left-1/2 top-16 z-50 -translate-x-1/2 rounded-xl border border-white/15 bg-[#111827] px-4 py-3 text-sm text-slate-100 shadow-xl">
        <span aria-hidden="true" className="mr-2">👋</span>{memberNotice}
      </div>}

      {removedByHost && <div className="fixed inset-0 z-[100] grid place-items-center bg-black/80 p-5 backdrop-blur-sm">
        <section role="alertdialog" aria-modal="true" aria-labelledby="removed-title" className="w-full max-w-md rounded-2xl border border-rose-500/30 bg-[#111827] p-6 shadow-2xl">
          <h2 id="removed-title" className="text-lg font-bold text-white">You were removed by the host</h2>
          <p className="mt-2 text-sm leading-relaxed text-slate-300">You no longer have access to this Bubble. Refreshing the page will not let you rejoin.</p>
          <button type="button" onClick={() => router.replace("/")} className="mt-5 w-full rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-500">Return to home</button>
        </section>
      </div>}

      {/* Upfront Auth Gate if not signed in */}
      {!authLoading && (!user || !user.displayName) && (
        <AuthModal
          isOpen={true}
          title="Sign In to Enter Bubble"
          subtitle={`Please sign in beforehand to join deliberation in "${bubble.title}".`}
          onSuccess={(signedInUser) => {
            setIsAuthModalOpen(false);
            if (bubble.hostId && bubble.hostId === signedInUser.uid) {
              setRole("host");
            } else {
              setRole("participant");
              // Register participant with backend
              joinBubble(bubble.id, {
                display_name: signedInUser.displayName || "Participant",
                join_code: joinCode,
                avatar_url: signedInUser.photoURL || undefined,
              }).catch((err) => {
                if (String(err?.message || "").toLowerCase().includes("removed by the host")) setRemovedByHost(true);
              });
            }
          }}
        />
      )}

      {/* Auth Modal Triggered from Header */}
      {isAuthModalOpen && (
        <AuthModal
          isOpen={true}
          onClose={() => setIsAuthModalOpen(false)}
          title="Switch Account / Identity"
          subtitle="Change your active profile to test Host vs Participant workflows."
          onSuccess={(signedInUser) => {
            setIsAuthModalOpen(false);
            if (bubble.hostId && bubble.hostId === signedInUser.uid) {
              setRole("host");
            } else {
              setRole("participant");
            }
          }}
        />
      )}

      {/* Pop State Banner — shown during all pop stages with appropriate message */}
      {popBanner}
      {readOnly && retentionPolicy === "view-only" && (
        <div className="border-b border-violet-500/20 bg-violet-950/40 px-4 py-2 text-center text-xs text-violet-200">
          Read-only bubble{bubble.viewUntil ? ` · available until ${bubble.viewUntil.toLocaleDateString()}` : ""}. Chat and intelligence are preserved; uploaded documents were removed.
        </div>
      )}
      {bubble.popState === "EXPIRY_PENDING" && role === "participant" && (
        <div className="border-b border-amber-500/20 bg-amber-950/30 px-4 py-2 text-center text-xs text-amber-100">
          The timer expired. Chat is paused while the host decides whether to extend or end the bubble. Returning home in {graceSeconds ?? 15}s.
        </div>
      )}

      {/* Main two-column layout */}
      <main className="flex-1 flex gap-0 overflow-hidden px-4 py-4 min-h-0">
        {/* Left: Live Deliberation Feed */}
        <div className="flex-1 min-w-0 flex flex-col bg-[#0f1525] rounded-2xl border border-white/5 p-4 mr-3 overflow-hidden shadow-xl">
          <ContributionFeed
            bubbleId={bubble.id}
            contributions={bubble.contributions}
            isAnonymous={anonymousPreference}
            isLive={!readOnly && bubble.isLive && bubble.popState === "ACTIVE"}
            hideAttachments={retentionPolicy === "view-only"}
            onToggleAnonymous={bubble.anonymousModeEnabled ? handleToggleAnonymousPreference : undefined}
            typingUsers={typingUsers}
            onNewContribution={handleNewContribution}
          />

        </div>

        {/* Right: Live Intelligence & Knowledge Graph */}
        <div className="w-[450px] shrink-0 flex flex-col bg-[#0f1525] rounded-2xl border border-white/5 p-4 overflow-hidden shadow-xl">
          <LiveIntelligencePanel
            intelligence={bubble.intelligence}
            knowledgeGraph={knowledgeGraph}
            contributions={bubble.contributions}
            bubbleTitle={bubble.title}
            streamingToken={streamingToken}
            isSynthesizing={isSynthesizing}
            onRefreshGraph={handleRefreshGraph}
          />
        </div>
      </main>

      {bubble.popState === "EXPIRY_PENDING" && role === "host" && !readOnly && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-black/75 p-4 backdrop-blur-sm">
          <section className="w-full max-w-lg rounded-2xl border border-amber-500/30 bg-[#111827] p-6 shadow-2xl">
            <p className="text-xs font-semibold uppercase tracking-wider text-amber-300">Bubble time expired</p>
            <h2 className="mt-2 text-xl font-bold text-white">Continue the bubble?</h2>
            <p className="mt-2 text-sm text-slate-400">You have {graceSeconds ?? 15} seconds to extend it. Otherwise, choose how to wrap up and what attendees can keep.</p>
            {expiryError && <p className="mt-3 rounded-lg bg-rose-950/40 p-2 text-xs text-rose-200">{expiryError}</p>}
            <div className="mt-5 flex flex-col gap-2 sm:flex-row">
              <button type="button" onClick={handleExtendFromExpiry} disabled={isExtendingExpiry} className="cursor-pointer flex-1 rounded-xl bg-violet-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">{isExtendingExpiry ? "Extending…" : "Extend 15 minutes"}</button>
              <button type="button" onClick={() => router.push(`/bubble/${bubble.id}/end?reason=expired`)} className="cursor-pointer flex-1 rounded-xl border border-white/10 px-4 py-3 text-sm font-semibold text-slate-200">End bubble</button>
            </div>
          </section>
        </div>
      )}

      {/* Host-only: Manage Bubble overlay */}
      {role === "host" && isManageOpen && (
        <ManageBubblePanel
          bubble={bubble}
          onClose={() => setIsManageOpen(false)}
          onToggleAnonymous={handleToggleAnonymousAvailability}
          onBubbleUpdated={(updated) => setBubble((prev) => ({ ...prev, ...updated }))}
          onRemoveParticipant={handleRemoveParticipant}
          onBubblePopped={(state) => {
            setBubble((prev) => ({ ...prev, popState: state, isLive: state === "ACTIVE" }));
            if (state === "POPPED") loadBriefingModal();
          }}
        />
      )}

      {/* Executive Briefing Record Modal */}
      {showBriefingModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-4">
          <div className="bg-[#111827] border border-violet-500/30 rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-y-auto p-6 shadow-2xl flex flex-col gap-5">
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-violet-600/20 border border-violet-500/30 flex items-center justify-center text-violet-400 text-xl">
                  📋
                </div>
                <div>
                  <h3 className="text-white font-bold text-lg">Executive Decision Briefing</h3>
                  <p className="text-slate-400 text-xs">Generated upon session pop and exported to destinations</p>
                </div>
              </div>
              <div className="flex flex-col items-end gap-1">
                <button
                  onClick={() => {
                    setShowBriefingModal(false);
                    router.push("/");
                  }}
                  className="text-slate-400 hover:text-white text-sm"
                >
                  ✕
                </button>
                <span className="text-[10px] text-slate-500 animate-pulse">Redirecting to home…</span>
              </div>
            </div>

            {/* Summary — real data from backend */}
            <div className="rounded-xl bg-[#161d2e] border border-white/10 p-4">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-violet-300 mb-1.5">
                Executive Synthesis
              </h4>
              <p className="text-sm text-slate-200 leading-relaxed">
                {briefing?.executive_summary || bubble.intelligence.summary || "Session deliberation completed and exported."}
              </p>
            </div>

            {/* Decisions */}
            {briefing?.decisions && briefing.decisions.length > 0 && (
              <div className="flex flex-col gap-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-emerald-300">Decisions Made</h4>
                <ul className="flex flex-col gap-1.5">
                  {briefing.decisions.map((d, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs text-slate-200 bg-[#161d2e] rounded-lg p-2.5 border border-white/5">
                      <span className="text-emerald-400 font-bold shrink-0">✓</span>
                      <span>{d}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Points of Consensus */}
            {briefing?.consensus_points && briefing.consensus_points.length > 0 && (
              <div className="flex flex-col gap-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-cyan-300">Points of Consensus</h4>
                <ul className="flex flex-col gap-1.5">
                  {briefing.consensus_points.map((c, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs text-slate-200 bg-[#161d2e] rounded-lg p-2.5 border border-white/5">
                      <span className="text-cyan-400 font-bold shrink-0">🤝</span>
                      <span>{c}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Identified Blockers */}
            {briefing?.blockers && briefing.blockers.length > 0 && (
              <div className="flex flex-col gap-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-rose-300">Identified Blockers</h4>
                <ul className="flex flex-col gap-1.5">
                  {briefing.blockers.map((b, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs text-slate-200 bg-rose-950/20 rounded-lg p-2.5 border border-rose-500/20">
                      <span className="text-rose-400 font-bold shrink-0">⚠️</span>
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Action Items */}
            {briefing?.action_items && briefing.action_items.length > 0 && (
              <div className="flex flex-col gap-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                  Action Items
                </h4>
                <div className="flex flex-col gap-2">
                  {briefing.action_items.map((item, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between rounded-xl bg-[#161d2e] border border-white/5 p-3 text-xs"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-emerald-400 font-bold shrink-0">✓</span>
                        <span className="text-slate-200 truncate">{item.task}</span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 ml-2">
                        {item.owner && (
                          <span className="px-2 py-0.5 rounded bg-violet-900/40 text-violet-300 font-medium">
                            {item.owner}
                          </span>
                        )}
                        <span className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded border ${
                          item.priority === "high" || item.priority === "critical"
                            ? "text-rose-400 bg-rose-950/40 border-rose-500/20"
                            : "text-amber-400 bg-amber-950/40 border-amber-500/20"
                        }`}>
                          {item.priority}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Disagreements */}
            {briefing?.disagreements && briefing.disagreements.length > 0 && (
              <div className="flex flex-col gap-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-amber-300">
                  Unresolved Disagreements
                </h4>
                <div className="flex flex-col gap-2">
                  {briefing.disagreements.map((dis, idx) => (
                    <div
                      key={idx}
                      className="rounded-xl bg-amber-950/20 border border-amber-500/20 p-3 text-xs flex flex-col gap-1"
                    >
                      <span className="font-semibold text-amber-300">{dis.topic}</span>
                      <p className="text-slate-300">
                        {dis.perspective_a} <em>vs</em> {dis.perspective_b}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Knowledge Graph Synthesis */}
            {briefing?.graph_summary && (briefing.graph_summary.total_nodes > 0 || briefing.graph_summary.key_relationships.length > 0) && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-indigo-300">
                    Knowledge Graph Synthesis
                  </h4>
                  <span className="text-[11px] text-slate-400">
                    {briefing.graph_summary.total_nodes} entities · {briefing.graph_summary.total_edges} connections
                  </span>
                </div>
                {briefing.graph_summary.key_relationships.length > 0 && (
                  <ul className="flex flex-col gap-1.5">
                    {briefing.graph_summary.key_relationships.slice(0, 5).map((rel, i) => (
                      <li key={i} className="flex items-start gap-2 text-xs text-slate-300 bg-indigo-950/20 rounded-lg p-2.5 border border-indigo-500/20">
                        <span className="text-indigo-400 font-bold shrink-0">☍</span>
                        <span>{rel}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}


            {/* Actions */}
            <div className="flex items-center justify-between pt-3 border-t border-white/10">
              <span className="text-xs text-slate-500">
                Cryptographically shredded &amp; exported
              </span>
              <div className="flex items-center gap-2">
                {briefing?.markdown_content && (
                  <button
                    onClick={handleCopyBriefingMarkdown}
                    className="px-3.5 py-2 rounded-xl bg-[#161d2e] hover:bg-[#1a2236] border border-white/10 text-xs font-medium text-slate-200 transition-colors"
                  >
                    {copiedBriefing ? "✓ Copied!" : "Copy Markdown"}
                  </button>
                )}
                <button
                  onClick={() => {
                    setShowBriefingModal(false);
                    router.push("/");
                  }}
                  className="px-4 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-xs font-semibold text-white transition-colors"
                >
                  Go Home
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {showLeaveConfirmation && <ConfirmDialog
        title="Leave this bubble?"
        description="You’ll leave the live discussion and won’t appear in its active participant list. You can rejoin later if the host hasn’t removed you."
        confirmLabel="Leave bubble"
        busy={isLeavingBubble}
        error={leaveError}
        onCancel={() => { setShowLeaveConfirmation(false); setLeaveError(null); }}
        onConfirm={handleLeaveBubble}
      />}
    </div>
  );
}
