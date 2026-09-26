import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const MAPS_SEARCH_URL = 'https://www.google.com/maps/search/';
const FEED_SELECTOR = 'div[role="feed"]';
const PLACE_LINK_SELECTOR = 'a[href*="/maps/place/"]';
const HARD_LIMIT = 100; // teto de estabelecimentos por busca
const MAX_STALLED_SCROLLS = 4;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomDelay = (min, max) => sleep(min + Math.floor(Math.random() * (max - min)));

/**
 * Busca empresas no Google Maps e extrai os dados de cada uma.
 *
 * @param {string} searchTerm Ex.: "Pizzarias em São Paulo"
 * @param {object} [options]
 * @param {number} [options.maxResults=50]
 * @param {boolean} [options.headless=true]
 * @param {(lead: object) => Promise<void>|void} [options.onLead] Chamado a cada lead extraído (permite persistir incrementalmente).
 * @param {{ info: Function, warn: Function }} [options.logger=console]
 * @returns {Promise<object[]>}
 */
export async function scrapeGoogleMaps(searchTerm, options = {}) {
  const { maxResults = 50, headless = true, onLead, logger = console } = options;

  const browser = await puppeteer.launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      // Em containers o /dev/shm padrão (64MB) derruba o Chrome; usa /tmp no lugar.
      '--disable-dev-shm-usage',
      '--lang=pt-BR',
      '--window-size=1366,900',
    ],
  });

  try {
    const page = await browser.newPage();
    await preparePage(page);

    const url = `${MAPS_SEARCH_URL}${encodeURIComponent(searchTerm)}?hl=pt-BR`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await acceptConsentIfPresent(page);

    const placeUrls = await collectPlaceUrls(page, maxResults, logger);
    logger.info({ searchTerm, total: placeUrls.length }, 'Links de empresas coletados');

    const leads = [];
    for (const [index, placeUrl] of placeUrls.entries()) {
      try {
        const lead = await extractPlaceDetails(page, placeUrl);
        if (!lead.name) continue;

        leads.push(lead);
        await onLead?.(lead);
      } catch (err) {
        logger.warn({ placeUrl, err: err.message }, `Falha ao extrair empresa ${index + 1}/${placeUrls.length}`);
      }
      await randomDelay(800, 2000);
    }

    return leads;
  } finally {
    await browser.close();
  }
}

export async function preparePage(page) {
  await page.setViewport({ width: 1366, height: 900 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' });

  // Bloqueia recursos pesados que não interessam para a extração.
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (['image', 'media', 'font'].includes(req.resourceType())) req.abort();
    else req.continue();
  });
}

/** Tela de consentimento de cookies (comum em IPs europeus). */
async function acceptConsentIfPresent(page) {
  if (!page.url().includes('consent.')) return;

  const clicked = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((b) =>
      /aceitar tudo|accept all|concordo|i agree/i.test(b.textContent),
    );
    button?.click();
    return Boolean(button);
  });

  if (clicked) await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
}

/**
 * Coleta os links das empresas na lista lateral.
 * Fluxo: POST /api/scrape -> scrapeQueue -> scrapeGoogleMaps() -> collectPlaceUrls() -> autoScrollFeed()
 */
export async function collectPlaceUrls(page, maxResults, logger) {
  try {
    await page.waitForSelector(FEED_SELECTOR, { timeout: 20_000 });
  } catch {
    // Busca com resultado único abre direto a página da empresa (não existe feed).
    if (page.url().includes('/maps/place/')) return [page.url()];
    throw new Error('Lista de resultados do Google Maps não encontrada (possível bloqueio ou mudança de layout).');
  }

  const limit = Math.min(maxResults, HARD_LIMIT);
  const { count, reason, scrolls } = await autoScrollFeed(page, { limit });
  logger.info({ count, reason, scrolls }, 'Auto-scroll do feed finalizado');

  const urls = await page.$$eval(`${FEED_SELECTOR} ${PLACE_LINK_SELECTOR}`, (anchors) => anchors.map((a) => a.href));
  const uniqueByPlace = new Map(urls.map((url) => [url.split('?')[0], url]));
  return [...uniqueByPlace.values()].slice(0, limit);
}

/**
 * AUTO-SCROLL DO FEED (lazy loading do Google Maps)
 *
 * O Maps só renderiza ~20 resultados por vez; os próximos são carregados quando a
 * div[role="feed"] é rolada até o fim. Este loop injeta o script de rolagem na página,
 * espera o DOM crescer e repete até:
 *   1. aparecer a mensagem "Você chegou ao final da lista"  -> reason: 'END_OF_LIST'
 *   2. atingir o limite de estabelecimentos (máx. 100)      -> reason: 'LIMIT'
 *   3. a lista parar de crescer por várias tentativas       -> reason: 'STALLED'
 *
 * @returns {Promise<{ count: number, reason: string, scrolls: number }>}
 */
