/* global fetch, Response */
/*
 * Weir's service worker. It shows the reminders the API pushes, the day before a payment and when
 * one fails, and opens Your payments when one is tapped. It caches nothing: when a page cannot load
 * at all, it answers with a short offline page instead of the browser's error, since moving money
 * needs a connection anyway.
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const OFFLINE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Weir</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f0ed;color:#18161b;
font:16px/1.5 system-ui,sans-serif;text-align:center;padding:24px}h1{font-weight:400;font-size:28px;margin:0 0 8px}p{color:rgba(24,22,27,.6);margin:0 0 20px}
button{border:0;border-radius:999px;background:#18161b;color:#fff;font:inherit;padding:12px 22px}</style></head>
<body><main><h1>You're offline</h1><p>Weir needs a connection to show and move your money.</p>
<button onclick="location.reload()">Try again</button></main></body></html>`;

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(() => new Response(OFFLINE, { headers: { "content-type": "text/html; charset=utf-8" } })),
  );
});

self.addEventListener("push", (event) => {
  let reminder = {};
  try {
    reminder = event.data ? event.data.json() : {};
  } catch {
    reminder = {};
  }
  event.waitUntil(
    self.registration.showNotification(reminder.title || "Weir", {
      body: reminder.body || "",
      tag: reminder.tag,
      icon: "/favicon.svg",
      badge: "/favicon.svg",
      data: { url: reminder.url || "/payments" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/payments", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => client.url.startsWith(self.location.origin));
      if (open) return open.navigate(url).then((client) => (client ?? open).focus());
      return self.clients.openWindow(url);
    }),
  );
});
