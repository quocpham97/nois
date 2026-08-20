// Service worker for Web Push. Messages are E2EE, so the server can't put any
// content in the push — the payload carries only server-known routing metadata
// (channel + sender display name). The notification is intentionally generic
// ("New message from Alice"); the real content is only ever decrypted in the
// page. Clicking focuses an open tab (deep-linking the channel) or opens one.
//
// This covers a device with NO live socket. A tab that is merely backgrounded
// is "online" as far as the server can tell, so its banner is raised by the page
// itself (src/lib/notify.ts), and a native push the server composes for
// iOS/Android. All of them say the same thing: src/lib/notif-copy.ts is the
// source, mirrored below because a service worker can't import it.

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const sender = data.senderName || "Someone";
  const inChannel = data.channelName ? ` in ${data.channelName}` : "";
  const title = data.channelName ? `New message${inChannel}` : `New message from ${sender}`;
  const body = data.channelName ? `${sender} sent a message` : "Tap to read";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      // Collapse repeated pushes for the same channel into one notification.
      tag: data.channelId ? "ch:" + data.channelId : undefined,
      renotify: !!data.channelId,
      data: { channelId: data.channelId || null },
    }),
  );
});

// Mirror of urlBase64ToUint8Array in src/lib/push.ts — a service worker is its
// own script and can't import from the bundle.
function vapidKeyBytes(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function postJson(url, body) {
  // Same-origin fetch carries the session cookie, which these routes require.
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// A browser can retire a subscription on its own — key rotation, storage
// pressure, a browser update — and this event is the ONLY notice. Unhandled, the
// device goes quiet forever while the server keeps sending to a dead endpoint
// (until a 410 finally prunes it). The page may well be closed, so the repair
// has to happen here.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const oldEndpoint = event.oldSubscription?.endpoint;
      let sub = event.newSubscription;
      if (!sub) {
        // No replacement handed to us: mint one against the server's key.
        const key = await fetch("/api/push/vapid")
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => j && j.publicKey)
          .catch(() => null);
        if (!key) return;
        sub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: vapidKeyBytes(key),
        });
      }
      await postJson("/api/push/subscribe", sub.toJSON());
      // Retire the dead row rather than leaving the server to discover it.
      if (oldEndpoint && oldEndpoint !== sub.endpoint) {
        await postJson("/api/push/unsubscribe", { endpoint: oldEndpoint });
      }
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const channelId = event.notification.data?.channelId;
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of clientList) {
        // Focus an existing tab and let the app deep-link (it listens for this).
        if ("focus" in client) {
          await client.focus();
          client.postMessage({ type: "open-channel", channelId });
          return;
        }
      }
      // No open tab — open one at the channel deep link.
      const url = channelId ? "/?channel=" + encodeURIComponent(channelId) : "/";
      if (self.clients.openWindow) await self.clients.openWindow(url);
    })(),
  );
});
