// The cockpit's service worker. It does ONE job: show a Web Push notification
// and open the right agent on tap. No fetch handler, no cache: the cockpit is a
// live view of running agents, and an offline copy of it would be a lie.
//
// Served from the root so its scope is the whole cockpit. Plain script (a
// module service worker is not supported everywhere iOS matters).
// Design: docs/superpowers/specs/2026-11-16-web-push-design.md.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // An unreadable payload still has to show SOMETHING: Safari revokes the
    // subscription of a site whose pushes display nothing.
  }
  const title = typeof data.title === "string" && data.title ? data.title : "shadok-ai";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "",
      // Same tag = the new notification REPLACES the agent's previous one.
      tag: typeof data.tag === "string" ? data.tag : "shadok",
      // …and still buzzes, otherwise a replacement arrives silently.
      renotify: true,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: typeof data.url === "string" ? data.url : "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin);
  // Only ever our own origin: the URL came through a push payload.
  if (target.origin !== self.location.origin) return;
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = wins.find((w) => new URL(w.url).origin === target.origin);
      if (open) {
        // An open cockpit keeps its state: tell it which agent to show
        // rather than reloading it onto a new URL.
        await open.focus();
        open.postMessage({ type: "shadok-open", hash: target.hash });
        return;
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});
