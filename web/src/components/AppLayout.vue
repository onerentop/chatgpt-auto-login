<template>
  <div class="app-shell">
    <!-- Topbar (sticky) -->
    <header class="app-topbar">
      <div class="app-topbar__brand">
        <span class="app-topbar__logo">GPT Dashboard</span>
        <span class="app-topbar__page">{{ pageTitle }}</span>
      </div>
      <div class="app-topbar__right">
        <span class="app-topbar__socket" :class="socketState.connected ? 'is-on' : 'is-off'"
              :title="socketState.connected ? 'WebSocket 已连接' : 'WebSocket 已断开'">
          <span class="app-topbar__socket-dot" /> {{ socketState.connected ? '实时' : '离线' }}
        </span>
        <el-badge :value="notificationState.unread" :hidden="notificationState.unread === 0">
          <el-button text title="通知中心" @click="openNotifications">
            <el-icon><Bell /></el-icon>
          </el-button>
        </el-badge>
        <el-button text :title="dark ? '切换到亮色' : '切换到暗色'" @click="toggle">
          <el-icon><Moon v-if="!dark" /><Sunny v-else /></el-icon>
        </el-button>
      </div>
    </header>

    <div class="app-body">
      <!-- Sidebar -->
      <aside class="app-sidebar">
        <el-menu
          :default-active="route.path"
          router
          class="app-menu"
        >
          <el-menu-item index="/">
            <el-icon><Monitor /></el-icon><span>仪表盘</span>
          </el-menu-item>
          <el-menu-item index="/accounts">
            <el-icon><User /></el-icon><span>账号管理</span>
          </el-menu-item>
          <el-menu-item index="/execute">
            <el-icon><VideoPlay /></el-icon><span>执行控制</span>
          </el-menu-item>
          <el-menu-item index="/results">
            <el-icon><Document /></el-icon><span>执行结果</span>
          </el-menu-item>
          <el-menu-item index="/config">
            <el-icon><Setting /></el-icon><span>配置设置</span>
          </el-menu-item>
        </el-menu>
      </aside>

      <!-- Main content area -->
      <main class="app-main">
        <el-alert
          v-if="!socketState.connected"
          type="warning"
          :closable="false"
          show-icon
          class="app-disconnected"
        >
          <template #title>
            <span style="font-weight:500">实时数据已暂停</span>
            <span style="color:var(--app-text-3);margin-left:8px">WebSocket 已断开，自动重连中…</span>
            <el-button link type="primary" size="small" style="margin-left:12px" @click="reconnectSocket">手动重连</el-button>
          </template>
        </el-alert>
        <div class="app-page">
          <slot />
        </div>
      </main>
    </div>

    <!-- Notification center -->
    <el-drawer v-model="notificationDrawerOpen" direction="rtl" size="380px" :before-close="handleDrawerClose">
      <template #header>
        <div style="display:flex;align-items:center;width:100%">
          <span style="font-weight:600">通知中心</span>
          <span style="color:var(--app-text-3);margin-left:8px;font-size:var(--fs-sm)">共 {{ notificationState.items.length }} 条</span>
          <span style="flex:1" />
          <el-button size="small" :disabled="notificationState.items.length === 0" @click="clearAll">清空</el-button>
        </div>
      </template>
      <div v-if="notificationState.items.length === 0" style="text-align:center;color:var(--app-text-mute);padding:32px">
        暂无通知
      </div>
      <div v-else>
        <div
          v-for="item in notificationState.items"
          :key="item.id"
          class="notification-item"
        >
          <div style="display:flex;align-items:center;gap:8px">
            <el-tag size="small" :type="tagType(item.level)">{{ levelLabel(item.level) }}</el-tag>
            <strong style="font-size:var(--fs-md)">{{ item.title || '(无标题)' }}</strong>
            <span style="margin-left:auto;font-size:var(--fs-xs);color:var(--app-text-mute)">{{ formatTime(item.ts) }}</span>
          </div>
          <div v-if="item.message" style="margin-top:4px;font-size:var(--fs-sm);color:var(--app-text-2);word-break:break-all">
            {{ item.message }}
          </div>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useRoute } from 'vue-router'
