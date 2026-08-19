"use client";

/** Compact live connection indicator for the sidebar footer. */
import { useShallow } from "zustand/react/shallow";
import { useSessionStore, type ConnectionStatus as Status } from "@/stores/session-store";

const STATUS_META: Record<Status, { label: string; color: string }> = {
  connecting: { label: "Connecting…", color: "var(--app-yellow)" },
  connected: { label: "Connected", color: "var(--app-green)" },
  reconnecting: { label: "Reconnecting…", color: "var(--app-yellow)" },
  disconnected: { label: "Offline", color: "var(--app-faint)" },
};

export function ConnectionStatus() {
  const { status, latencyMs } = useSessionStore(
    useShallow((s) => ({ status: s.status, latencyMs: s.latencyMs })),
  );
  const meta = STATUS_META[status];
  return (
    <div
      className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] text-app-muted"
      title={
        status === "connected" && latencyMs != null
          ? `WebSocket connected · ${latencyMs}ms`
          : meta.label
      }
    >
      <span
        className="size-[7px] shrink-0 rounded-full"
        style={{ background: meta.color }}
      />
      <span>{meta.label}</span>
      {status === "connected" && latencyMs != null && (
        <span className="font-mono text-app-faint">· {latencyMs}ms</span>
      )}
    </div>
  );
}
