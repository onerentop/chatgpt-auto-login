<template>
  <AppLayout>
    <router-view />
  </AppLayout>
</template>

<script setup>
import { onMounted } from 'vue'
import AppLayout from './components/AppLayout.vue'
import { connectSocket } from './socket'

onMounted(() => {
  connectSocket()
})
</script>