import { Monitor, User, Setting, VideoPlay, Document, Moon, Sunny, Bell } from '@element-plus/icons-vue'
import { socketState, reconnectSocket } from '../socket'
import { useHotkeys } from '../composables/useHotkeys'
import { useDarkMode } from '../composables/useDarkMode'
import { notificationState, markAllRead, clearAll as clearAllNotifications } from '../notifications'

const route = useRoute()
useHotkeys()
const { dark, toggle } = useDarkMode()

const pageTitle = computed(() => route.meta?.title || '')

const notificationDrawerOpen = ref(false)
function openNotifications() {
  notificationDrawerOpen.value = true
  markAllRead()
}
function handleDrawerClose(done) { done() }
function clearAll() { clearAllNotifications() }
function tagType(level) {
  return level === 'error' ? 'danger' : level === 'warning' ? 'warning' : level === 'success' ? 'success' : 'info'
}
function levelLabel(level) {
  return ({ error: '错误', warning: '警告', success: '成功', info: '信息' })[level] || level
}
function formatTime(ts) {
  const d = new Date(ts)
  return d.toLocaleTimeString('zh-CN', { hour12: false }) + ' ' + d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}
</script>

<style scoped>
/* === Shell layout — full viewport with sticky topbar + flex body === */
.app-shell {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background: var(--app-bg);
}

/* === Topbar === */
.app-topbar {
  height: var(--app-header-height);
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--sp-5);
  background: var(--app-header-bg);
  border-bottom: 1px solid var(--app-header-border);
  position: sticky;
  top: 0;
  z-index: 10;
}
.app-topbar__brand {
  display: flex;
  align-items: baseline;
  gap: var(--sp-4);
  min-width: 0;
}
.app-topbar__logo {
  font-size: var(--fs-xl);
  font-weight: 700;
  color: var(--app-text);
  letter-spacing: 0.2px;
}
.app-topbar__page {
  font-size: var(--fs-md);
  color: var(--app-text-3);
}
.app-topbar__right {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.app-topbar__socket {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  padding: 2px var(--sp-2);
  border-radius: 999px;
  font-size: var(--fs-xs);
  font-weight: 500;
  background: var(--app-surface-2);
  border: 1px solid var(--app-border-soft);
  color: var(--app-text-3);
  transition: color var(--tr-base), background var(--tr-base);
}
.app-topbar__socket-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.app-topbar__socket.is-on { color: var(--app-success); }
.app-topbar__socket.is-off { color: var(--app-danger); }

/* === Body (sidebar + main) === */
.app-body {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
}

/* === Sidebar === */
.app-sidebar {
  width: var(--app-sidebar-width);
  flex: 0 0 var(--app-sidebar-width);
  background: var(--app-sidebar-bg);
  border-right: 1px solid var(--app-sidebar-border);
  overflow-y: auto;
}
.app-menu {
  border-right: none !important;
  background: transparent !important;
  padding: var(--sp-2) 0;
}
/* el-menu-item overrides — use token-based hover / active highlight. */
.app-menu :deep(.el-menu-item) {
  height: 40px;
  line-height: 40px;
  margin: 2px var(--sp-2);
  border-radius: var(--rad-sm);
  color: var(--app-sidebar-text);
  transition: background var(--tr-fast), color var(--tr-fast);
}
.app-menu :deep(.el-menu-item:hover) {
  background: var(--app-surface-2);
  color: var(--app-text);
}
.app-menu :deep(.el-menu-item.is-active) {
  background: var(--app-sidebar-item-active-bg);
  color: var(--app-sidebar-text-active);
  font-weight: 500;
}

/* === Main === */
.app-main {
  flex: 1 1 auto;
  min-width: 0;
  overflow-y: auto;
}
.app-disconnected {
  margin: var(--sp-3) var(--sp-5) 0;
  border-radius: var(--rad-md);
}
/* `.app-page` class is also defined in tokens.css as the global utility;
 * scoped style here is intentionally redundant so nested routers still get it
 * even if global stylesheet load order changes. */
.app-page {
  max-width: 1440px;
  margin: 0 auto;
  padding: var(--sp-5);
}

.notification-item {
  padding: var(--sp-2) var(--sp-1);
  border-bottom: 1px solid var(--app-border-soft);
}
</style>
