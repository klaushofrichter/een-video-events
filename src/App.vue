<script setup lang="ts">
import { onMounted, computed, ref, watch, provide } from 'vue'
import { useAuthStore, revokeToken } from 'een-api-toolkit'
import { useRouter } from 'vue-router'

const router = useRouter()
const authStore = useAuthStore()
const isAuthenticated = computed(() => authStore.isAuthenticated)

async function handleLogout() {
  await revokeToken()
  router.push('/')
}

const soundEnabled = ref(true)
provide('soundEnabled', soundEnabled)

type ThemeMode = 'light' | 'dark' | 'system'
const themeMode = ref<ThemeMode>((localStorage.getItem('theme') as ThemeMode) || 'system')

function applyTheme(mode: ThemeMode) {
  const root = document.documentElement
  if (mode === 'system') {
    root.removeAttribute('data-theme')
  } else {
    root.setAttribute('data-theme', mode)
  }
}

function cycleTheme() {
  const order: ThemeMode[] = ['system', 'light', 'dark']
  const idx = order.indexOf(themeMode.value)
  themeMode.value = order[(idx + 1) % order.length]
}

watch(themeMode, (mode) => {
  localStorage.setItem('theme', mode)
  applyTheme(mode)
}, { immediate: true })

onMounted(() => {
  authStore.initialize()
})
</script>

<template>
  <div id="app">
    <nav>
      <div class="nav-left">
        <router-link to="/">Home</router-link>
        <template v-if="!isAuthenticated">
          <span> | </span>
          <router-link to="/login">Login</router-link>
        </template>
      </div>
      <a class="nav-title" href="https://github.com/klaushofrichter/een-video-events" target="_blank" rel="noopener noreferrer">BRIVO Video</a>
      <div class="nav-right">
        <button class="sound-toggle" @click="soundEnabled = !soundEnabled" :title="soundEnabled ? 'Mute' : 'Unmute'">
          {{ soundEnabled ? '&#128264;' : '&#128263;' }}
        </button>
        <button class="theme-toggle" @click="cycleTheme" :title="`Theme: ${themeMode}`">
          <span v-if="themeMode === 'light'">&#9728;</span>
          <span v-else-if="themeMode === 'dark'">&#9790;</span>
          <span v-else>&#9881;</span>
          <span class="theme-label">{{ themeMode }}</span>
        </button>
        <button v-if="isAuthenticated" class="logout-btn" @click="handleLogout">
          Logout
        </button>
      </div>
    </nav>
    <main>
      <router-view />
    </main>
  </div>
</template>

<style>
/* Light theme (default) */
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  margin: 0;
  padding: 20px;
  background-color: #f5f5f5;
  color: #333;
}

nav {
  padding: 10px 0;
  margin-bottom: 20px;
  border-bottom: 1px solid #ddd;
  display: flex;
  align-items: center;
}

.nav-left {
  flex: 1;
}

.nav-title {
  font-weight: 700;
  font-size: 16px;
  white-space: nowrap;
  color: inherit;
  text-decoration: none;
}

.nav-title:hover {
  text-decoration: underline;
}

nav a {
  color: #42b883;
  text-decoration: none;
  font-weight: 500;
}

nav a:hover {
  text-decoration: underline;
}

nav span {
  color: #999;
}

main {
  width: 100%;
}

.nav-right {
  flex: 1;
  justify-content: flex-end;
  display: flex;
  align-items: center;
  gap: 8px;
}

.logout-btn {
  background-color: #dc3545;
  color: white;
  border: none;
  border-radius: 4px;
  padding: 4px 12px;
  cursor: pointer;
  font-size: 13px;
}

.logout-btn:hover {
  background-color: #c82333;
}

.sound-toggle {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 18px;
  padding: 0 4px;
  line-height: 1;
}

.theme-toggle {
  background: none;
  border: 1px solid #ccc;
  border-radius: 4px;
  padding: 4px 10px;
  cursor: pointer;
  font-size: 14px;
  color: inherit;
  display: flex;
  align-items: center;
  gap: 4px;
}

.theme-toggle:hover {
  border-color: #999;
}

.theme-label {
  font-size: 12px;
  text-transform: capitalize;
}

/* Dark styles applied via data-theme="dark" or system preference */
html[data-theme="dark"] body,
html:not([data-theme]) body {
  /* base styles above apply for light / system-light */
}

html[data-theme="dark"] body {
  background-color: #1a1a1a;
  color: #e0e0e0;
}

html[data-theme="dark"] nav {
  border-bottom-color: #444;
}

html[data-theme="dark"] nav a {
  color: #5dd9a0;
}

html[data-theme="dark"] nav span {
  color: #666;
}

html[data-theme="dark"] .theme-toggle {
  border-color: #555;
}

html[data-theme="dark"] .theme-toggle:hover {
  border-color: #888;
}

/* System preference dark mode (only when no explicit data-theme is set) */
@media (prefers-color-scheme: dark) {
  html:not([data-theme]) body {
    background-color: #1a1a1a;
    color: #e0e0e0;
  }

  html:not([data-theme]) nav {
    border-bottom-color: #444;
  }

  html:not([data-theme]) nav a {
    color: #5dd9a0;
  }

  html:not([data-theme]) nav span {
    color: #666;
  }

  html:not([data-theme]) .theme-toggle {
    border-color: #555;
  }

  html:not([data-theme]) .theme-toggle:hover {
    border-color: #888;
  }
}
</style>
