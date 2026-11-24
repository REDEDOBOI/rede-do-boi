// Service worker: guarda o app no aparelho para abrir sem internet.
const VERSAO = 'rdb-v3';
const APP = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/api.js', 'js/store.js', 'js/config.js', 'js/instalar.js', 'vendor/supabase.js',
  'manifest.webmanifest', 'icons/logo.jpg', 'icons/icon-64.png', 'icons/icon-192.png', 'icons/sem-foto.svg',
  'fonts/archivo-latin-800-italic.woff2', 'fonts/archivo-latin-800-normal.woff2', 'fonts/archivo-latin-900-italic.woff2',
  'fonts/inter-latin-400-normal.woff2', 'fonts/inter-latin-500-normal.woff2', 'fonts/inter-latin-600-normal.woff2', 'fonts/inter-latin-700-normal.woff2'];
const FOTOS = 'rdb-fotos';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSAO).then(c => c.addAll(APP)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSAO && k !== FOTOS).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  // fotos e vídeos dos lotes e banners: guarda depois da primeira vez
  if (url.pathname.includes('/storage/v1/object/public/')) {
    if (req.headers.has('range')) return; // vídeos tocados aos pedaços vão direto
    e.respondWith(caches.open(FOTOS).then(async c => {
      const hit = await c.match(req); if (hit) return hit;
      const res = await fetch(req); if (res.ok && !/video/.test(res.headers.get('content-type') || '')) c.put(req, res.clone()); return res;
    }));
    return;
  }
  if (url.origin !== location.origin) return; // servidor (dados) vai direto
  // arquivos do app: abre na hora com o que está guardado e atualiza por trás (bom para sinal fraco)
  e.respondWith(caches.open(VERSAO).then(async c => {
    const chave = req.mode === 'navigate' ? 'index.html' : req;
    const hit = await c.match(chave, { ignoreSearch: true });
    const rede = fetch(req).then(res => { if (res.ok) c.put(chave, res.clone()); return res; });
    if (hit) { e.waitUntil(rede.catch(() => {})); return hit; }
    return rede.catch(() => Response.error());
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(cs => cs.length ? cs[0].focus() : self.clients.openWindow('./')));
});
// avisos enviados pelo servidor (fase 2)
self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch (x) { d = { title: 'Rede do Boi', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Rede do Boi', { body: d.body || '', icon: 'icons/icon-192.png', badge: 'icons/icon-64.png', tag: d.tag || 'rdb' }));
});
