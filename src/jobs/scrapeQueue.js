import { randomUUID } from 'node:crypto';
import { db } from '../config/database.js';
import { config } from '../config/env.js';
import { scrapeGoogleMaps } from '../services/googleMapsScraper.js';
import { classifyLead } from '../services/leadClassifier.js';
import { upsertLead } from '../repositories/leadRepository.js';
import { createJob, updateJob } from '../repositories/jobRepository.js';

/**
 * Fila em memória com concorrência 1: um navegador por vez reduz
 * consumo de recursos e o risco de bloqueio pelo Google.
 */
export function createScrapeQueue({ logger }) {
  const pending = [];
  let running = false;

  async function runJob(job) {
    const log = logger.child({ jobId: job.id });
    const stats = { found: 0, inserted: 0, updated: 0 };

    await updateJob(job.id, { status: 'RUNNING', started_at: db.fn.now() });
    log.info({ searchTerm: job.searchTerm }, 'Scraping iniciado');

    try {
      await scrapeGoogleMaps(job.searchTerm, {
        maxResults: job.maxResults,
        headless: config.scraper.headless,
        logger: log,
        onLead: async (rawLead) => {
          const lead = classifyLead({ ...rawLead, searchTerm: job.searchTerm });
          const { created } = await upsertLead(lead);

          stats.found += 1;
          stats[created ? 'inserted' : 'updated'] += 1;
          await updateJob(job.id, stats);
        },
      });

      await updateJob(job.id, { ...stats, status: 'DONE', finished_at: db.fn.now() });
      log.info(stats, 'Scraping concluído');
    } catch (err) {
      await updateJob(job.id, { ...stats, status: 'FAILED', error: err.message, finished_at: db.fn.now() });
      log.error({ err }, 'Scraping falhou');
    }
  }

  async function processNext() {
    if (running) return;
    const job = pending.shift();
    if (!job) return;

    running = true;
    try {
      await runJob(job);
    } finally {
      running = false;
      setImmediate(processNext);
    }
  }

  return {
    async enqueue({ searchTerm, maxResults }) {
      const job = { id: randomUUID(), searchTerm, maxResults };
      await createJob(job);
      pending.push(job);
      const position = pending.length + (running ? 1 : 0);
      setImmediate(processNext);
      return { ...job, position };
    },
  };
}
