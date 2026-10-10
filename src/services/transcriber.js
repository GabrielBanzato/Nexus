/**
 * Cliente do serviço de transcrição (whisper/app.py: faster-whisper local, só CPU).
 * @returns {{ transcribe: (audio: Buffer, opts?: { language?: string, prompt?: string }) => Promise<{ text, language, duration, segments }>, health: () => Promise<object> }}
 */
export function createTranscriber({ url, timeoutMs = 120_000 }) {
  const base = url.replace(/\/$/, '');
  return {
    async transcribe(audio, { language, prompt } = {}) {
      const query = new URLSearchParams();
      if (language) query.set('language', language);
      if (prompt) query.set('prompt', prompt);
      const res = await fetch(`${base}/transcribe?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: audio,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(`Whisper: HTTP ${res.status} ${body.error ?? ''}`.trim()), { status: res.status });
      return body;
    },

    async health() {
      try {
        const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3_000) });
        return { reachable: true, ...(await res.json()) };
      } catch (err) {
        return { reachable: false, ready: false, error: err.message };
      }
    },
  };
}