async function autoScrollFeed(page, { limit, maxStalledAttempts = MAX_STALLED_SCROLLS, loadTimeoutMs = 6_000 }) {
  let scrolls = 0;
  let stalled = 0;

  while (true) {
    // Script injetado no contexto da página: rola o feed e lê o estado atual.
    const state = await page.evaluate(
      (feedSelector, linkSelector, wiggle) => {
        const feed = document.querySelector(feedSelector);
        if (!feed) return { count: 0, rawCount: 0, reachedEnd: true };

        const items = feed.querySelectorAll(linkSelector);

        // "Sacudida": quando o carregamento trava, subir um pouco antes de descer
        // força o IntersectionObserver do Google a disparar de novo.
        if (wiggle) feed.scrollBy(0, -600);

        // Traz o último card para a viewport e, em seguida, rola até o fundo do contêiner.
        // A ordem importa: o fundo é onde fica o spinner que dispara o lazy loading.
        items[items.length - 1]?.scrollIntoView({ block: 'end' });
        feed.scrollTo({ top: feed.scrollHeight, behavior: 'instant' });

        // Marcador de fim de lista: texto (pt/en) ou o span de rodapé que o Google usa.
        const reachedEnd =
          Boolean(feed.querySelector('span.HlvSq')) ||
          /chegou ao final da lista|fim dos resultados|reached the end of the list/i.test(
            feed.lastElementChild?.innerText || '',
          );

        // O feed pode repetir o mesmo estabelecimento (ex.: anúncio + resultado orgânico):
        // o limite é aplicado sobre empresas únicas; rawCount serve para detectar crescimento.
        const uniqueCount = new Set(Array.from(items, (a) => a.href.split('?')[0])).size;

        return { count: uniqueCount, rawCount: items.length, reachedEnd };
      },
      FEED_SELECTOR,
      PLACE_LINK_SELECTOR,
      stalled > 0,
    );
    scrolls += 1;

    if (state.count >= limit) return { count: state.count, reason: 'LIMIT', scrolls };
    if (state.reachedEnd) return { count: state.count, reason: 'END_OF_LIST', scrolls };

    // Em vez de um sleep fixo, espera o lazy loading adicionar novos cards ao feed.
    const grew = await page
      .waitForFunction(
        (feedSelector, linkSelector, previous) =>
          (document.querySelector(feedSelector)?.querySelectorAll(linkSelector).length ?? 0) > previous,
        { timeout: loadTimeoutMs, polling: 250 },
        FEED_SELECTOR,
        PLACE_LINK_SELECTOR,
        state.rawCount,
      )
      .then(() => true)
      .catch(() => false);

    stalled = grew ? 0 : stalled + 1;
    if (stalled >= maxStalledAttempts) return { count: state.count, reason: 'STALLED', scrolls };

    // Pausa humana entre rolagens (reduz chance de bloqueio).
    await randomDelay(600, 1400);
  }
}

/** Abre a página da empresa e extrai os campos do painel de detalhes. */
async function extractPlaceDetails(page, placeUrl) {
  await page.goto(placeUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForSelector('h1.DUwDvf, div[role="main"] h1', { timeout: 15_000 });
  // O bloco de informações (endereço/telefone/site) carrega logo após o título.
  await page
    .waitForSelector('button[data-item-id="address"], button[data-item-id^="phone:tel:"], a[data-item-id="authority"]', {
      timeout: 5_000,
    })
    .catch(() => {});

  const raw = await page.evaluate(() => {
    const text = (el) => el?.textContent?.trim() || null;
    const infoText = (el) => text(el?.querySelector('.Io6YTe')) || null;
    const main = document.querySelector('div[role="main"]') || document;

    const addressBtn = main.querySelector('button[data-item-id="address"]');
    const phoneBtn = main.querySelector('button[data-item-id^="phone:tel:"]');
    const websiteLink = main.querySelector('a[data-item-id="authority"]');
    const ratingBox = main.querySelector('div.F7nice');
    const reviewsLabel = main.querySelector('span[aria-label*="avalia" i], span[aria-label*="review" i]');

    return {
      name: text(main.querySelector('h1.DUwDvf')) || text(main.querySelector('h1')),
      category: text(main.querySelector('button[jsaction*="category"]')),
      address:
        infoText(addressBtn) ||
        addressBtn?.getAttribute('aria-label')?.replace(/^(endere[çc]o|address):\s*/i, '').trim() ||
        null,
      phone: infoText(phoneBtn) || phoneBtn?.getAttribute('data-item-id')?.replace('phone:tel:', '') || null,
      website: websiteLink?.href || null,
      ratingText: ratingBox?.innerText || '',
      reviewsLabel: reviewsLabel?.getAttribute('aria-label') || '',
    };
  });

  return {
    name: raw.name,
    category: raw.category,
    address: raw.address,
    phone: raw.phone,
    website: cleanWebsite(raw.website),
    rating: parseRating(raw.ratingText),
    reviewsCount: parseReviewsCount(raw.ratingText, raw.reviewsLabel),
    mapsUrl: placeUrl.split('?')[0],
  };
}

function parseRating(text) {
  const match = text.match(/(\d[.,]\d)/);
  return match ? Number(match[1].replace(',', '.')) : null;
}

function parseReviewsCount(ratingText, ariaLabel) {
  const match = ratingText.match(/\(([\d.,\s ]+)\)/) || ariaLabel.match(/([\d.,\s ]+)/);
  if (!match) return null;
  const digits = match[1].replace(/\D/g, '');
  return digits ? Number(digits) : null;
}

/** Links de site às vezes vêm encapsulados no redirecionador do Google. */
function cleanWebsite(href) {
  if (!href) return null;
  try {
    const url = new URL(href);
    if (url.hostname.includes('google.') && url.pathname === '/url') {
      return url.searchParams.get('q') || url.searchParams.get('url') || href;
    }
    return href;
  } catch {
    return href;
  }
}
