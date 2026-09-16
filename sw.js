/* connec+a Service Worker (P2: PWA + Web Push + near-0s shell)
 * 配置: participants-index.html と同じディレクトリ (例: リポジトリ直下) に置く。
 * 登録: navigator.serviceWorker.register('./sw.js')  ← 相対指定で GitHub Pages のサブパスでも動作。
 *
 * v4 (統合): 旧 v3 の「静的アセット cache-first(裏更新) + Web Push」に、
 *   (1) ナビゲーションHTML の network-first — オンラインは常に最新HTML、圏外時のみ最後に成功したHTMLで起動
 *   (2) activate 時の旧バージョンキャッシュ掃除 (v3 以前の cca-cache-* も回収)
 *   を追加。GAS API (script.google.com / googleusercontent.com) は従来どおり一切キャッシュしない。
 */
/* v7 (2026-09-16): 通知タップの「開いたまま問題」を解消。
 *   ・hash に再入キー(_r)を付けて、同じ画面を開いていても必ず hashchange を起こす
 *   ・アプリ本体へ cca-push-open を postMessage → 本体が申込一覧などを強制再取得する
 *   (これが無いと、通知は届くのに画面は公開前の状態のまま=「見れない」ように見える)
 */
const VERSION = 'v7';
const CACHE_NAME = 'cca-cache-' + VERSION;   // 静的アセット (cache-first + 裏更新)
const HTML_CACHE = 'cca-html-' + VERSION;    // ナビゲーションHTML (network-first / 圏外フォールバック専用)

self.addEventListener('install', (e) => { self.skipWaiting(); });

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // 旧バージョンの cca-* キャッシュを掃除 (v3 の 'cca-cache-v3' なども対象)
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.indexOf('cca-') === 0 && k !== CACHE_NAME && k !== HTML_CACHE)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// HTML = network-first (圏外時のみキャッシュ)。静的アセットのみ cache-first(裏更新)。GAS API はキャッシュしない (常に最新)。
self.addEventListener('fetch', (e) => {
  if (e.request.url.indexOf('script.google.com') >= 0) return;
  if (e.request.url.indexOf('googleusercontent.com') >= 0) return;
  if (e.request.method !== 'GET') return;

  // (v4) ナビゲーション(HTML) → network-first。オンラインなら常に最新、失敗(圏外)時のみ最後の成功HTML。
  //   古いHTMLが固定表示される事故は構造上起きない。
  if (e.request.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        // (v6) 端末のHTTPキャッシュ(max-age=600)を信用せず毎回サーバーへ再検証(ETag一致なら304=軽い)。
        //   これが無いと「アプリ完全終了→再起動」しても最大10分は古いHTMLが出る。
        const fresh = await fetch(e.request, { cache: 'no-cache' });
        if (fresh && fresh.ok) {
          const cache = await caches.open(HTML_CACHE);
          cache.put(e.request, fresh.clone());
        }
        return fresh;
      } catch (err) {
        const cache = await caches.open(HTML_CACHE);
        const hit = await cache.match(e.request, { ignoreSearch: true });
        if (hit) return hit;
        throw err;
      }
    })());
    return;
  }

  const url = new URL(e.request.url);
  const isStatic = /\.(woff2?|ttf|otf|png|jpg|jpeg|gif|svg|webp|ico|css|js)(\?|$)/i.test(url.pathname);
  if (!isStatic) return;
  e.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(e.request).then((cached) => {
        const fetchPromise = fetch(e.request).then((networkRes) => {
          if (networkRes && networkRes.ok) cache.put(e.request, networkRes.clone());
          return networkRes;
        }).catch(() => cached);
        return cached || fetchPromise;
      })
    )
  );
});

// --- Web Push ---
// 送信側 (P2-2: web-push) が JSON ペイロードを送る想定:
// { title, body, url, tag, icon, badge }
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    try { data = { title: 'connec+a', body: event.data ? event.data.text() : '' }; } catch (e2) { data = {}; }
  }
  const title = data.title || 'connec+a';
  const options = {
    body: data.body || '',
    icon: data.icon || './icons/icon-192.png',
    badge: data.badge || './icons/badge-72.png',
    data: { url: data.url || './' },
    tag: data.tag || undefined,
    renotify: !!data.tag,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.url) || './';
  const scope = self.registration.scope; // アプリのディレクトリ (例: https://site/event/)。sw.js ではなくここを基準にする。
  // 遷移先を「アプリのスコープ」基準で絶対URL化する (相対や '#/...' を sw.js 基準で解決して sw.js を開く事故を防ぐ)。
  let absolute;
  try {
    if (/^https?:\/\//i.test(raw)) absolute = raw;
    else if (raw.charAt(0) === '#') absolute = scope + raw;        // scope直下のindex + hash
    else absolute = new URL(raw, scope).href;                      // 相対は scope 基準
  } catch (e) { absolute = scope; }
  // (v7) 再入キー _r: 既に同じ画面(同じhash)を開いていると hashchange が発火せず、
  //   アプリは何も起きない=古い表示のまま固まる。毎回違う値を付けて必ず発火させる。
  const hi = absolute.indexOf('#');
  const base = hi >= 0 ? absolute.slice(0, hi) : absolute;
  let hash = hi >= 0 ? absolute.slice(hi) : '';
  if (hash) hash += (hash.indexOf('?') >= 0 ? '&' : '?') + '_r=' + Date.now();
  const target = hash ? (base + hash) : absolute;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        // sw.js を指すタブは無視。アプリのタブ(同一オリジン)があれば、それに hash を適用して前面化。
        if (c.url && c.url.indexOf('/sw.js') >= 0) continue;
        if ('focus' in c) {
          let navTo = target;
          try {
            const cu = new URL(c.url);
            navTo = hash ? (cu.origin + cu.pathname + cu.search + hash) : target;
            if (c.navigate) { c.navigate(navTo).catch(() => {}); }
          } catch (e) {}
          // (v7) 開いたままのアプリは自動で再読込されない=データが古いまま。
          //   通知タップを本体へ通報し、本体側で最新化(+記念写真などの目的画面を開く)。
          try { c.postMessage({ type: 'cca-push-open', url: navTo, hash: hash }); } catch (e) {}
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
