import { db } from '../config/database.js';

export async function createJob({ id, searchTerm, maxResults }) {
  await db('scrape_jobs').insert({
    id,
    search_term: searchTerm,
    max_results: maxResults,
    status: 'PENDING',
  });
}

export async function updateJob(id, fields) {
  await db('scrape_jobs').where({ id }).update(fields);
}

export async function findJobById(id) {
  return db('scrape_jobs').where({ id }).first();
}
