import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  base: mode === 'pages' ? '/plc-monitor/' : '/',
  server: { proxy: { '/api': 'http://127.0.0.1:8080' } },
  build: { target: 'es2022', outDir: mode === 'pages' ? 'dist-demo' : 'dist' },
}));
