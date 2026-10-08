/**
 * País, idioma e fuso de um lead a partir do endereço e do telefone do Google Maps — por regras
 * (instantâneo e sem erro de "adivinhação"; a IA não entra aqui).
 *
 * O Maps formata conforme a região de QUEM PESQUISA: do Brasil, uma empresa americana vem com
 * "..., Austin, TX 78701, Estados Unidos" e "+1 512-256-2426"; de um servidor nos EUA vem sem país
 * ("..., Boston, MA 02115") e com o telefone local ("(857) 305-3392"). Por isso, por ordem:
 *  1. país escrito no fim do endereço;
 *  2. formato do endereço: EUA "MA 02115", Austrália "NSW 2000", Canadá "ON M5H 1A1",
 *     Reino Unido "SW1A 1AA", Brasil "Curitiba - PR, 80420-210";
 *  3. telefone com "+DDI";
 *  4. formato do telefone local: EUA/Canadá "(857) 305-3392", Austrália "(02) 9188 8501";
 *  5. Brasil.
 *
 * ESTE FICHEIRO EXISTE EM DOIS SÍTIOS IGUAIS: frontend/src/utils/country.js (mensagens) e
 * src/lib/country.js (servidor: guardar o telefone com DDI). Altere os dois.
 */

const COUNTRIES = [
  { code: 'BR', dial: '55', lang: 'pt', label: 'Brasil', flag: '🇧🇷', tz: 'America/Sao_Paulo', names: ['brasil', 'brazil'] },
  { code: 'PT', dial: '351', lang: 'pt', label: 'Portugal', flag: '🇵🇹', tz: 'Europe/Lisbon', names: ['portugal'] },
  { code: 'US', dial: '1', lang: 'en', label: 'EUA', flag: '🇺🇸', tz: 'America/New_York', names: ['estados unidos', 'eua', 'united states', 'usa', 'us'] },
  { code: 'CA', dial: '1', lang: 'en', label: 'Canadá', flag: '🇨🇦', tz: 'America/Toronto', names: ['canada'] },
  { code: 'AU', dial: '61', lang: 'en', label: 'Austrália', flag: '🇦🇺', tz: 'Australia/Sydney', names: ['australia'] },
  { code: 'NZ', dial: '64', lang: 'en', label: 'Nova Zelândia', flag: '🇳🇿', tz: 'Pacific/Auckland', names: ['nova zelandia', 'new zealand'] },
  { code: 'GB', dial: '44', lang: 'en', label: 'Reino Unido', flag: '🇬🇧', tz: 'Europe/London', names: ['reino unido', 'united kingdom', 'uk', 'inglaterra', 'escocia', 'pais de gales'] },
  { code: 'IE', dial: '353', lang: 'en', label: 'Irlanda', flag: '🇮🇪', tz: 'Europe/Dublin', names: ['irlanda', 'ireland'] },
  { code: 'ZA', dial: '27', lang: 'en', label: 'África do Sul', flag: '🇿🇦', tz: 'Africa/Johannesburg', names: ['africa do sul', 'south africa'] },
  { code: 'ES', dial: '34', lang: 'es', label: 'Espanha', flag: '🇪🇸', tz: 'Europe/Madrid', names: ['espanha', 'espana', 'spain'] },
  { code: 'MX', dial: '52', lang: 'es', label: 'México', flag: '🇲🇽', tz: 'America/Mexico_City', names: ['mexico'] },
  { code: 'AR', dial: '54', lang: 'es', label: 'Argentina', flag: '🇦🇷', tz: 'America/Argentina/Buenos_Aires', names: ['argentina'] },
  { code: 'CL', dial: '56', lang: 'es', label: 'Chile', flag: '🇨🇱', tz: 'America/Santiago', names: ['chile'] },
  { code: 'CO', dial: '57', lang: 'es', label: 'Colômbia', flag: '🇨🇴', tz: 'America/Bogota', names: ['colombia'] },
  { code: 'PE', dial: '51', lang: 'es', label: 'Peru', flag: '🇵🇪', tz: 'America/Lima', names: ['peru'] },
  { code: 'UY', dial: '598', lang: 'es', label: 'Uruguai', flag: '🇺🇾', tz: 'America/Montevideo', names: ['uruguai', 'uruguay'] },
  { code: 'PY', dial: '595', lang: 'es', label: 'Paraguai', flag: '🇵🇾', tz: 'America/Asuncion', names: ['paraguai', 'paraguay'] },
];
const BY_CODE = Object.fromEntries(COUNTRIES.map((c) => [c.code, c]));

