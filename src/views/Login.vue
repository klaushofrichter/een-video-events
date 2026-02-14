<script setup lang="ts">
import { onMounted } from 'vue'
import { getAuthUrl } from 'een-api-toolkit'

onMounted(() => {
  const authUrl = getAuthUrl()
  // Redirect to EEN OAuth login page
  window.location.href = authUrl
})
</script>

<template>
  <div>
    <h1>Login</h1>
    <p>Redirecting to Eagle Eye Networks login...</p>
  </div>
</template>
