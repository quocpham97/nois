"use client";

/**
 * Unsent composer drafts, persisted per user in localStorage. The store owns the
 * drafts map and its save/clear transitions; this hook only mirrors it to disk
 * and hydrates it when the viewer id becomes known (or changes, e.g. an account
 * switch).
 */
import { useEffect } from "react";
import { chat, useChatStore } from "@/stores/chat-store";
import type { Draft } from "../lib/types";

export function useDrafts({ userId }: { userId: string }) {
  const drafts = useChatStore((s) => s.drafts);

  useEffect(() => {
    if (!userId) return;
    try {
      const d = localStorage.getItem(`chat:drafts:${userId}`);
      chat().setDrafts(d ? (JSON.parse(d) as Record<string, Draft>) : {});
    } catch {
      chat().setDrafts({});
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    try {
      localStorage.setItem(`chat:drafts:${userId}`, JSON.stringify(drafts));
    } catch {}
  }, [userId, drafts]);
}
