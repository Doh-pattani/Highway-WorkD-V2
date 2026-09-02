// ============================================================
// Service Worker สำหรับ Highway WorkD PWA Ver.3.0
// ============================================================

const CACHE_NAME = 'hwd-v3';
const APP_SHELL = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
const RUNTIME_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net'];

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res.ok) {
      const clone = res.clone();
      caches.open(CACHE_NAME).then(c => c.put(request, clone));
    }
    return res;
  } catch {
    return new Response('', { status: 503, statusText: 'Offline' });
  }
}

async function networkFirst(request) {
  try {
    const res = await fetch(request);
    if (res.ok) {
      const clone = res.clone();
      caches.open(CACHE_NAME).then(c => c.put(request, clone));
    }
    return res;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response('', { status: 503, statusText: 'Offline' });
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const fetchPromise = fetch(request).then(res => {
    if (res.ok) {
      const clone = res.clone();
      caches.open(CACHE_NAME).then(c => c.put(request, clone));
    }
    return res;
  }).catch(() => cached);
  return cached || fetchPromise;
}

async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch {
    return new Response(
      JSON.stringify({ error: 'offline', message: 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

function getStrategy(request) {
  const url = new URL(request.url);
  if (url.hostname.includes('supabase')) return 'network-only';
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return 'stale-while-revalidate';
  if (RUNTIME_HOSTS.some(h => url.hostname.includes(h))) return 'cache-first';
  if (request.headers.get('Accept')?.includes('text/html')) return 'network-first';
  return 'cache-first';
}

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  
  // ✅ ป้องกัน Error จากส่วนขยายของเบราว์เซอร์
  if (!e.request.url.startsWith('http')) return;

  const strategy = getStrategy(e.request);
  switch (strategy) {
    case 'network-only': e.respondWith(networkOnly(e.request)); break;
    case 'network-first': e.respondWith(networkFirst(e.request)); break;
    case 'stale-while-revalidate': e.respondWith(staleWhileRevalidate(e.request)); break;
    case 'cache-first':
    default: e.respondWith(cacheFirst(e.request)); break;
  }
});

self.addEventListener('message', e => {
  if (e.data?.type === 'skip-waiting') self.skipWaiting();
  if (e.data?.type === 'clear-cache') {
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))).then(() => {
      self.clients.matchAll().then(cs => cs.forEach(c => c.navigate(c.url)));
    });
  }
});
