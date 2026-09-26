# syntax=docker/dockerfile:1
# =============================================================================
# Nexus: Frontend
# Estágio 1 compila o React com Vite; estágio 2 serve os estáticos com Nginx,
# que também faz proxy de /api para o backend (mesma origem, sem CORS).
# =============================================================================
FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Vazio = o frontend chama /api na mesma origem (Nginx encaminha ao backend).
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

# -----------------------------------------------------------------------------
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1
