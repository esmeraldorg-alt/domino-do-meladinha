// Service worker mínimo: só existe para o Chrome oferecer "Instalar app" (sem aviso de fonte desconhecida).
// Não guarda nada em cache: o jogo sempre vem do servidor, então as novidades chegam na hora.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (e) {
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(function () {
      return new Response('Sem conexão com o servidor. Abra o jogo de novo quando a internet voltar.', {
        status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }));
  }
});
