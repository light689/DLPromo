/* 只缓存应用资源；API 读写由页面缓存与持久化队列处理。 */
const CACHE = 'dlpromo-shell-v3';
const SHELL = ['/', '/static/style.css', '/static/app.js', '/static/features.js',
  '/static/theme.js', '/static/themes.css', '/static/dseg7.woff2', '/static/manifest.webmanifest', '/static/icon-192.png', '/static/icon-512.png'];
self.addEventListener('install',event => {
  event.waitUntil(caches.open(CACHE)
    .then(cache => cache.addAll(SHELL.map(url => new Request(url, {cache: 'reload'}))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate',event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // 旧版页面没有 controllerchange 监听，需要一次迁移刷新才能摆脱旧缓存。
    const legacy = keys.includes('dlpromo-shell-v2');
    await Promise.all(keys.filter(key => key.startsWith('dlpromo-shell-') && key !== CACHE)
      .map(key => caches.delete(key)));
    await self.clients.claim();
    if (legacy) {
      const clients = await self.clients.matchAll({type: 'window'});
      await Promise.all(clients.map(client => client.navigate(client.url).catch(() => {})));
    }
  })());
});
self.addEventListener('fetch',event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (event.request.mode !== 'navigate' && !SHELL.includes(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = event.request.mode === 'navigate' ? '/' : event.request;
    try {
      const response = await fetch(new Request(event.request, {cache: 'no-cache'}));
      if (!response.ok) throw new Error('Shell request failed');
      // 缓存写入失败不应影响在线使用。
      await cache.put(key, response.clone()).catch(() => {});
      return response;
    } catch (error) {
      const cached = await cache.match(key);
      if (cached) return cached;
      throw error;
    }
  })());
});