// Fusos dentro dos países grandes (pela sigla do estado no endereço).
const US_TZ = {
  'America/New_York': 'CT DE DC FL GA IN KY ME MD MA MI NH NJ NY NC OH PA RI SC VT VA WV',
  'America/Chicago': 'AL AR IL IA KS LA MN MS MO NE ND OK SD TN TX WI',
  'America/Denver': 'CO ID MT NM UT WY',
  'America/Phoenix': 'AZ',
  'America/Los_Angeles': 'CA NV OR WA',
  'America/Anchorage': 'AK',
  'Pacific/Honolulu': 'HI',
};
const US_STATES = new Set(Object.values(US_TZ).join(' ').split(' ').concat('PR'));
const AU_TZ = { NSW: 'Australia/Sydney', ACT: 'Australia/Sydney', VIC: 'Australia/Melbourne', TAS: 'Australia/Hobart', QLD: 'Australia/Brisbane', SA: 'Australia/Adelaide', NT: 'Australia/Darwin', WA: 'Australia/Perth' };
const CA_TZ = { ON: 'America/Toronto', QC: 'America/Toronto', BC: 'America/Vancouver', AB: 'America/Edmonton', MB: 'America/Winnipeg', SK: 'America/Regina', NS: 'America/Halifax', NB: 'America/Halifax', PE: 'America/Halifax', NL: 'America/St_Johns', YT: 'America/Whitehorse', NT: 'America/Yellowknife', NU: 'America/Iqaluit' };
const BR_TZ = { AM: 'America/Manaus', RR: 'America/Boa_Vista', RO: 'America/Porto_Velho', MT: 'America/Cuiaba', MS: 'America/Campo_Grande', AC: 'America/Rio_Branco' };

// Padrões do fim do endereço (sem o país).
const ADDRESS_PATTERNS = [
  { code: 'US', re: /\b([A-Z]{2})\s+\d{5}(?:-\d{4})?$/, ok: (m) => US_STATES.has(m[1]) },
  { code: 'AU', re: /\b(NSW|ACT|VIC|TAS|QLD|SA|NT|WA)\s+\d{4}$/ },
  { code: 'CA', re: /\b(ON|QC|BC|AB|MB|SK|NS|NB|PE|NL|YT|NT|NU)\s+[A-Z]\d[A-Z]\s?\d[A-Z]\d$/ },
  { code: 'GB', re: /\b[A-Z]{1,2}\d[A-Z\d]?\s\d[A-Z]{2}$/ },
  { code: 'BR', re: /\s-\s[A-Z]{2}(?:,\s*\d{5}-?\d{3})?$/ },
];

const plain = (text) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const parts = (address) => String(address ?? '').split(',').map((p) => p.trim()).filter(Boolean);

function countryFromAddress(address) {
  const list = parts(address);
  if (!list.length) return null;
  const named = COUNTRIES.find((c) => c.names.includes(plain(list.at(-1))));
  if (named) return named;
  const tail = list.slice(-2).join(', ');
  const hit = ADDRESS_PATTERNS.find((p) => {
    const m = tail.match(p.re);
    return m && (!p.ok || p.ok(m));
  });
  return hit ? BY_CODE[hit.code] : null;
}

function countryFromInternationalPhone(phone) {
  const raw = String(phone ?? '').trim();
  if (!raw.startsWith('+')) return null;
  const digits = raw.replace(/\D/g, '');
  // DDI mais longo primeiro (351 antes de 35..., 598 antes de 59...); "+1" = EUA (o Canadá vem pelo endereço).
  const match = COUNTRIES.filter((c) => digits.startsWith(c.dial) && c.code !== 'CA').sort((a, b) => b.dial.length - a.dial.length)[0];
  return match ?? { code: 'XX', dial: '', lang: 'en', label: 'Exterior', flag: '🌍', tz: null, names: [] };
}

