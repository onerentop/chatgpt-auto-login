<template>
  <div>
    <el-row style="margin-bottom: 16px" :gutter="12" align="middle">
      <el-col :span="24">
        <el-button type="success" :disabled="running" @click="handleStart">
          开始执行
        </el-button>
        <el-button type="danger" :disabled="!running" @click="handleStop">
          停止
        </el-button>
        <span style="margin-left: 16px">起始序号：</span>
        <el-input-number
          v-model="startFrom"
          :min="0"
          :disabled="running"
          style="width: 120px"
        />
        <el-tag
          :type="running ? 'success' : 'info'"
          style="margin-left: 16px"
        >
          {{ running ? '运行中' : '空闲' }}
        </el-tag>
        <el-tag v-if="socketState.connected" type="success" style="margin-left: 8px">
          WS 已连接
        </el-tag>
        <el-tag v-else type="danger" style="margin-left: 8px">
          WS 断开
        </el-tag>
      </el-col>
    </el-row>

    <!-- Account Progress -->
    <el-row :gutter="12" style="margin-bottom: 16px">
      <el-col
        v-for="(account, email) in socketState.accountStatuses"
        :key="email"
        :span="8"
        style="margin-bottom: 12px"
      >
        <el-card shadow="hover" body-style="padding: 12px">
          <div style="font-weight: bold; margin-bottom: 8px">{{ email }}</div>
          <el-tag :type="phaseType(account.phase)" size="small">
            {{ account.phase }}
          </el-tag>
          <el-progress
            :percentage="account.progress"
            :status="progressStatus(account.status)"
            style="margin-top: 8px"
          />
        </el-card>
      </el-col>
    </el-row>

    <!-- Log Stream -->
    <el-card>
      <template #header>
        <div style="display: flex; justify-content: space-between; align-items: center">
          <span>日志流 ({{ socketState.logs.length }})</span>
          <el-button size="small" @click="clearLogs">清除</el-button>
        </div>
      </template>
      <div ref="logContainer" class="log-container">
        <div
          v-for="(log, idx) in socketState.logs"
          :key="idx"
          class="log-line"
          :class="'log-' + log.level"
        >
          <span class="log-time">{{ formatTime(log.timestamp) }}</span>
          <span v-if="log.email" class="log-email">[{{ log.email }}]</span>
          <span class="log-msg">{{ log.message }}</span>
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, watch, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'
import { socketState } from '../socket'

const running = ref(false)
const startFrom = ref(0)
const logContainer = ref(null)

function phaseType(phase) {
  const map = {
    login: 'primary',
    payment: 'warning',
    verify: 'success',
    idle: 'info',
    error: 'danger',
  }
  return map[phase] || 'info'
}

function progressStatus(status) {
  if (status === 'success') return 'success'
  if (status === 'error') return 'exception'
  return undefined
}

function formatTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toLocaleTimeString('zh-CN')
}

function clearLogs() {
  socketState.logs.splice(0, socketState.logs.length)
}

// Auto-scroll log container
watch(
  () => socketState.logs.length,
  async () => {
    await nextTick()
    if (logContainer.value) {
      logContainer.value.scrollTop = logContainer.value.scrollHeight
    }
  }
)

async function handleStart() {
  try {
    running.value = true
    await api.post('/execute/start', { startFrom: startFrom.value })
    ElMessage.success('执行已启动')
  } catch (err) {
    running.value = false
    ElMessage.error(err.response?.data?.error || '启动失败')
  }
}

async function handleStop() {
  try {
    await api.post('/execute/stop')
    running.value = false
    ElMessage.success('已停止')
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '停止失败')
  }
}

// Listen for execution-complete to reset running state
watch(
  () => socketState.logs,
  (logs) => {
    const last = logs[logs.length - 1]
    if (last && last.message && last.message.startsWith('Execution complete')) {
      running.value = false
    }
  },
  { deep: true }
)
</script>

<style scoped>
.log-container {
  background-color: #1e1e1e;
  color: #d4d4d4;
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.6;
  height: 400px;
  overflow-y: auto;
  padding: 12px;
  border-radius: 4px;
}

.log-line {
  white-space: pre-wrap;
  word-break: break-all;
}

.log-time {
  color: #808080;
  margin-right: 8px;
}

.log-email {
  color: #569cd6;
  margin-right: 8px;
}

.log-msg {
  color: #d4d4d4;
}

.log-error .log-msg {
  color: #f44747;
}

.log-success .log-msg {
  color: #6a9955;
}

.log-warning .log-msg {
  color: #ce9178;
}
</style>
