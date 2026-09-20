/* Service worker — deixa o app abrir sem internet.
   Ao publicar uma versão nova, troque o número em CACHE. */
const CACHE = 'equipe-gerador-v30';
const ARQUIVOS = [
  './', './index.html', './app.js', './checklists.json', './manifest.webmanifest',
  './logo.png', './icon-192.png', './icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/* checklists.json: rede primeiro (pega perguntas novas), cache como reserva.
   Demais arquivos: cache primeiro, com atualização em segundo plano. */
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  if (url.pathname.endsWith('checklists.json')) {
    e.respondWith(
      fetch(e.request).then(r => {
        const copia = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copia));
        return r;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cacheada => {
      const rede = fetch(e.request).then(r => {
        if (r && r.status === 200) {
          const copia = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, copia));
        }
        return r;
      }).catch(() => cacheada);
      return cacheada || rede;
    })
  );
});