/** Formatos locais inconfundíveis (o Brasil usa "(41) 3057-9999": DDD de 2 dígitos sem zero). */
function countryFromLocalPhone(phone) {
  const raw = String(phone ?? '').trim();
  if (/^\(\d{3}\)\s?\d{3}[-.\s]\d{4}$/.test(raw) || /^\d{3}[-.]\d{3}[-.]\d{4}$/.test(raw)) return BY_CODE.US; // (857) 305-3392
  if (/^\(0\d\)\s?\d{4}\s\d{4}$/.test(raw) || /^04\d{2}\s\d{3}\s\d{3}$/.test(raw) || /^1[38]00\s\d{3}\s\d{3}$/.test(raw)) return BY_CODE.AU; // (02) 9188 8501 / 0412 345 678
  return null;
}

function zoneFor(country, address) {
  const text = String(address ?? '');
  if (country.code === 'US') {
    const state = text.match(/\b([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/)?.[1];
    const zone = state && Object.entries(US_TZ).find(([, states]) => states.split(' ').includes(state))?.[0];
    return zone ?? country.tz;
  }
  if (country.code === 'AU') return AU_TZ[text.match(/\b(NSW|ACT|VIC|TAS|QLD|SA|NT|WA)\s+\d{4}\b/)?.[1]] ?? country.tz;
  if (country.code === 'CA') return CA_TZ[text.match(/\b(ON|QC|BC|AB|MB|SK|NS|NB|PE|NL|YT|NT|NU)\s+[A-Z]\d[A-Z]/)?.[1]] ?? country.tz;
  if (country.code === 'BR') return BR_TZ[text.match(/\s-\s([A-Z]{2})(?:,|\s*$)/)?.[1]] ?? country.tz;
  return country.tz;
}

function resolve({ address, phone }) {
  return countryFromAddress(address) ?? countryFromInternationalPhone(phone) ?? countryFromLocalPhone(phone) ?? BY_CODE.BR;
}

/**
 * @returns {{ code: string, dial: string, lang: 'pt'|'en'|'es', label: string, flag: string, timeZone: string|null, foreign: boolean }}
 */
export function detectCountry({ address, phone } = {}) {
  const country = resolve({ address, phone });
  return {
    code: country.code,
    dial: country.dial,
    lang: country.lang,
    label: country.label,
    flag: country.flag,
    timeZone: zoneFor(country, address),
    foreign: country.code !== 'BR',
  };
}

/**
 * Telefone com DDI para empresas de fora: "(857) 305-3392" (Boston) → "+1 857-305-3392";
 * "(02) 9188 8501" (Sydney) → "+61 2 9188 8501". Brasil e números já com "+" ficam como estão
 * (no Brasil o 55 é posto na hora de enviar). Devolve null se não houver telefone.
 */
export function internationalPhone(phone, address) {
  const raw = String(phone ?? '').trim();
  if (!raw) return null;
  if (raw.startsWith('+')) return raw;
  const country = resolve({ address, phone: raw });
  if (country.code === 'BR' || !country.dial) return raw;
  let digits = raw.replace(/\D/g, '');
  if (country.dial === '1') {
    if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
    if (digits.length !== 10) return raw;
    return `+1 ${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  // Prefixo de chamada nacional "0" sai quando se marca de fora (AU, GB, NZ, ZA...).
  if (digits.startsWith(country.dial) && digits.length > 9) return `+${digits}`;
  const national = raw.replace(/^\(?0(\d)\)?/, '$1').replace(/[()]/g, '').trim();
  return digits.length >= 6 ? `+${country.dial} ${national}` : raw;
}

/** Hora (0–23) agora no fuso da empresa (o do navegador se não se souber). */
export function localHour(timeZone, date = new Date()) {
  if (!timeZone) return date.getHours();
  try {
    return Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(date));
  } catch {
    return date.getHours();
  }
}

export const LANGUAGE_LABELS = { pt: 'português', en: 'inglês', es: 'espanhol' };
