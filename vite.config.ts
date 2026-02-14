import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  base: process.env.GITHUB_PAGES ? '/een-video-events/' : '/',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    // IMPORTANT: Must use 127.0.0.1:3333 for EEN OAuth callback
    // The EEN Identity Provider only permits this specific redirect URI
    host: '127.0.0.1',
    port: 3333
  }
})
