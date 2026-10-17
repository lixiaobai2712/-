// 待办手机版 Service Worker —— 缓存页面壳，支持"添加到主屏幕"后离线打开
// 注意：Service Worker 仅在 HTTPS 或 localhost 下生效；
// 局域网 HTTP（http://10.x.x.x:8899）下浏览器会忽略注册，页面仍可正常在线使用。
var CACHE_NAME = 'todo-mobile-v1';
var SHELL = [
  '/mobile',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-180.png'
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(SHELL).catch(function() {});
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) { return k !== CACHE_NAME; })
                         .map(function(k) { return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(e) {
  var url = new URL(e.request.url);
  // API 请求不缓存，直接走网络（数据必须实时）
  if (url.pathname.indexOf('/api/') === 0) return;
  // 页面与静态壳：缓存优先，回退网络（离线可打开壳，数据来自 localStorage）
  e.respondWith(
    caches.match(e.request).then(function(hit) {
      if (hit) return hit;
      return fetch(e.request).then(function(resp) {
        var copy = resp.clone();
        caches.open(CACHE_NAME).then(function(cache) { cache.put(e.request, copy); });
        return resp;
      }).catch(function() {
        // 彻底离线时回退到缓存的 /mobile 壳
        if (e.request.mode === 'navigate') {
          return caches.match('/mobile');
        }
        return new Response('', { status: 504, statusText: 'Offline' });
      });
    })
  );
});
