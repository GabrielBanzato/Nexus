/**
 * País, idioma e fuso de um lead a partir do endereço e do telefone do Google Maps.
 *
 * O scraper usa o Maps em pt-BR: empresas de fora vêm com o país no fim do endereço
 * ("..., Austin, TX 78701, Estados Unidos" / "..., Sydney NSW 2000, Austrália") e o telefone
 * em formato internacional ("+1 512-256-2426", "+61 2 9188 8501"). As brasileiras vêm sem país
 * e com o telefone nacional ("(41) 3057-9999").
 * Ordem: país no endereço → DDI do telefone (com "+") → Brasil.
 */

const COUNTRIES = [
  { code: 'BR', dial: '55', lang: 'pt', label: 'Brasil', flag: '🇧🇷', tz: 'America/Sao_Paulo', names: ['brasil', 'brazil'] },
  { code: 'PT', dial: '351', lang: 'pt', label: 'Portugal', flag: '🇵🇹', tz: 'Europe/Lisbon', names: ['portugal'] },
  { code: 'US', dial: '1', lang: 'en', label: 'EUA', flag: '🇺🇸', tz: 'America/New_York', names: ['estados unidos', 'eua', 'united states', 'usa'] },
  { code: 'CA', dial: '1', lang: 'en', label: 'Canadá', flag: '🇨🇦', tz: 'America/Toronto', names: ['canada'] },
  { code: 'AU', dial: '61', lang: 'en', label: 'Austrália', flag: '🇦🇺', tz: 'Australia/Sydney', names: ['australia'] },
  { code: 'NZ', dial: '64', lang: 'en', label: 'Nova Zelândia', flag: '🇳🇿', tz: 'Pacific/Auckland', names: ['nova zelandia', 'new zealand'] },
  { code: 'GB', dial: '44', lang: 'en', label: 'Reino Unido', flag: '🇬🇧', tz: 'Europe/London', names: ['reino unido', 'united kingdom', 'inglaterra', 'escocia', 'pais de gales'] },
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
const AU_TZ = { NSW: 'Australia/Sydney', ACT: 'Australia/Sydney', VIC: 'Australia/Melbourne', TAS: 'Australia/Hobart', QLD: 'Australia/Brisbane', SA: 'Australia/Adelaide', NT: 'Australia/Darwin', WA: 'Australia/Perth' };
const CA_TZ = { ON: 'America/Toronto', QC: 'America/Toronto', BC: 'America/Vancouver', AB: 'America/Edmonton', MB: 'America/Winnipeg', SK: 'America/Regina', NS: 'America/Halifax', NB: 'America/Halifax', PE: 'America/Halifax', NL: 'America/St_Johns' };
const BR_TZ = { AM: 'America/Manaus', RR: 'America/Boa_Vista', RO: 'America/Porto_Velho', MT: 'America/Cuiaba', MS: 'America/Campo_Grande', AC: 'America/Rio_Branco' };

const plain = (text) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function countryFromAddress(address) {
  const last = plain(String(address ?? '').split(',').pop() ?? '');
  if (!last) return null;
  return COUNTRIES.find((c) => c.names.includes(last)) ?? null;
}

function countryFromPhone(phone) {
  const raw = String(phone ?? '').trim();
  if (!raw.startsWith('+')) return null;
  const digits = raw.replace(/\D/g, '');
  // DDI mais longo primeiro (351 antes de 35..., 598 antes de 59...); "+1" = EUA (o Canadá vem pelo endereço).
  const match = COUNTRIES.filter((c) => digits.startsWith(c.dial) && c.code !== 'CA').sort((a, b) => b.dial.length - a.dial.length)[0];
  return match ?? { code: 'XX', dial: '', lang: 'en', label: 'Exterior', flag: '🌍', tz: null, names: [] };
}

function zoneFor(country, address) {
  const text = String(address ?? '');
  if (country.code === 'US') {
    const state = text.match(/\b([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/)?.[1];
    const zone = state && Object.entries(US_TZ).find(([, states]) => states.split(' ').includes(state))?.[0];
    return zone ?? country.tz;
  }
  if (country.code === 'AU') return AU_TZ[text.match(/\b(NSW|ACT|VIC|TAS|QLD|SA|NT|WA)\s+\d{4}\b/)?.[1]] ?? country.tz;
  if (country.code === 'CA') return CA_TZ[text.match(/\b(ON|QC|BC|AB|MB|SK|NS|NB|PE|NL)\s+[A-Z]\d[A-Z]/)?.[1]] ?? country.tz;
  if (country.code === 'BR') return BR_TZ[text.match(/\s-\s([A-Z]{2})(?:,|\s*$)/)?.[1]] ?? country.tz;
  return country.tz;
}

/**
 * @returns {{ code: string, lang: 'pt'|'en'|'es', label: string, flag: string, timeZone: string|null, foreign: boolean }}
 */
export function detectCountry({ address, phone } = {}) {
  const country = countryFromAddress(address) ?? countryFromPhone(phone) ?? BY_CODE.BR;
  return {
    code: country.code,
    lang: country.lang,
    label: country.label,
    flag: country.flag,
    timeZone: zoneFor(country, address),
    foreign: country.code !== 'BR',
  };
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
