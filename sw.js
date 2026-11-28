// sw.js — 릴스 스튜디오 서비스워커 (PWA 설치 + 오프라인 실행)
//  · 같은 주소(GitHub Pages)의 파일만 다룹니다. Gemini·블로그 프록시·폰트 같은 외부 요청은 그대로 통과.
//  · 네트워크를 먼저 확인하고(최신 버전 우선), 네트워크가 없을 때만 캐시를 씁니다.
const VERSION = 'reels-studio-v10-2026-11-28b';
const CACHE = `${VERSION}`;
const CORE = [
  './',
  './index.html',
  './styles.css',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 하나가 실패해도 설치는 계속 (설치 조건은 fetch 핸들러가 있으면 충족)
    await Promise.all(CORE.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 외부 API·폰트는 건드리지 않음

  event.respondWith((async () => {
    try {
      // network-first: 새로 배포한 파일이 캐시 때문에 묵지 않게
      const res = await fetch(req);
      if (res && res.ok) {
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    } catch (e) {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      return new Response('오프라인 상태입니다. 인터넷에 연결한 뒤 다시 열어 주세요.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  })());
});
