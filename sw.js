/* 70º BPM — Service Worker
 * Só cuida dos AVISOS (push) e da instalação do app na tela inicial. NÃO guarda nada em cache e não intercepta
 * requisições: o painel continua sempre buscando a versão mais nova do site (o painel de dados já teve problema de
 * página velha presa em cache; aqui isso não existe).
 * Payload vem da Edge Function notificar-dispatch: { title, body, url, tag }. Nunca traz REDS nem endereço:
 * só tipo do aviso, município e quantidade — quem toca no aviso entra no painel (com login) pra ver o detalhe. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {}); // passa direto (alguns navegadores só oferecem "instalar" se existir o ouvinte)

self.addEventListener('push', (e) => {
  let dados = {};
  try { dados = e.data ? e.data.json() : {}; } catch (_) { dados = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    // painel aberto e em foco: o aviso na bandeja seria repetido (o usuário já está olhando)
    const janelas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const teste = dados.tag === '70bpm-teste'; // o teste do painel tem que aparecer mesmo com o painel aberto (senão parece que não funcionou)
    if (!teste && janelas.some((w) => w.visibilityState === 'visible' && w.focused)) {
      janelas.forEach((w) => w.postMessage({ type: 'push-recebido', pagina: dados.pagina || null }));
      return;
    }
    await self.registration.showNotification(dados.title || '70º BPM', {
      body: dados.body || '',
      icon: 'assets/pwa/icon-192.png',
      badge: 'assets/pwa/icon-192.png',
      tag: dados.tag || '70bpm',
      renotify: true, // o aviso novo substitui o anterior na bandeja e avisa de novo (em vez de empilhar)
      data: { url: dados.url || './', pagina: dados.pagina || null },
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const d = e.notification.data || {};
  const alvo = new URL(d.url || './', self.registration.scope).href;
  e.waitUntil((async () => {
    const janelas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const aberta = janelas.find((w) => new URL(w.url).origin === self.location.origin);
    if (aberta) { await aberta.focus(); aberta.postMessage({ type: 'notif-click', pagina: d.pagina || null }); return; }
    await self.clients.openWindow(alvo);
  })());
});
