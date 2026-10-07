import { AppError } from '../lib/errors.js';
import { learnPublicOrigin } from '../repositories/meetingRepository.js';

const subscriptionSchema = {
  body: {
    type: 'object',
    required: ['endpoint', 'keys'],
    additionalProperties: true, // o navegador manda também expirationTime
    properties: {
      // Só serviços de push reais (https); evita o servidor fazer pedidos a endereços arbitrários.
      endpoint: { type: 'string', maxLength: 512, pattern: '^https://' },
      keys: {
        type: 'object',
        required: ['p256dh', 'auth'],
        properties: { p256dh: { type: 'string', minLength: 10, maxLength: 255 }, auth: { type: 'string', minLength: 8, maxLength: 64 } },
      },
    },
  },
};

// Serviços de push dos navegadores (Chrome/Android, Safari/iPhone, Firefox, Edge). Só estes:
// o servidor faz pedidos ao endpoint, e um endereço qualquer seria uma porta para SSRF.
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|push\.apple\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/;
const isPushEndpoint = (endpoint) => {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && PUSH_HOSTS.test(url.hostname);
  } catch {
    return false;
  }
};

const unsubscribeSchema = {
  body: { type: 'object', required: ['endpoint'], properties: { endpoint: { type: 'string', maxLength: 512 } } },
};

/** Notificações (Web Push): cada membro inscreve os seus aparelhos. */
export default async function pushRoutes(app) {
  const service = () => {
    if (!app.push?.isEnabled()) throw new AppError(503, 'PUSH_DISABLED', 'As notificações não estão disponíveis neste servidor.');
    return app.push;
  };

  app.get('/api/push/public-key', async () => ({ data: { enabled: Boolean(app.push?.isEnabled()), public_key: app.push?.publicKey() ?? null } }));

  app.post('/api/push/subscriptions', { schema: subscriptionSchema }, async (request, reply) => {
    if (!isPushEndpoint(request.body.endpoint)) throw new AppError(400, 'INVALID_ENDPOINT', 'Serviço de notificações não suportado neste navegador.');
    learnPublicOrigin(request.headers.origin); // o endereço do painel vira o contacto VAPID e o link das mensagens
    await service().subscribe(request.currentUser.id, request.body, request.headers['user-agent']);
    return reply.code(201).send({ data: { subscribed: true } });
  });

  app.delete('/api/push/subscriptions', { schema: unsubscribeSchema }, async (request) => {
    await service().unsubscribe(request.currentUser.id, request.body.endpoint);
    return { data: { subscribed: false } };
  });

  // "Enviar notificação de teste": confirma no próprio aparelho que está tudo ligado.
  app.post('/api/push/test', async (request) => {
    const delivered = await service().sendToUsers([request.currentUser.id], {
      title: 'Notificações ligadas ✅',
      body: 'É assim que o Nexus vai avisar de mensagens novas e reuniões.',
      url: '/',
      always: true,
    });
    return { data: { delivered } };
  });
}
