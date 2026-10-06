// Service worker: tiene in cache l'app shell così l'app si apre anche offline.
// Le chiamate alle API (altri domini) non vengono intercettate: i dati
// li gestisce la pagina, con la sua cache in localStorage.

const CACHE = 'staffarda-bus-v2';
const SHELL = [
  './',
  'index.html',
  'manifest.json',
  'logo/favicon.ico',
  'logo/icon-96.png',
  'logo/icon-192.png',
  'logo/icon-512.png',
  'logo/icon-maskable-512.png',
  'logo/apple-touch-icon.png',
];
// Oltre questo tempo la pagina viene servita dalla cache invece di aspettare la rete
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
  } else {
    event.respondWith(cacheFirst(request));
  }
});

// Pagina: prima la rete (così gli aggiornamenti arrivano subito), la cache se offline o lenta
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const network = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });
  network.catch(() => {}); // se vince il timeout, un errore di rete non va segnalato

  const timeout = new Promise(resolve => setTimeout(resolve, NETWORK_TIMEOUT_MS));
  const fallback = async () =>
    (await cache.match(request, { ignoreSearch: true })) || cache.match('./');

  try {
    const response = await Promise.race([network, timeout]);
    if (response) return response;
    return (await fallback()) || network;
  } catch (e) {
    return (await fallback()) || Response.error();
  }
}

// Icone e manifest: cambiano di rado, si servono dalla cache.
// Se li modifichi, incrementa la versione in CACHE.
async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}
