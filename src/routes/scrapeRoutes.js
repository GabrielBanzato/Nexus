import { config } from '../config/env.js';
import { requireRole } from '../plugins/auth.js';
import { findJobById } from '../repositories/jobRepository.js';

const scrapeBodySchema = {
  type: 'object',
  required: ['termo'],
  additionalProperties: false,
  properties: {
    termo: { type: 'string', minLength: 3, maxLength: 200 },
    maxResultados: { type: 'integer', minimum: 1, maximum: 100 },
  },
};

export default async function scrapeRoutes(app) {
  // Painel de Prospecção (Radar/Scraper): exclusivo do admin. Demais papéis recebem 403.
  app.addHook('preHandler', requireRole('admin'));

  app.post('/api/scrape', { schema: { body: scrapeBodySchema } }, async (request, reply) => {
    const searchTerm = request.body.termo.trim();
    const maxResults = request.body.maxResultados ?? config.scraper.maxResults;

    const job = await app.scrapeQueue.enqueue({ searchTerm, maxResults });

    return reply.code(202).send({
      status: 'Iniciado',
      jobId: job.id,
      termo: searchTerm,
      maxResultados: maxResults,
      posicaoNaFila: job.position,
      acompanhar: `/api/scrape/${job.id}`,
    });
  });

  app.get(
    '/api/scrape/:jobId',
    { schema: { params: { type: 'object', properties: { jobId: { type: 'string', format: 'uuid' } } } } },
    async (request, reply) => {
      const job = await findJobById(request.params.jobId);
      if (!job) return reply.code(404).send({ error: 'Job não encontrado' });
      return job;
    },
  );
}
