// Bridge surface the Electron preload exposes (desktop/src/preload.ts).
// Absent in a plain browser, so every use must be `window.desktop?.`-guarded;
// all desktop behavior is a strict no-op on the web.
export {};

declare global {
  interface Window {
    desktop?: {
      /** Start the system-browser Google login handoff. */
      startLogin(): void;
      /** Show a native notification; clicking it focuses the app and opens the channel. */
      notify(n: { title: string; body: string; channelId: string }): void;
      /** Subscribe to notification-click channel opens. Returns unsubscribe. */
      onOpenChannel(cb: (channelId: string) => void): () => void;
      /** Reflect the unread count on the dock/taskbar icon; 0 clears it.
       *  Optional: a shell binary built before this existed won't have it, so
       *  every call site must optional-call it. */
      setBadge?(count: number): void;
      /** Native push (mobile only): the shell's own permission/registration
       *  state, and the switch for it — so the settings toggle drives APNs/FCM
       *  in a shell and Web Push in a browser through one call site
       *  (src/lib/push.ts). The union mirrors PushState there. Optional: a
       *  shell with no native push, or one built before this, won't have them. */
      pushState?(): Promise<"unsupported" | "denied" | "enabled" | "disabled">;
      setPushEnabled?(
        on: boolean,
      ): Promise<"unsupported" | "denied" | "enabled" | "disabled">;
      /** Shell app version. */
      version: string;
    };
  }
}
