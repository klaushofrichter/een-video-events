<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { revokeToken } from 'een-api-toolkit'

const router = useRouter()

onMounted(async () => {
  await revokeToken()
  router.push({ name: 'home' })
})
</script>

<template>
  <div>
    <h1>Logging out...</h1>
    <p>Please wait...</p>
  </div>
</template>
