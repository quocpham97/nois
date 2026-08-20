"use client";

// Enable/disable "notifications on this device", and keep the registration
// healthy. Two implementations behind one surface, because the settings panel
// shouldn't care which shell it's in:
//
//   * browser / Electron → Web Push. Register the service worker, request
//     permission (only from a user gesture — never auto-prompt), subscribe with
//     the server's VAPID public key, POST the subscription.
//   * Capacitor shell → the native bridge (APNs/FCM). WKWebView and the Android
//     WebView have no Push API at all, so the web path below reports
//     "unsupported" there; the shell implements pushState/setPushEnabled
//     instead (src/lib/mobile/capacitor-bridge.ts).

import { getShellBridge } from "./shell";

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Did the user turn push ON on this device? Device-scoped, like the browser
 * permission and the PushSubscription themselves. syncPush() needs it to tell
 * "the browser dropped our subscription" (re-create it) from "the user switched
 * it off" (leave it alone) — both of which look identical from the outside:
 * permission granted, no subscription.
 */
const INTENT_KEY = "chat:push:enabled";

function setIntent(on: boolean): void {
  try {
    localStorage.setItem(INTENT_KEY, on ? "1" : "0");
  } catch {
    // Private mode with storage blocked: syncPush just won't self-heal here.
  }
}

function wantsPush(): boolean {
  try {
    return localStorage.getItem(INTENT_KEY) === "1";
  } catch {
    return false;
  }
}

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export type PushState = "unsupported" | "denied" | "enabled" | "disabled";

export async function currentPushState(): Promise<PushState> {
  const shell = getShellBridge();
  if (shell?.pushState) return shell.pushState();
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? "enabled" : "disabled";
}

/** Register the SW, prompt, subscribe, and persist. Returns the resulting
 *  state. MUST be called from a click handler (permission prompt requirement). */
export async function enablePush(): Promise<PushState> {
  const shell = getShellBridge();
  if (shell?.setPushEnabled) return shell.setPushEnabled(true);
  if (!pushSupported()) return "unsupported";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm === "denied" ? "denied" : "disabled";

  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;

  const { publicKey } = await fetch("/api/push/vapid").then((r) => r.json());
  if (!publicKey) return "disabled";

  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sub.toJSON()),
  });
  setIntent(true);
  return "enabled";
}

/**
 * Keep this device's push registration healthy. Runs on every load rather than
 * from a gesture, so it must never prompt — it acts only where permission is
 * ALREADY granted.
 *
 * Three things heal here:
 *   * the service worker is registered even for someone who never enabled push,
 *     so notify.ts can raise banners through it and a click can deep-link;
 *   * an existing subscription is re-POSTed. The endpoint is the primary key, so
 *     this both restores a row lost server-side AND rebinds the device to
 *     whoever is signed in now — without it, a shared browser keeps delivering
 *     the previous account's notifications to the new one;
 *   * a subscription the browser retired while the page was closed (the
 *     pushsubscriptionchange nobody was there to receive) is minted again.
 */
export async function syncPush(): Promise<PushState> {
  const shell = getShellBridge();
  // A native shell refreshes its own token at launch (it has to — tokens rotate
  // while the app is closed), so there is nothing to heal from here.
  if (shell?.pushState) return shell.pushState();
  if (!pushSupported()) return "unsupported";
  let reg: ServiceWorkerRegistration;
  try {
    reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
  } catch {
    return "unsupported";
  }
  if (Notification.permission !== "granted") {
    return Notification.permission === "denied" ? "denied" : "disabled";
  }

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    // Permission granted with no subscription is ambiguous — only the recorded
    // intent says whether to bring it back or respect an explicit "off".
    if (!wantsPush()) return "disabled";
    const publicKey = await fetch("/api/push/vapid")
      .then((r) => (r.ok ? (r.json() as Promise<{ publicKey?: string }>) : null))
      .then((j) => j?.publicKey)
      .catch(() => undefined);
    if (!publicKey) return "disabled";
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }
  await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sub.toJSON()),
  });
  setIntent(true);
  return "enabled";
}

export async function disablePush(): Promise<PushState> {
  const shell = getShellBridge();
  if (shell?.setPushEnabled) return shell.setPushEnabled(false);
  if (!pushSupported()) return "unsupported";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await fetch("/api/push/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    await sub.unsubscribe();
  }
  setIntent(false);
  return "disabled";
}
