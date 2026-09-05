import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// In production nginx proxies /api and /ws to the backend. For `npm run
// dev`, forward them to a locally-running backend (override with
// VITE_API_TARGET, e.g. a Tailscale host).
const target = process.env.VITE_API_TARGET || 'http://localhost:8000'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target, changeOrigin: true },
      '/ws': { target, ws: true, changeOrigin: true },
    },
  },
})
