import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Encaminha /api para o Fastify: evita CORS sem precisar alterar o backend.
    // ws: true também encaminha o WebSocket do Socket.io (/api/socket.io).
    proxy: {
      '/api': { target: 'http://localhost:3000', ws: true },
    },
  },
});
