import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'vendor',
              test: /node_modules/
            }
          ]
        }
      }
    }
  },
  server: {
    port: 5174,
    // Proxy the API through the dev server so the app always talks to the
    // host it was loaded from. Pointing the frontend straight at the backend
    // port breaks any access that is not localhost: the session cookie is
    // host-scoped, so a phone (or any LAN address) gets a 401 on every call.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4100',
        rewrite: (path) => path.replace(/^\/api/, '')
      }
    }
  }
});
