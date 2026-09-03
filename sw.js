// ============================================================
// Service Worker สำหรับ Highway WorkD PWA
// รองรับการใช้งานแบบออฟไลน์ — แคชทรัพยากรหลัก + จัดการเครือข่าย
// ============================================================

const CACHE_NAME = 'hwd-v4';

// --- ทรัพยากรหลักที่ต้องแคชล่วงหน้า (App Shell) ---
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

// --- ทรัพยากรภายนอกที่ควรแคชเมื่อโหลดสำเร็จ (Runtime cache) ---
const RUNTIME_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdn.jsdelivr.net'
];

// --- กลยุทธ์ต่าง ๆ ---

// 1) Cache-First: ใช้สำหรับทรัพยากรคงที่ (ฟอนต์, ไอคอน)
//    ถ้ามีในแคช → ตอบจากแคชทันที, ถ้าไม่มี → ดึงจากเครือข่ายแล้วเก็บแคช
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

// 2) Network-First: ใช้สำหรับหน้า HTML และ API
//    ลองดึงจากเครือข่ายก่อน, ถ้าออฟไลน์ → ใช้แคช
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

// 3) Stale-While-Revalidate: ใช้สำหรับฟอนต์ (ตอบจากแคชเร็ว + อัปเดตเบื้องหลัง)
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

// 4) Network-Only: ใช้สำหรับ API Supabase (ข้อมูลต้องสดเสมอ)
async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch {
    return new Response(
      JSON.stringify({ error: 'offline', message: 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ต' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// --- ตรวจสอบประเภท request → เลือกกลยุทธ์ ---
function getStrategy(request) {
  const url = new URL(request.url);

  // API Supabase → Network-Only (ข้อมูลต้องสด)
  if (url.hostname.includes('supabase')) return 'network-only';

  // ฟอนต์ Google → Stale-While-Revalidate (ตอบเร็ว + อัปเดต)
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com')
    return 'stale-while-revalidate';

  // CDN อื่น ๆ (เช่น supabase-js) → Cache-First
  if (RUNTIME_HOSTS.some(h => url.hostname.includes(h))) return 'cache-first';

  // หน้า HTML → Network-First (ต้องการเนื้อหาใหม่สุด)
  if (request.headers.get('Accept')?.includes('text/html')) return 'network-first';

  // ทรัพยากรคงที่ (รูป, CSS, JS) → Cache-First
  return 'cache-first';
}

// ============================================================
// Event: install — ติดตั้ง SW และแคช App Shell
// ============================================================
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch(err => console.error('SW install fail:', err))
  );
});

// ============================================================
// Event: activate — ล้างแคชเก่า และควบคุมทุกหน้าทันที
// ============================================================
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(k => k !== CACHE_NAME)
            .map(k => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ============================================================
// Event: fetch — จับคู่กลยุทธ์ที่เหมาะสม
// ============================================================
self.addEventListener('fetch', e => {
  // 📍 ดักไว้ตรงนี้: ข้ามการแคชถ้าไม่ใช่ GET หรือเป็น URL ของส่วนขยายเบราว์เซอร์
  if (e.request.method !== 'GET' || !e.request.url.startsWith('http')) {
    return;
  }

  const strategy = getStrategy(e.request);
  switch (strategy) {
    case 'network-only': e.respondWith(networkOnly(e.request)); break;
    case 'network-first': e.respondWith(networkFirst(e.request)); break;
    case 'stale-while-revalidate': e.respondWith(staleWhileRevalidate(e.request)); break;
    case 'cache-first':
    default: e.respondWith(cacheFirst(e.request)); break;
  }
});

// ============================================================
// Event: message — รับคำสั่งจากหน้าเว็บ
// ============================================================
self.addEventListener('message', e => {
  // คำสั่ง "skip-waiting" → เปิดใช้ SW ใหม่ทันที (สำหรับอัปเดต)
  if (e.data?.type === 'skip-waiting') {
    self.skipWaiting();
  }
  // คำสั่ง "clear-cache" → ล้างแคชทั้งหมด
  if (e.data?.type === 'clear-cache') {
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k)))
    ).then(() => {
      self.clients.matchAll().then(cs => cs.forEach(c => c.navigate(c.url)));
    });
  }
});
