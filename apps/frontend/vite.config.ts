import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// En desarrollo (pnpm dev) /graphql va al gateway local (docker compose, :4000),
// HTTP y WebSocket. En k8s y en la imagen nginx la UI y el gateway comparten host.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/graphql': { target: process.env.GATEWAY_URL ?? 'http://localhost:4000', ws: true, changeOrigin: true } },
  },
  build: { sourcemap: true },
  test: { include: ['test/**/*.test.ts'] },
});
