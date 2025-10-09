import {defineConfig} from 'vite';

// https://vitejs.dev/config/
export default defineConfig({
  envDir: '../',
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
        ws: true,
      },
    },
    hmr: {
      clientPort: 443,
    },
    // Allow reverse-proxy hosts (ngrok, trycloudflare, etc.) during development
    allowedHosts: true,
    // Permit embedding inside Discord iframe during development
    headers: {
      'Content-Security-Policy': "frame-ancestors https://discord.com https://*.discord.com;",
      'X-Frame-Options': 'ALLOW-FROM https://discord.com',
    },
  },
});
