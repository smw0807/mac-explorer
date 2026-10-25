import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export function contentSecurityPolicy(development) {
  return [
    "default-src 'none'",
    `script-src 'self'${development ? " 'unsafe-inline'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: localfile:",
    'media-src localfile:',
    "font-src 'self'",
    development ? 'connect-src http://localhost:5173 ws://localhost:5173' : "connect-src 'none'",
    "object-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'",
  ].join('; ');
}

export default defineConfig(({ command }) => ({
  plugins: [react(), {
    name: 'app-content-security-policy',
    transformIndexHtml: {
      order: 'post',
      handler: () => [{
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: contentSecurityPolicy(command === 'serve') },
        injectTo: 'head-prepend',
      }],
    },
  }],
  base: './',
  optimizeDeps: { include: ['react-dom/client'] },
  build: { outDir: 'dist' },
  server: { port: 5173, strictPort: true },
}));
