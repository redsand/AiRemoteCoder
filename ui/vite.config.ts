import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    proxy: {
      '/api': {
        target: 'https://localhost:3100',
        changeOrigin: true,
        secure: false
      },
      '/ws': {
        target: 'wss://localhost:3100',
        ws: true,
        secure: false
      }
    }
  },
  optimizeDeps: {
    exclude: ['@novnc/novnc'],
    esbuildOptions: {
      target: 'esnext'
    }
  },
  esbuild: {
    target: 'esnext'
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'esnext'
  }
});
