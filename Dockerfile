# syntax=docker/dockerfile:1
# =============================================================================
# Nexus: Backend (Fastify + Puppeteer)
# Debian (glibc) é obrigatório: o Chrome do Puppeteer não roda em Alpine (musl).
# =============================================================================
FROM node:22-bookworm-slim

# -----------------------------------------------------------------------------
# Dependências nativas do Chromium headless.
# Sem elas o Chrome falha ao iniciar com erros como
# "error while loading shared libraries: libnss3.so".
# -----------------------------------------------------------------------------
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      fonts-liberation \
      fonts-noto-color-emoji \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libatspi2.0-0 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libexpat1 \
      libgbm1 \
      libglib2.0-0 \
      libgtk-3-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libpangocairo-1.0-0 \
      libx11-6 \
      libx11-xcb1 \
      libxcb1 \
      libxcomposite1 \
      libxcursor1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxi6 \
      libxkbcommon0 \
      libxrandr2 \
      libxrender1 \
      libxshmfence1 \
      libxss1 \
      libxtst6 \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    # O Puppeteer baixa o Chrome no npm ci; fixa o cache num diretório do usuário "node".
    PUPPETEER_CACHE_DIR=/home/node/.cache/puppeteer

WORKDIR /app
RUN chown node:node /app

# Roda sem root: reduz o impacto caso uma página maliciosa explore o navegador.
USER node

# Camada de dependências separada do código: rebuilds rápidos quando só o src muda.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node src ./src

# Sessão do WhatsApp: criada aqui (dono "node") para o volume nomeado herdar as permissões.
ENV WHATSAPP_SESSION_DIR=/app/.wwebjs_auth
RUN mkdir -p /app/.wwebjs_auth

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
