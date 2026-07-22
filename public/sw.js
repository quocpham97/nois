// Service worker for Web Push. Messages are E2EE, so the server can't put any
// content in the push — the payload carries only server-known routing metadata
// (channel + sender display name). The notification is intentionally generic
// ("New message from Alice"); the real content is only ever decrypted in the
// page. Clicking focuses an open tab (deep-linking the channel) or opens one.

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
