import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const mock =
    command === 'serve'
      ? env.VITE_API_MODE === 'mock'
      : mode === 'mock-preview';
  if (
    command === 'build' &&
    mode !== 'mock-preview' &&
    env.VITE_API_MODE === 'mock'
  ) {
    throw new Error(
      'Mock is development-only. Use npm run build:mock for a local preview.',
    );
  }
  return {
    plugins: [react()],
    define: { __MOCK__: JSON.stringify(mock) },
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:8080',
          // The API validates the browser-facing Host against PUBLIC_BASE_URL.
          changeOrigin: false,
        },
      },
    },
    build: { outDir: mock ? 'dist-mock' : 'dist', sourcemap: true },
  };
});
