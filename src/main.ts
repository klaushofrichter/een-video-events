import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { initEenToolkit } from 'een-api-toolkit'
import App from './App.vue'
import router from './router'

const app = createApp(App)

// CRITICAL: Pinia must be installed BEFORE initEenToolkit()
app.use(createPinia())

// Initialize EEN API Toolkit
initEenToolkit({
  proxyUrl: import.meta.env.VITE_PROXY_URL,
  clientId: import.meta.env.VITE_EEN_CLIENT_ID,
  redirectUri: import.meta.env.VITE_REDIRECT_URI,
  storageStrategy: 'localStorage',
  debug: import.meta.env.VITE_DEBUG === 'true'
})

app.use(router)
app.mount('#app')
