/* DS재고 관리 — 앱 화면 파일을 휴대폰에 저장해 전파가 약해도 바로 뜨게 함
 *   - 첫 화면(index.html): 인터넷 먼저(3초까지 기다림), 안 되면 저장해 둔 것 → 새 버전은 지금처럼 바로 적용
 *   - 버전이 붙은 파일(app.js?v=…)·글꼴·라이브러리: 저장해 둔 것 먼저 (버전이 바뀌면 주소가 달라져 새로 받음)
 *   - 데이터(Supabase)는 건드리지 않음
 */
var CACHE = "ds-inv-shell-1";
var NAV_TIMEOUT_MS = 3000;
var CDN = ["cdn.jsdelivr.net", "fonts.gstatic.com", "fonts.googleapis.com"];

self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf("ds-inv-shell-") === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function put(req, res) {
  if (!res || (res.status !== 200 && res.type !== "opaque")) return Promise.resolve();
  var copy = res.clone();
  return caches.open(CACHE).then(function (c) {
    // 같은 파일의 예전 버전(app.js?v=이전)은 지움
    var u = new URL(req.url);
    var clean = u.search ? c.keys().then(function (ks) {
      return Promise.all(ks.filter(function (k) { var x = new URL(k.url); return x.origin === u.origin && x.pathname === u.pathname && x.search !== u.search; }).map(function (k) { return c.delete(k); }));
    }) : Promise.resolve();
    return clean.then(function () { return c.put(req, copy); });
  }).catch(function () { /* 저장 못 해도 동작 */ });
}

function networkFirst(req) {
  return new Promise(function (resolve) {
    var done = false;
    var timer = setTimeout(function () {
      caches.match(req, { ignoreSearch: req.mode === "navigate" }).then(function (hit) { if (hit && !done) { done = true; resolve(hit); } });
    }, NAV_TIMEOUT_MS);
    fetch(req).then(function (res) {
      clearTimeout(timer);
      put(req, res);
      if (!done) { done = true; resolve(res); }
    }).catch(function () {
      clearTimeout(timer);
      caches.match(req, { ignoreSearch: req.mode === "navigate" }).then(function (hit) {
        if (!done) { done = true; resolve(hit || Response.error()); }
      });
    });
  });
}

function cacheFirst(req) {
  return caches.match(req).then(function (hit) {
    return hit || fetch(req).then(function (res) { put(req, res); return res; });
  });
}

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var u = new URL(req.url);
  var same = u.origin === self.location.origin && u.pathname.indexOf(new URL(self.registration.scope).pathname) === 0;
  if (same) {
    if (/\/tools\//.test(u.pathname) || /\/sw\.js$/.test(u.pathname)) return;
    // 새 버전 확인(cache: reload)은 항상 인터넷에서 — 받은 것은 저장해 둠
    if (req.cache === "reload" || req.cache === "no-store") {
      e.respondWith(fetch(req).then(function (res) { put(new Request(u.href), res); return res; }));
      return;
    }
    if (req.mode === "navigate" || /\/(index\.html)?$/.test(u.pathname) || /manifest\.webmanifest$/.test(u.pathname)) { e.respondWith(networkFirst(req)); return; }
    if (u.search || /\.(png|ico|svg|woff2?)$/.test(u.pathname)) { e.respondWith(cacheFirst(req)); return; }
    e.respondWith(networkFirst(req));
    return;
  }
  if (CDN.indexOf(u.hostname) >= 0) { e.respondWith(cacheFirst(req)); return; }
  // 그 밖(Supabase 등)은 그대로 통과
});
