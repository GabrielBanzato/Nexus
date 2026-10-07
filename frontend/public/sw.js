/* Nexus: service worker do app instalado (PWA).
 *
 *  - Notificações (Web Push): mensagem nova na Central, lembretes de reunião, aviso de QR.
 *    Não mostra se o Nexus já estiver aberto e à frente (aí o próprio app avisa).
 *  - Cache só do que é seguro: os ficheiros com hash (/assets/*, imutáveis) e os ícones. A API e
 *    o index.html vêm sempre da rede (dados sempre frescos, deploys novos chegam na hora); sem
 *    rede, a navegação mostra uma página "sem conexão".
 */
const VERSION = 'nexus-v1';
const STATIC_CACHE = `${VERSION}-static`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(['/icons/icon-192.png', '/icons/badge-96.png']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const OFFLINE_PAGE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nexus · sem conexão</title><style>body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#0e0e0e;color:#e5e5e5;font:15px system-ui,sans-serif;text-align:center;padding:24px}
img{width:72px;height:72px;border-radius:18px}h1{font-size:18px;margin:16px 0 6px}p{color:#a3a3a3;margin:0 0 20px}button{background:#991b1b;color:#fff;border:0;border-radius:12px;padding:10px 18px;font-weight:600}</style></head>
<body><div><img src="/icons/icon-192.png" alt=""><h1>Sem conexão com a internet</h1><p>O Nexus volta assim que a conexão voltar.</p><button onclick="location.reload()">Tentar de novo</button></div></body></html>`;

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((response) => {
            if (response.ok) caches.open(STATIC_CACHE).then((cache) => cache.put(request, response.clone()));
            return response;
          }),
      ),
    );
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => new Response(OFFLINE_PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
  }
});

// ---- Notificações ------------------------------------------------------------------------

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = { title: 'Nexus', body: event.data?.text() };
  }
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const inFront = windows.some((w) => w.visibilityState === 'visible' && w.focused);
      if (inFront && !data.always) return; // o app aberto já avisa (toast / lista da Central)
      await self.registration.showNotification(data.title || 'Nexus', {
        body: data.body || '',
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-96.png',
        tag: data.tag, // a mesma conversa substitui a notificação anterior em vez de empilhar
        renotify: Boolean(data.tag),
        data: { url: data.url || '/' },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const same = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (same) {
        await same.focus();
        return same.navigate(target).catch(() => same.postMessage({ type: 'navigate', url: target }));
      }
      return self.clients.openWindow(target);
    })(),
  );
});

// A inscrição expirou/mudou no navegador: avisa a página para registar a nova no servidor.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((windows) => windows.forEach((w) => w.postMessage({ type: 'push-resubscribe' }))),
  );
});
