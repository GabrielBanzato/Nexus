import { INSIGHTS_SCHEMA, PROPOSAL_SCHEMA, clientQuestions, insightsMessages, mergeInsights, proposalMessages } from '../ai/meetingPrompt.js';
import { db } from '../config/database.js';
import { findClientById } from '../repositories/clientRepository.js';
import { findMeetingById } from '../repositories/meetingRepository.js';
import { clientContext } from './clientContext.js';

const MAX_AUDIO_BYTES = 2 * 1024 * 1024; // um pedaço de 15 s em opus tem ~40–60 KB
const MIN_AUDIO_BYTES = 1_000;
const MAX_BACKLOG = 30; // pedaços à espera de transcrição (~7 min de fala): acima disso, descarta
const ANALYZE_MIN_CHARS = 250; // texto novo mínimo para valer uma análise
const ANALYZE_EVERY_MS = 40_000;
const ANALYZE_NOW_CHARS = 1_200; // muito texto acumulado: analisa já
const CONTEXT_SEGMENTS = 4; // falas anteriores levadas junto, para o modelo perceber o contexto
const STATE_SEGMENTS = 300;

// Termos que o Whisper costuma errar sem dica (o "prompt" inicial só orienta o vocabulário).
const VOCAB = {
  pt: 'Reunião de vendas da Nexus: site, cardápio digital, loja virtual, sistema, ERP, PDV, iFood, WhatsApp, Instagram, Google, sócio, sócia.',
  en: 'Nexus sales call: website, online menu, online store, POS, WhatsApp, Instagram, Google, DoorDash, Uber Eats.',
  es: 'Reunión de ventas de Nexus: sitio web, menú digital, tienda online, sistema, WhatsApp, Instagram, Google.',
};

// "Alucinações" clássicas do Whisper em trechos quase mudos (legendas de vídeos do treino).
const HALLUCINATION = /amara\.org|legendas pela comunidade|inscreva-se|obrigad[oa] por assistir|thanks for watching|subt[ií]tulos/i;

/**
 * Nex nas reuniões: recebe o áudio de cada participante em pedaços (do navegador de quem
 * conduz), transcreve no Whisper local, guarda a conversa e, a cada trecho com texto
 * suficiente, pede ao modelo os pontos novos (dores, objeções, sinais) e uma dica. As dúvidas
 * do cliente saem do próprio texto (frases dele com "?").
 *
 * Só a equipe recebe isto (sala "meet-staff:<id>" do namespace /meet); os convidados só veem o
 * aviso de que a reunião está a ser transcrita (meet:nex).
 *
 * Um envio por reunião: se duas pessoas da equipe estiverem na chamada, só a primeira a enviar
 * áudio transcreve (senão a conversa entraria duas vezes); as outras só veem o painel.
 *
 * @param {object} opts
 * @param {ReturnType<import('./transcriber.js').createTranscriber>|null} opts.transcriber
 * @param {() => object|null} opts.getModel cliente do modelo (Ollama ou Claude: mesma interface)
 * @param {import('socket.io').Server} opts.io
 */
