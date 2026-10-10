const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/**
 * Cliente mínimo da API do Claude (Anthropic), com a MESMA interface do ollamaClient
 * (chat / status / warmup): o Nex e as sugestões funcionam com qualquer um dos dois.
 *
 * Saída estruturada por "tool use" forçado: o modelo tem de chamar a ferramenta `responder`
 * com um input que segue o JSON Schema pedido — o JSON vem sempre válido.
 *
 * Atenção: com este provedor, o texto das conversas sai do servidor para a Anthropic.
 */
export function createAnthropicClient({ apiKey, model, timeoutMs, logger }) {
  /** A API quer o system à parte e turnos user/assistant alternados, a começar por user. */
  function toAnthropic(messages) {
    const system = [];
    const turns = [];
    for (const m of messages) {
      if (m.role === 'system') {
        if (!turns.length) system.push(m.content);
        else turns.push({ role: 'user', content: m.content });
        continue;
      }
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      const prev = turns.at(-1);
      if (prev?.role === role) prev.content += `\n\n${m.content}`;
      else turns.push({ role, content: m.content });
    }
    if (turns[0]?.role !== 'user') turns.unshift({ role: 'user', content: '(início)' });
    return { system: system.join('\n\n'), messages: turns };
  }

  async function call(body, { timeout = timeoutMs } = {}) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': API_VERSION },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw Object.assign(new Error(`Claude: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim()), { status: res.status });
    return res.json();
  }

  return {
    model,

    /** @returns {Promise<{ data: object, stats: { prompt_tokens, tokens, ms } }>} */
    async chat({ messages, format, temperature = 0.3, maxTokens = 220 }) {
      const started = Date.now();
      const { system, messages: turns } = toAnthropic(messages);
      const r = await call({
        model,
        system,
        messages: turns,
        temperature,
        // Folga: o Claude escreve mais solto que o modelo local e o JSON não pode vir cortado.
        max_tokens: Math.max(maxTokens * 2, 512),
        tools: [{ name: 'responder', description: 'Entrega a resposta no formato pedido.', input_schema: format }],
        tool_choice: { type: 'tool', name: 'responder' },
      });
      const data = r.content?.find((c) => c.type === 'tool_use')?.input;
      if (!data || typeof data !== 'object') throw new Error(`Claude não devolveu a resposta estruturada (stop_reason=${r.stop_reason})`);
      return { data, stats: { prompt_tokens: r.usage?.input_tokens, tokens: r.usage?.output_tokens, ms: Date.now() - started } };
    },

    /** Painel de estado: a chave funciona? (Um pedido mínimo, sem gerar quase nada.) */
    async status() {
      try {
        await call({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] }, { timeout: 10_000 });
        return { reachable: true, model_available: true, model_loaded: true };
      } catch (err) {
        return { reachable: false, model_available: false, model_loaded: false, error: err.message };
      }
    },

    /** Nada a carregar: só confere a chave e avisa no log. */
    async warmup() {
      const s = await this.status();
      if (s.reachable) logger.info({ model }, 'IA: Claude pronto');
      else logger.error({ model, error: s.error }, 'IA: Claude inacessível (confira ANTHROPIC_API_KEY e AI_MODEL)');
      return s.reachable;
    },
  };
}
