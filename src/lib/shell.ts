// Native-shell abstraction shared by the Electron desktop shell (window.desktop,
// desktop/src/preload.ts) and the Capacitor mobile shell (window.mobile,
// src/lib/mobile/capacitor-bridge.ts). Both expose the identical bridge
// contract, so call sites that want "the native shell, whichever it is" go
// through getShellBridge() instead of naming one. Returns undefined in a plain
// browser, where every shell behavior is a no-op.
//
// The two bridges intentionally do NOT coexist: a given build is either the
// desktop shell or the mobile shell, never both. If that ever changes, desktop
// wins here only by listing order — pick deliberately at that point.

type ShellBridge = NonNullable<Window["desktop"] | Window["mobile"]>;

export function getShellBridge(): ShellBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return window.desktop ?? window.mobile;
}

/** True inside either native shell (used to key shell-only UI and copy). */
export function inShell(): boolean {
  return getShellBridge() !== undefined;
}
