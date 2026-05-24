<template>
  <el-container style="height: 100vh">
    <el-aside width="200px" class="aside">
      <div class="logo">GPT Dashboard</div>
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
  </el-container>
</template>

<script setup>
import { useRoute } from 'vue-router'
import { Monitor, User, Setting, VideoPlay, Document } from '@element-plus/icons-vue'
import { socketState, reconnectSocket } from '../socket'

const route = useRoute()
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
  justify-content: center;
  color: #fff;
  font-size: 18px;
  font-weight: bold;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.main {
  background-color: #f0f2f5;
  padding: 20px;
  overflow-y: auto;
}
</style>
