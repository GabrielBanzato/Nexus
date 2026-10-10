# Transcrição das reuniões (Nex): faster-whisper na CPU. Ver app.py.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HUB_DISABLE_TELEMETRY=1

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY app.py .

# Modelos baixados na 1.ª vez para /models (volume: não baixa de novo a cada redeploy).
RUN useradd --create-home --uid 10001 whisper && mkdir -p /models && chown whisper /models
USER whisper

EXPOSE 9000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10m --retries=3 \
  CMD python -c "import json,sys,urllib.request; sys.exit(0 if json.load(urllib.request.urlopen('http://127.0.0.1:9000/health', timeout=4))['ready'] else 1)"
CMD ["python", "app.py"]
