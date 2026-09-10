// SocialNexus Service Worker
// If you ALREADY have an sw.js on your server, don't replace it blindly — just copy the
// 'push' and 'notificationclick' listeners below into your existing file. If you don't have
// one yet, this file is a complete, working one you can drop in as-is.

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

// Fired by the browser when a push arrives from the send-push Edge Function — this runs
// even if every tab/app window is closed, as long as the browser/OS push service is alive.
self.addEventListener('push', (event) => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch (e) {
        data = { title: 'SocialNexus', body: event.data ? event.data.text() : 'New activity' };
    }

    const title = data.title || 'SocialNexus';
    const options = {
        body: data.body || '',
        icon: data.icon || '/icon-192.png',
        badge: '/icon-192.png',
        tag: data.tag || (title + '_' + Date.now()),
        data: data.url ? { url: data.url } : {},
        vibrate: [100, 50, 100]
    };

    event.waitUntil(self.registration.showNotification(title, options));
});

// Fired when the user taps the OS notification — focuses an already-open tab if there is
// one, otherwise opens a new one, and routes to the right screen inside the app.
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = (event.notification.data && event.notification.data.url) || '/';

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
            for (const client of clientsArr) {
                if ('focus' in client) {
                    client.focus();
                    if ('navigate' in client && targetUrl !== '/') client.navigate(targetUrl).catch(() => {});
                    return;
                }
            }
            if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
        })
    );
});
