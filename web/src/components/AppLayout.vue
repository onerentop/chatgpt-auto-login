<template>
  <el-container style="height: 100vh">
    <el-aside width="200px" class="aside">
      <div class="logo">
        <span>GPT Dashboard</span>
        <el-badge :value="notificationState.unread" :hidden="notificationState.unread === 0" style="margin-left:auto">
          <el-button link size="small" style="color:#bfcbd9" title="通知中心" @click="openNotifications">
            <el-icon><Bell /></el-icon>
          </el-button>
        </el-badge>
        <el-button link size="small" style="margin-left:8px;color:#bfcbd9" :title="dark ? '切换到亮色模式' : '切换到暗色模式'" @click="toggle">
          <el-icon><Moon v-if="!dark" /><Sunny v-else /></el-icon>
        </el-button>
      </div>
      <el-menu
        :default-active="route.path"
        router
        background-color="#304156"
        text-color="#bfcbd9"
        active-text-color="#409eff"
      >
        <el-menu-item index="/">
          <el-icon><Monitor /></el-icon>
          <span>仪表盘</span>
        </el-menu-item>
        <el-menu-item index="/accounts">
          <el-icon><User /></el-icon>
          <span>账号管理</span>
        </el-menu-item>
        <el-menu-item index="/execute">
          <el-icon><VideoPlay /></el-icon>
          <span>执行控制</span>
        </el-menu-item>
        <el-menu-item index="/results">
          <el-icon><Document /></el-icon>
          <span>执行结果</span>
        </el-menu-item>
        <el-menu-item index="/config">
          <el-icon><Setting /></el-icon>
          <span>配置设置</span>
        </el-menu-item>
      </el-menu>
    </el-aside>
    <el-main class="main">
      <el-alert
        v-if="!socketState.connected"
        type="warning"
        :closable="false"
        show-icon
        style="margin-bottom:12px"
      >
        <template #title>
          <span style="font-weight:500">实时数据已暂停</span>
          <span style="color:#909399;margin-left:8px">WebSocket 已断开，自动重连中…</span>
          <el-button
            link
            type="primary"
            size="small"
            style="margin-left:12px"
            @click="reconnectSocket"
          >手动重连</el-button>
        </template>
      </el-alert>
      <slot />
    </el-main>

    <!-- FX-13 notification center drawer -->
    <el-drawer
      v-model="notificationDrawerOpen"
      title="通知中心"
      direction="rtl"
      size="380px"
      :before-close="handleDrawerClose"
    >
      <template #header>
        <div style="display:flex;align-items:center;width:100%">
          <span style="font-weight:500">通知中心</span>
          <span style="color:#909399;margin-left:8px;font-size:12px">共 {{ notificationState.items.length }} 条</span>
          <span style="flex:1" />
          <el-button size="small" :disabled="notificationState.items.length === 0" @click="clearAll">清空</el-button>
        </div>
      </template>
      <div v-if="notificationState.items.length === 0" style="text-align:center;color:#c0c4cc;padding:32px">
        暂无通知
      </div>
      <div v-else>
        <div
          v-for="item in notificationState.items"
          :key="item.id"
          style="border-bottom:1px solid var(--el-border-color-lighter);padding:8px 4px"
        >
          <div style="display:flex;align-items:center;gap:8px">
            <el-tag size="small" :type="tagType(item.level)">{{ levelLabel(item.level) }}</el-tag>
            <strong style="font-size:13px">{{ item.title || '(无标题)' }}</strong>
            <span style="margin-left:auto;font-size:11px;color:#909399">{{ formatTime(item.ts) }}</span>
          </div>
          <div v-if="item.message" style="margin-top:4px;font-size:12px;color:#606266;word-break:break-all;font-family:inherit">
            {{ item.message }}
          </div>
        </div>
      </div>
    </el-drawer>
  </el-container>
</template>

<script setup>
import { ref } from 'vue'
import { useRoute } from 'vue-router'
import { Monitor, User, Setting, VideoPlay, Document, Moon, Sunny, Bell } from '@element-plus/icons-vue'
import { socketState, reconnectSocket } from '../socket'
import { useHotkeys } from '../composables/useHotkeys'
import { useDarkMode } from '../composables/useDarkMode'
import { notificationState, markAllRead, clearAll as clearAllNotifications } from '../notifications'

const route = useRoute()
// Global hotkeys (/, Ctrl+Enter) — registered once at the layout level so
// each page-level view doesn't need to wire them up individually.
useHotkeys()
const { dark, toggle } = useDarkMode()

const notificationDrawerOpen = ref(false)
function openNotifications() {
  notificationDrawerOpen.value = true
  // Reset unread the moment the user opens the drawer; treat the drawer
  // as the "I've seen the new ones" signal even if they immediately close it.
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
.aside {
  background-color: #304156;
  overflow-y: auto;
}

.logo {
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding: 0 16px;
  color: #fff;
  font-size: 18px;
  font-weight: bold;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.main {
  /* Use Element Plus CSS vars so background tracks dark mode toggle. */
  background-color: var(--el-bg-color-page, #f0f2f5);
  padding: 20px;
  overflow-y: auto;
}
</style>