export function createMeetingNex({ transcriber, getModel, io, logger, timeZone }) {
  const nsp = () => io.of('/meet');
  const meetings = new Map(); // meetingId → estado em memória
  let transcribeQueue = Promise.resolve();
  let backlog = 0;
  let analyzeQueue = Promise.resolve();

  const staffRoom = (meetingId) => `meet-staff:${meetingId}`;
  const toStaff = (meetingId, event, payload) => nsp().to(staffRoom(meetingId)).emit(event, payload);
  const serial = (queue, task) => {
    const run = queue.then(task, task);
    return [run, run.catch(() => {})];
  };

  /** Estado da reunião (ficha do cliente e idioma calculados uma vez). */
  async function stateOf(meetingId) {
    let state = meetings.get(meetingId);
    if (state) return state;
    state = { uploader: null, listening: false, pending: [], recent: [], lastAnalysisAt: 0, analyzing: false, insights: null, context: '', lang: 'pt', dealId: null, lastBySpeaker: new Map() };
    meetings.set(meetingId, state);
    const meeting = await findMeetingById(meetingId);
    state.dealId = meeting?.deal_id ?? null;
    try {
      state.insights = typeof meeting?.nex_insights === 'string' ? JSON.parse(meeting.nex_insights) : meeting?.nex_insights ?? null;
    } catch {
      state.insights = null;
    }
    const client = meeting?.client_id ? await findClientById(meeting.client_id) : null;
    if (client) {
      const ctx = await clientContext(client, { timeZone, dealId: meeting.deal_id ?? undefined }).catch(() => null);
      if (ctx) Object.assign(state, { context: ctx.text, lang: ctx.lang, dealId: state.dealId ?? ctx.deal?.id ?? null });
    }
    state.recent = (await listSegments(meetingId, CONTEXT_SEGMENTS)).map(toPrompt);
    return state;
  }

  async function listSegments(meetingId, limit = STATE_SEGMENTS) {
    const rows = await db('meeting_transcripts')
      .where({ meeting_id: meetingId })
      .orderBy([{ column: 'offset_ms', order: 'desc' }, { column: 'id', order: 'desc' }])
      .limit(limit)
      .select('id', 'speaker_role as role', 'speaker_name as name', 'offset_ms', 'text');
    return rows.reverse();
  }

  const toPrompt = (s) => ({ role: s.role, text: s.text, line: `${s.role === 'guest' ? 'Cliente' : 'Vendedor'} (${s.name}): ${s.text}` });

  /** Quem fala neste pedaço: "self" = quem envia; senão o id do socket do participante. */
  function speakerOf(socket, source) {
    if (source === 'self') return { role: 'staff', name: socket.data.name };
    const peer = nsp().sockets.get(String(source));
    if (peer && peer.data.meetingId === socket.data.meetingId) return { role: peer.data.staff ? 'staff' : 'guest', name: peer.data.name };
    return { role: 'guest', name: 'Cliente' };
  }

  function setListening(meetingId, state, on) {
    if (state.listening === on) return;
    state.listening = on;
    // Todos na sala sabem que a conversa está a ser transcrita (LGPD), como na gravação.
    nsp().to(`meet:${meetingId}`).emit('meet:nex', { on });
  }

  async function transcribeChunk(meetingId, state, speaker, offsetMs, audio) {
    let result;
    try {
      // Vocabulário + o fim da fala anterior da mesma pessoa: o pedaço de 15 s corta frases a meio,
      // e com o contexto o Whisper acerta melhor as palavras do começo.
      const previous = state.lastBySpeaker.get(speaker.name) ?? '';
      result = await transcriber.transcribe(audio, { language: state.lang, prompt: `${VOCAB[state.lang] ?? VOCAB.pt} ${previous}`.trim() });
    } catch (err) {
      logger.warn({ err: err.message, meetingId }, 'Nex: falha ao transcrever um trecho');
      if (err.status !== 422) toStaff(meetingId, 'nex:status', { transcription: 'error', error: err.message });
      return;
    }
    const text = String(result.text ?? '').replace(/\s+/g, ' ').trim();
    if (text.length < 2 || HALLUCINATION.test(text)) return;
    state.lastBySpeaker.set(speaker.name, text.slice(-200));
    const [id] = await db('meeting_transcripts').insert({ meeting_id: meetingId, speaker_role: speaker.role, speaker_name: speaker.name.slice(0, 80), offset_ms: Math.max(0, Math.round(offsetMs)), text });
    const segment = { id, role: speaker.role, name: speaker.name, offset_ms: offsetMs, text };
    toStaff(meetingId, 'nex:transcript', segment);
    state.pending.push(toPrompt(segment));
    maybeAnalyze(meetingId, state);
  }

  function maybeAnalyze(meetingId, state, { force = false } = {}) {
    if (!getModel() || state.analyzing) return;
    const chars = state.pending.reduce((n, s) => n + s.text.length, 0);
    if (!chars) return;
    const due = chars >= ANALYZE_NOW_CHARS || (chars >= ANALYZE_MIN_CHARS && Date.now() - state.lastAnalysisAt >= ANALYZE_EVERY_MS);
    if (!force && !due) return;
    state.analyzing = true;
    const batch = state.pending.splice(0);
    [, analyzeQueue] = serial(analyzeQueue, () => analyze(meetingId, state, batch));
  }

  async function analyze(meetingId, state, batch) {
    toStaff(meetingId, 'nex:status', { analyzing: true });
    try {
      const transcript = [...state.recent, ...batch].map((s) => s.line).join('\n');
      const ask = (temperature) => getModel().chat({ messages: insightsMessages({ context: state.context, insights: state.insights, transcript }), format: INSIGHTS_SCHEMA, temperature, maxTokens: 500 });
      const found = (await ask(0.2).catch(() => ask(0))).data;
      found.questions = clientQuestions(batch);
      state.insights = mergeInsights(state.insights, found);
      state.recent = [...state.recent, ...batch].slice(-CONTEXT_SEGMENTS);
      await db('meetings').where({ id: meetingId }).update({ nex_insights: JSON.stringify(state.insights), nex_updated_at: new Date() });
      toStaff(meetingId, 'nex:insights', state.insights);
    } catch (err) {
      state.pending.unshift(...batch); // não perde o trecho: entra na próxima análise
      logger.warn({ err: err.message, meetingId }, 'Nex: falha ao analisar a reunião');
    } finally {
      state.lastAnalysisAt = Date.now();
      state.analyzing = false;
      toStaff(meetingId, 'nex:status', { analyzing: false });
    }
  }

  return {
    available: Boolean(transcriber),
    isListening: (meetingId) => Boolean(meetings.get(meetingId)?.listening),

    /** Para o painel ao entrar: o que já foi dito e anotado. */
    async snapshot(meetingId) {
      const state = await stateOf(meetingId);
      return {
        available: Boolean(transcriber),
        analysis: Boolean(getModel()),
        listening: state.listening,
        has_deal: Boolean(state.dealId),
        segments: await listSegments(meetingId),
        insights: state.insights ?? {},
      };
    },

    /** Pedaço de áudio de um participante (do navegador de quem conduz). */
    async handleAudio(socket, meta = {}, audio) {
      const { meetingId, staff, admitted } = socket.data;
      if (!transcriber || !staff || !admitted || !Buffer.isBuffer(audio)) return;
      if (audio.length < MIN_AUDIO_BYTES || audio.length > MAX_AUDIO_BYTES) return;
      const state = await stateOf(meetingId);
      if (state.uploader && state.uploader !== socket.id && nsp().sockets.has(state.uploader)) return;
      if (state.uploader !== socket.id) logger.info({ meetingId, by: socket.data.name }, 'Nex: a transcrever a reunião');
      state.uploader = socket.id;
      setListening(meetingId, state, true);
      if (backlog >= MAX_BACKLOG) {
        logger.warn({ meetingId, backlog }, 'Nex: transcrição atrasada; trecho descartado');
        return;
      }
      backlog += 1;
      const speaker = speakerOf(socket, meta.source);
      const offsetMs = Number(meta.offsetMs) || 0;
      [, transcribeQueue] = serial(transcribeQueue, () => transcribeChunk(meetingId, state, speaker, offsetMs, audio).finally(() => (backlog -= 1)));
    },

    /** "Pausar Nex": deixa de transcrever (e os convidados deixam de ver o aviso). */
    async setPaused(socket, paused) {
      const { meetingId, staff } = socket.data;
      if (!staff) return;
      const state = await stateOf(meetingId);
      if (paused) {
        if (state.uploader === socket.id) state.uploader = null;
        setListening(meetingId, state, false);
      }
      toStaff(meetingId, 'nex:status', { paused: Boolean(paused) });
    },

    /** "Atualizar pontos": analisa já o que houver de novo. */
    async analyzeNow(socket) {
      if (!socket.data.staff) return;
      const state = await stateOf(socket.data.meetingId);
      maybeAnalyze(socket.data.meetingId, state, { force: true });
    },

    /** "Sugerir proposta": rascunho com tudo o que se ouviu. */
    async propose(socket) {
      const { meetingId, staff } = socket.data;
      if (!staff) return { error: 'FORBIDDEN' };
      const model = getModel();
      if (!model) return { error: 'Nex sem modelo de IA neste servidor (AI_ENABLED).' };
      const state = await stateOf(meetingId);
      const transcript = (await listSegments(meetingId, 40)).map((s) => toPrompt(s).line).join('\n').slice(-3000);
      if (!transcript) return { error: 'Ainda não há conversa transcrita para montar a proposta.' };
      const ask = (temperature) => model.chat({ messages: proposalMessages({ context: state.context, insights: state.insights, transcript, lang: state.lang }), format: PROPOSAL_SCHEMA, temperature, maxTokens: 900 });
      try {
        const { data } = await ask(0.4).catch(() => ask(0.1));
        return { proposal: data };
      } catch (err) {
        logger.warn({ err: err.message, meetingId }, 'Nex: falha ao sugerir a proposta');
        return { error: 'O Nex não conseguiu montar a proposta agora. Tente de novo.' };
      }
    },

    /** Guarda as dores e objeções anotadas no negócio da reunião (campo "dores" do pipeline). */
    async saveToDeal(socket) {
      const { meetingId, staff } = socket.data;
      if (!staff) return { error: 'FORBIDDEN' };
      const state = await stateOf(meetingId);
      if (!state.dealId) return { error: 'Esta reunião não está ligada a um negócio do pipeline.' };
      const deal = await db('deals').where({ id: state.dealId }).first('id', 'pains');
      if (!deal) return { error: 'O negócio desta reunião já não existe.' };
      const current = String(deal.pains ?? '');
      const lines = [...(state.insights?.pains ?? []), ...(state.insights?.objections ?? []).map((o) => `Receio: ${o}`)]
        .map((p) => `• ${p}`)
        .filter((line) => !current.includes(line.slice(2)));
      if (!lines.length) return { saved: 0 };
      const pains = [current.trim(), lines.join('\n')].filter(Boolean).join('\n').slice(0, 60_000);
      await db('deals').where({ id: deal.id }).update({ pains });
      return { saved: lines.length, deal_id: deal.id };
    },

    /** Saiu da sala: se era quem transcrevia, a transcrição pára (e o aviso some). */
    onDisconnect(socket) {
      const state = meetings.get(socket.data?.meetingId);
      if (!state || state.uploader !== socket.id) return;
      state.uploader = null;
      setListening(socket.data.meetingId, state, false);
    },

    /** Reunião encerrada: análise final do que faltar e liberta a memória. */
    async onEnded(meetingId) {
      const state = meetings.get(meetingId);
      if (!state) return;
      maybeAnalyze(meetingId, state, { force: true });
      await analyzeQueue;
      meetings.delete(meetingId);
    },

    transcriber,
  };
}
