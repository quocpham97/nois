// Bridge surface the Capacitor mobile shell exposes on `window.mobile`.
// Deliberately the SAME contract as `window.desktop` (see desktop.d.ts): both
// are "native shell" bridges around the identical remote web app, so shared
// call sites go through getShellBridge() (src/lib/shell.ts) and never branch on
// which shell they're in. Absent in a plain browser, so every use must be
// guarded; all mobile behavior is a strict no-op on the web.
//
// Unlike Electron, Capacitor has no separate main process: the shell logic runs
// in THIS web context against the injected `window.Capacitor` global (see the
// minimal typing below), so the bridge is set up client-side by
// src/lib/mobile/capacitor-bridge.ts when Capacitor.isNativePlatform() is true.
export {};

declare global {
  interface Window {
    mobile?: {
      /** Start the system-browser Google login handoff (Browser plugin). */
      startLogin(): void;
      /** Show a local OS notification; tapping it opens the channel. */
      notify(n: { title: string; body: string; channelId: string }): void;
      /** Subscribe to notification/push-tap channel opens. Returns unsubscribe. */
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
      /** Native app version (from @capacitor/app getInfo). */
      version: string;
    };

    // Minimal shape of the runtime global Capacitor injects into the WebView.
    // We drive plugins through this rather than importing @capacitor/* so the
    // web bundle carries no Capacitor dependency and resolves cleanly on the
    // pure-browser build (the global is simply undefined there).
    Capacitor?: {
      isNativePlatform(): boolean;
      getPlatform(): "ios" | "android" | "web";
      Plugins: Record<string, Record<string, (...args: unknown[]) => unknown>>;
    };
  }
}
