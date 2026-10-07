/**
 * Horas no fuso da empresa (o servidor corre em UTC): "8h de hoje em São Paulo", "próximas 7h".
 */

/** Partes da data no fuso `timeZone`. */
function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** Instante (UTC) em que, no fuso `timeZone`, são `hour`:00 do mesmo dia de `date`. */
export function sameDayAt(date, hour, timeZone) {
  const p = zonedParts(date, timeZone);
  const guess = Date.UTC(p.year, p.month - 1, p.day, hour);
  const q = zonedParts(new Date(guess), timeZone);
  const offset = Date.UTC(q.year, q.month - 1, q.day, q.hour, q.minute, q.second) - guess;
  return new Date(guess - offset);
}

/** Próxima vez (depois de `now`) em que são `hour`:00 no fuso `timeZone`. */
export function nextDailyRun(now, hour, timeZone) {
  const today = sameDayAt(now, hour, timeZone);
  if (today > now) return today;
  // +26h cai sempre no dia seguinte (mesmo em dias de 23h/25h com horário de verão).
  return sameDayAt(new Date(today.getTime() + 26 * 60 * 60_000), hour, timeZone);
}

/**
 * Corre `task` todos os dias às `hour`:00 no fuso `timeZone`. Reagenda-se depois de cada
 * execução (setTimeout até à próxima, não um intervalo fixo: não acumula desvio).
 * @returns {{ stop: () => void, next: () => Date|null }}
 */
export function scheduleDaily({ hour, timeZone, task, logger }) {
  let timer = null;
  let nextAt = null;
  let stopped = false;

  const arm = () => {
    if (stopped) return;
    nextAt = nextDailyRun(new Date(), hour, timeZone);
    // setTimeout aceita no máximo ~24,8 dias; aqui são no máximo ~25h.
    timer = setTimeout(async () => {
      try {
        await task();
      } catch (err) {
        logger?.error({ err }, 'Tarefa diária falhou');
      }
      arm();
    }, nextAt.getTime() - Date.now());
    timer.unref?.();
  };
  arm();

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    next: () => nextAt,
  };
}
