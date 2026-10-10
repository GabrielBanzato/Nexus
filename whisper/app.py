"""
Transcrição de voz das reuniões (Nex), 100% local e só CPU: faster-whisper (Whisper em
CTranslate2, int8).

API (só na rede interna do Docker; o backend é o único cliente):
  GET  /health                               → {"ready": bool, "model": str, "error": str|null}
  POST /transcribe?language=pt&prompt=...    corpo = o áudio cru (webm/opus, mp4, wav...)
       → {"text": str, "language": str, "duration": float, "segments": [{"start","end","text"}]}

Um pedido de cada vez (o modelo usa os 2 vCPU; em paralelo só se atrasariam). O VAD (Silero)
corta os silêncios antes do Whisper: menos CPU e sem "alucinações" em trechos mudos.

Medido (i7, 2 threads, 31 s de fala em português): base 1,9 s · small 5,5 s.
"""

import io
import json
import logging
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from faster_whisper import WhisperModel

MODEL = os.environ.get("WHISPER_MODEL", "small")
THREADS = int(os.environ.get("WHISPER_THREADS", "2"))
# Busca em feixe: medido (small, 31 s de fala) 5,3 s com 1 → 6,2 s com 5, e erra bem menos.
BEAM = int(os.environ.get("WHISPER_BEAM", "5"))
MODELS_DIR = os.environ.get("WHISPER_MODELS_DIR", "/models")
MAX_BYTES = 8 * 1024 * 1024  # ~30 min de opus: um pedaço de 15 s tem ~60 KB

logging.basicConfig(level=logging.INFO, format="%(asctime)s whisper %(levelname)s %(message)s")
log = logging.getLogger("whisper")

state = {"model": None, "error": None}
lock = threading.Lock()


def load():
    try:
        log.info("a carregar o modelo %s (na 1.ª vez baixa-o: small ~480 MB)", MODEL)
        state["model"] = WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=THREADS, download_root=MODELS_DIR)
        log.info("modelo %s pronto", MODEL)
    except Exception as err:  # noqa: BLE001 — fica visível no /health
        state["error"] = str(err)
        log.exception("falha ao carregar o modelo")


def transcribe(audio: bytes, language: str | None, prompt: str | None):
    with lock:
        segments, info = state["model"].transcribe(
            io.BytesIO(audio),
            language=language or None,
            initial_prompt=prompt or None,
            vad_filter=True,
            beam_size=BEAM,
            condition_on_previous_text=False,
        )
        out = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in segments]
    return {
        "text": " ".join(s["text"] for s in out if s["text"]).strip(),
        "language": info.language,
        "duration": round(info.duration, 2),
        "segments": out,
    }


class Handler(BaseHTTPRequestHandler):
    def send(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if urlparse(self.path).path == "/health":
            return self.send(200, {"ready": state["model"] is not None, "model": MODEL, "error": state["error"]})
        self.send(404, {"error": "not found"})

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/transcribe":
            return self.send(404, {"error": "not found"})
        if state["model"] is None:
            return self.send(503, {"error": state["error"] or "modelo a carregar"})
        size = int(self.headers.get("Content-Length") or 0)
        if size <= 0 or size > MAX_BYTES:
            return self.send(413 if size else 400, {"error": "áudio vazio ou grande demais"})
        audio = self.rfile.read(size)
        query = parse_qs(url.query)
        try:
            result = transcribe(audio, (query.get("language") or [None])[0], (query.get("prompt") or [None])[0])
        except Exception as err:  # noqa: BLE001 — áudio corrompido/cortado: não derruba o serviço
            log.warning("falha a transcrever (%s bytes): %s", size, err)
            return self.send(422, {"error": f"áudio ilegível: {err}"})
        self.send(200, result)

    def log_message(self, fmt, *args):  # sem uma linha por pedido no log
        pass


if __name__ == "__main__":
    threading.Thread(target=load, daemon=True).start()
    port = int(os.environ.get("PORT", "9000"))
    log.info("à escuta na porta %s", port)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
