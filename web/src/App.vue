<template>
  <router-view v-if="isLoginPage" />
  <AppLayout v-else>
    <router-view />
  </AppLayout>
</template>

<script setup>
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import AppLayout from './components/AppLayout.vue'
import { connectSocket } from './socket'

const route = useRoute()

const isLoginPage = computed(() => route.path === '/login')

onMounted(() => {
  const token = localStorage.getItem('token')
  if (token) {
    connectSocket()
  }
})
</script>
