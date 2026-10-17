// 待办手机版 Service Worker —— 缓存页面壳，支持“添加到主屏幕”后离线打开
// 仅缓存同源 GET；Gitee API（跨域）与所有写请求一律直连网络，绝不缓存。
var CACHE_NAME = 'todo-mobile-v3';
var SHELL = [
  new URL('./mobile.html', self.location.href).href,
  new URL('./manifest.json', self.location.href).href,
  new URL('./icons/icon-192.png', self.location.href).href,
  new URL('./icons/icon-512.png', self.location.href).href,
  new URL('./icons/icon-180.png', self.location.href).href
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      // 逐个缓存：单个资源失败不影响整组
      return Promise.all(SHELL.map(function(url) {
        return cache.add(url).catch(function() {});
      }));
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
  var req = e.request;
  // 只处理 GET；POST/PUT/PATCH/DELETE 直接走网络
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  // 跨域（Gitee API 等）直接走网络，绝不缓存
  if (url.origin !== self.location.origin) return;
  // 电脑端 API 不缓存
  if (url.pathname.indexOf('/api/') === 0) return;

  // 导航请求：网络优先，离线回退页面壳
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function(resp) {
        var copy = resp.clone();
        caches.open(CACHE_NAME).then(function(cache) { cache.put(req, copy); });
        return resp;
      }).catch(function() {
        return caches.match(new URL('./mobile.html', self.location.href).href)
          .then(function(hit) { return hit || new Response('', { status: 504, statusText: 'Offline' }); });
      })
    );
    return;
  }

  // 同源静态资源：缓存优先 + 后台更新（stale-while-revalidate）
  e.respondWith(
    caches.match(req).then(function(hit) {
      var network = fetch(req).then(function(resp) {
        if (resp && resp.status === 200) {
          var copy = resp.clone();
          caches.open(CACHE_NAME).then(function(cache) { cache.put(req, copy); });
        }
        return resp;
      }).catch(function() { return hit; });
      return hit || network;
    })
  );
});
