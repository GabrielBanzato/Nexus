// Testa o scraper isoladamente, sem API nem banco.
// Uso: npm run scrape -- "Pizzarias em São Paulo" 10
import { scrapeGoogleMaps } from '../src/services/googleMapsScraper.js';
import { classifyLead } from '../src/services/leadClassifier.js';

const [term = 'Pizzarias em São Paulo', max = '10'] = process.argv.slice(2);

const leads = await scrapeGoogleMaps(term, {
  maxResults: Number(max),
  headless: process.env.SCRAPER_HEADLESS !== 'false',
  onLead: (lead) => console.log(classifyLead(lead)),
});

console.log(`\nTotal extraído: ${leads.length}`);
