/* sw.js — HWD PWA Service Worker (v4) */
const CACHE_NAME  = 'hwd-v4';
const RUNTIME     = 'hwd-runtime-v4';
const OFFLINE_URL = './index.html';
const NET_TIMEOUT = 3000;

// ✅ FIX #1: แยก core (ต้องมี) ออกจาก optional (ขาดได้)
const CORE_SHELL = ['./', './index.html'];
const OPTIONAL_SHELL = [
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

// ---------- INSTALL ----------
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // core ต้องสำเร็จ ไม่งั้น install ล้มเหลวโดยตั้งใจ
    await cache.addAll(CORE_SHELL.map(u => new Request(u, { cache: 'reload' })));

    // ✅ optional ใช้ allSettled — ไฟล์เดียวหายไม่ทำให้ทั้ง SW พัง
    const results = await Promise.allSettled(
      OPTIONAL_SHELL.map(u => cache.add(new Request(u, { cache: 'reload' })))
    );
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.warn('[SW] ข้ามไฟล์ที่โหลดไม่ได้:', OPTIONAL_SHELL[i]);
      }
    });

    // ✅ FIX #3: ไม่ skipWaiting อัตโนมัติ — รอผู้ใช้กดปุ่มอัปเดต
    // self.skipWaiting();  <-- ลบออก
  })());
});

// ---------- ACTIVATE ----------
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k !== CACHE_NAME && k !== RUNTIME)
          .map(k => caches.delete(k))
    );
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.enable();
    }
    await self.clients.claim();
  })());
});

// ---------- HELPERS ----------
// ✅ FIX #4 + #5: กันแคช response เสีย / opaque
function isCacheable(res) {
  return res && res.ok && res.status === 200 && res.type !== 'opaque';
}

async function putSafe(cacheName, request, res) {
  if (!isCacheable(res)) return;
  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, res.clone());
  } catch (e) {
    console.warn('[SW] cache.put ล้มเหลว:', request.url, e);
  }
}

// ✅ FIX #8: network-first พร้อม timeout
function fetchWithTimeout(request, ms = NET_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(request).then(
      res => { clearTimeout(timer); resolve(res); },
      err => { clearTimeout(timer); reject(err); }
    );
  });
}

// ---------- STRATEGIES ----------
async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  try {
    const res = await fetch(request);
    await putSafe(RUNTIME, request, res);
    return res;
  } catch {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

async function staleWhileRevalidate(request) {
  const hit = await caches.match(request);
  const network = fetch(request)
    .then(res => { putSafe(RUNTIME, request, res); return res; })
    .catch(() => null);
  return hit || (await network) ||
         new Response('', { status: 504, statusText: 'Offline' });
}

// ✅ FIX #6: fallback หน้า index.html เสมอเมื่อออฟไลน์
async function networkFirst(request, event) {
  try {
    const preload = event && await event.preloadResponse;
    if (preload) { await putSafe(RUNTIME, request, preload); return preload; }

    const res = await fetchWithTimeout(request);
    await putSafe(RUNTIME, request, res);
    return res;
  } catch {
    const hit = await caches.match(request);
    if (hit) return hit;

    if (request.mode === 'navigate') {
      const shell = await caches.match(OFFLINE_URL);
      if (shell) return shell;
    }
    return new Response('ออฟไลน์ — ไม่พบข้อมูลในแคช', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

// ---------- FETCH ----------
self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // ✅ FIX #7: ข้าม chrome-extension:// และ scheme อื่น
  if (!url.protocol.startsWith('http')) return;

  // ✅ FIX #2: Supabase ต้องเช็คเป็นอันดับแรกสุด — ห้ามแคชเด็ดขาด
  if (url.hostname.endsWith('.supabase.co') ||
      url.hostname.includes('supabase')) {
    event.respondWith(
      fetch(request).catch(() => new Response(
        JSON.stringify({ error: 'offline' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      ))
    );
    return;
  }

  // CDN → SWR (ไม่ใช่ cache-first) กัน SDK พังถาวร
  if (url.hostname.includes('cdn.jsdelivr.net') ||
      url.hostname.includes('unpkg.com')) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // Google Fonts → SWR
  if (url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // Navigation / HTML → network-first
  if (request.mode === 'navigate' ||
      (request.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(networkFirst(request, event));
    return;
  }

  // Static asset same-origin → cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});

// ---------- MESSAGE ----------
self.addEventListener('message', event => {
  const data = event.data || {};
  const type = data.type || data;

  if (type === 'skip-waiting' || type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (type === 'clear-cache' || type === 'CLEAR_CACHE') {
    event.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach(c => c.postMessage({ type: 'cache-cleared' }));
    })());
  }
});