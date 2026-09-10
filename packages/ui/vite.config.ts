import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5177,
    // Point the dev UI at a running `hodor serve` for real data + HMR.
    proxy: { '/api': 'http://127.0.0.1:4477' },
  },
  build: { outDir: 'dist' },
})
