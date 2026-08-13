"use client";

import { useMemo } from "react";
import { Phone, Video } from "lucide-react";
import { useChat } from "../chat/chat-context";
import { useCall } from "../chat/call-context";
import { Avatar } from "../chat/bits";
import { presenceColor } from "@/lib/chat-data";

// Calls tab. The design shows a call-history list. This surfaces the real,
// actionable thing instead: your DM contacts with one-tap voice/video call,
// using the same useCall().startCall the conversation header uses.
//
// It was written when nothing about a call was persisted. Finished calls now DO
// leave a record — a CallEvent row in the DM thread (see docs/calls.md) — so a
// real history list here is now possible: it would read the call rows out of the
// message store rather than needing anything new server-side. Deliberately not
// done yet; this tab still lists contacts, not calls.
export function CallsScreen() {
  const { groups, dmOrder } = useChat();
  const { startCall, call } = useCall();
  const inCall = call != null;

  const dms = useMemo(
    () => dmOrder.map((id) => groups[id]).filter((ch) => ch?.user),
    [groups, dmOrder],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="px-[18px] pb-2.5 pt-1">
        <h1 className="m-0 text-[26px] font-extrabold tracking-[-0.02em] text-app-text">
          Calls
        </h1>
      </div>

      <div className="app-scroll flex-1 overflow-y-auto px-2 pb-3 pt-1">
        <div className="px-3 pb-2 pt-1 text-[13px] font-bold uppercase tracking-[0.04em] text-app-muted">
          Start a call
        </div>
        {dms.length === 0 ? (
          <div className="px-4 py-10 text-center text-[13.5px] text-app-muted">
            No one to call yet — start a direct message first.
          </div>
        ) : (
          dms.map((ch) => (
            <div
              key={ch.id}
              className="flex items-center gap-3 rounded-2xl px-2.5 py-2"
            >
              <span className="relative shrink-0">
                <Avatar
                  initials={ch.user!.initials}
                  bg={ch.user!.bg}
                  src={ch.user!.avatar}
                  size={50}
                />
                <span
                  className="absolute -bottom-px -right-px size-[13px] rounded-full border-[2.5px] border-app-bg"
                  style={{ background: presenceColor(ch.presence) }}
                />
              </span>
              <div className="min-w-0 flex-1 truncate text-[16px] font-semibold text-app-text">
                {ch.user!.name}
              </div>
              <button
                onClick={() => void startCall(ch.id, false)}
                disabled={inCall}
                aria-label={`Voice call ${ch.user!.name}`}
                className="flex size-10 shrink-0 items-center justify-center rounded-full bg-panel text-app-accent disabled:opacity-40"
              >
                <Phone size={19} strokeWidth={1.9} />
              </button>
              <button
                onClick={() => void startCall(ch.id, true)}
                disabled={inCall}
                aria-label={`Video call ${ch.user!.name}`}
                className="flex size-10 shrink-0 items-center justify-center rounded-full bg-panel text-app-accent disabled:opacity-40"
              >
                <Video size={20} strokeWidth={1.9} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
