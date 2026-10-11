/* 只缓存应用资源；API 读写由页面缓存与持久化队列处理。 */
const CACHE = 'dlpromo-shell-v1';
const SHELL = ['/', '/static/style.css', '/static/app.js', '/static/features.js',
  '/static/dseg7.woff2', '/static/manifest.webmanifest', '/static/icon-192.png', '/static/icon-512.png'];
self.addEventListener('install',event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
});
self.addEventListener('activate',event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith('dlpromo-shell-') && key !== CACHE).map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});
self.addEventListener('fetch',event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(caches.match('/').then(cached => cached || fetch(event.request)));
  } else if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
  }
});
