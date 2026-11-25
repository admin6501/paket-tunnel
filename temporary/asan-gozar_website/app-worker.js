self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).catch(() => new Response(
    '<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>فروشگاه</title><main><h1>ارتباط با فروشگاه برقرار نشد</h1><p>اتصال اینترنت را بررسی کنید و <a href="/account.html">دوباره تلاش کنید</a>.</p></main></html>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
  )));
});

function appTarget(value) {
  const link = new URL('/account.html', self.location.origin);
  if (typeof value === 'string' && /^\/account\.html(?:\?staffTicket=[1-9]\d*#tickets|\?receipt=(?:order|topup):[1-9]\d*#receipts)?$/.test(value)) {
    return new URL(value, link).href;
  }
  return link.href;
}

self.addEventListener('push', event => {
  let message;
  try { message = event.data?.json(); } catch { return; }
  if (typeof message?.title !== 'string' || !/^store-push-\d+$/.test(message.tag)) return;
  event.waitUntil(self.registration.showNotification(message.title, {
    body: 'برای مشاهده، برنامهٔ فروشگاه را باز کنید.',
    icon: '/app-icon-192.png', dir: 'rtl', lang: 'fa', tag: message.tag,
    data: { path: appTarget(message.path) },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const path = new URL(event.notification.data?.path || '/account.html', self.location.origin);
  const url = appTarget(path.origin === self.location.origin ? path.pathname + path.search + path.hash : '');
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const same = windows.find(window => window.url === url);
    if (same) return same.focus();
    const window = windows.find(window => new URL(window.url).pathname === '/account.html');
    if (window) {
      const navigated = await window.navigate(url).catch(() => null);
      if (navigated) return navigated.focus();
    }
    return self.clients.openWindow(url);
  })());
});
