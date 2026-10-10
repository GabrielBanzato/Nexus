/**
 * Cliente mínimo da API do Ollama (/api/chat, /api/tags, /api/pull), sem dependências.
 *
 * keep_alive = -1: o modelo fica SEMPRE carregado na RAM (~2 GB no qwen3.5:2b-q4_K_M).
 * Descarregá-lo entre conversas faria cada primeira resposta pagar a recarga do disco.
 */
export function createOllamaClient({ baseUrl, model, numThread, timeoutMs, logger }) {
  const call = async (path, body, { timeout = timeoutMs } = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw Object.assign(new Error(`Ollama ${path}: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim()), { status: res.status });
    return res.json();
  };

  const options = (extra = {}) => ({
    num_ctx: 4096, // histórico curto + system: sobra margem; mais contexto = mais RAM
    ...(numThread > 0 && { num_thread: numThread }),
    ...extra,
  });

  return {
    model,

    /**
     * Uma resposta com saída estruturada (`format` = JSON Schema: a geração fica restrita à
     * gramática do schema). think=false: Qwen 3/3.5 sem modo de raciocínio (lento na CPU).
     * @returns {Promise<{ data: object, stats: { prompt_tokens, tokens, ms } }>}
     */
    async chat({ messages, format, temperature = 0.3, maxTokens = 220 }) {
      const r = await call('/api/chat', {
        model,
        messages,
        format,
        stream: false,
        think: false,
        keep_alive: -1,
        options: options({ temperature, num_predict: maxTokens }),
      });
      let data;
      try {
        data = JSON.parse(r.message?.content ?? '');
      } catch {
        throw new Error(`Resposta do modelo não é JSON: ${String(r.message?.content).slice(0, 200)}`);
      }
      return { data, stats: { prompt_tokens: r.prompt_eval_count, tokens: r.eval_count, ms: Math.round((r.total_duration ?? 0) / 1e6) } };
    },

    /** Ollama no ar e modelo descarregado/carregado? Para o painel de estado. */
    async status() {
      try {
        const [tags, ps] = await Promise.all([call('/api/tags', null, { timeout: 3000 }), call('/api/ps', null, { timeout: 3000 })]);
        return {
          reachable: true,
          model_available: (tags.models ?? []).some((m) => m.name === model),
          model_loaded: (ps.models ?? []).some((m) => m.name === model),
        };
      } catch (err) {
        return { reachable: false, model_available: false, model_loaded: false, error: err.message };
      }
    },

    /**
     * Garante o modelo (baixa se faltar: ~1,9 GB) e carrega-o na RAM. Chamado no arranque, em
     * segundo plano; tenta de novo enquanto o Ollama ainda estiver a subir.
     */
    async warmup({ retries = 30, delayMs = 10_000 } = {}) {
      for (let attempt = 1; ; attempt += 1) {
        try {
          const { reachable, model_available: available } = await this.status();
          if (!reachable) throw new Error('Ollama inacessível');
          if (!available) {
            logger.info({ model }, 'IA: a baixar o modelo (só na primeira vez, pode demorar alguns minutos)');
            await call('/api/pull', { model, stream: false }, { timeout: 60 * 60_000 });
          }
          // Pedido vazio = só carrega o modelo e mantém-no residente.
          await call('/api/generate', { model, keep_alive: -1, options: options() }, { timeout: 5 * 60_000 });
          logger.info({ model }, 'IA: modelo carregado e pronto');
          return true;
        } catch (err) {
          if (attempt >= retries) {
            logger.error({ err, model }, 'IA: não foi possível preparar o modelo; o agente fica inativo até o Ollama responder');
            return false;
          }
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    },
  };
}
