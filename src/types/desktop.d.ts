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
      /** Shell app version. */
      version: string;
    };
  }
}
