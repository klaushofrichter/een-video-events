<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { handleAuthCallback } from 'een-api-toolkit'

const route = useRoute()
const router = useRouter()
const errorMessage = ref<string | null>(null)

onMounted(async () => {
  const code = route.query.code as string
  const state = route.query.state as string

  if (!code || !state) {
    errorMessage.value = 'Missing authorization code or state parameter.'
    return
  }

  const { error } = await handleAuthCallback(code, state)
  if (error) {
    errorMessage.value = `Authentication failed: ${error.message}`
    return
  }

  // Redirect to home page after successful login
  router.push({ name: 'home' })
})
</script>

<template>
  <div>
    <h1>Authenticating...</h1>
    <p v-if="errorMessage" style="color: red;">{{ errorMessage }}</p>
    <p v-else>Processing login, please wait...</p>
  </div>
</template>
