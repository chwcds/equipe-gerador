/* Service worker — deixa o app abrir sem internet e abrir RÁPIDO com internet fraca.
   Ao publicar uma versão nova, troque o número em CACHE. */
const CACHE = 'equipe-gerador-v32';
const ARQUIVOS = [
  './', './index.html', './app.js', './checklists.json', './lojas.json', './manifest.webmanifest',
  './logo.png', './logo-bh.svg', './icon-192.png', './icon-512.png', './icon.svg',
  './jspdf.umd.min.js', './jspdf.plugin.autotable.min.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/* Tudo "cache primeiro": a resposta guardada volta na hora e, em paralelo, a rede
   atualiza o cache para a próxima abertura. Pedidos com "?atualizar=1" (feitos pelo app
   em segundo plano) vão direto à rede e gravam no cache do arquivo — assim perguntas e
   lojas novas entram sem travar a abertura do app. */
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  if (url.searchParams.has('atualizar')) {
    url.searchParams.delete('atualizar');
    const limpa = new Request(url.toString());
    e.respondWith(
      fetch(e.request, {cache: 'no-store'}).then(r => {
        if (r && r.status === 200) {
          const copia = r.clone();
          caches.open(CACHE).then(c => c.put(limpa, copia));
        }
        return r;
      }).catch(() => caches.match(limpa))
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
