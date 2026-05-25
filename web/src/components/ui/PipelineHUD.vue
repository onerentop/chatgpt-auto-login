<template>
  <Transition name="hud">
    <div v-if="pipelineStore.running" class="hud" role="status">
      <div class="hud__spinner">
        <el-icon class="hud__spinner-icon"><Loading /></el-icon>
      </div>
      <div class="hud__main">
        <div class="hud__line1">
          <span class="hud__progress">{{ pipelineStore.done }} / {{ pipelineStore.total }}</span>
          <span v-if="pipelineStore.currentEmail" class="hud__email" :title="pipelineStore.currentEmail">
            {{ pipelineStore.currentEmail }}
          </span>
          <span v-if="pipelineStore.currentPhase" class="hud__phase">
            · {{ pipelineStore.currentPhase }}
          </span>
        </div>
        <div class="hud__bar">
          <div class="hud__bar-fill" :style="{ width: progressPct + '%' }" />
        </div>
      </div>
      <div class="hud__meta">
        <div class="hud__meta-row">
          <span class="hud__meta-label">已用</span>
          <span class="hud__meta-value">{{ formatDuration(elapsedSeconds.value) }}</span>
        </div>
        <div class="hud__meta-row">
          <span class="hud__meta-label">ETA</span>
          <span class="hud__meta-value">{{ formatDuration(etaSeconds.value) }}</span>
        </div>
      </div>
      <div class="hud__actions">
        <el-button v-if="!isExecuteView" size="small" link type="primary" @click="goExecute">
          查看 →
        </el-button>
        <el-button size="small" type="danger" @click="handleStop">停止</el-button>
      </div>
    </div>
  </Transition>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Loading } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import api from '../../api'
import {
  pipelineStore, etaSeconds, elapsedSeconds, formatDuration,
} from '../../stores/pipelineStore'

const route = useRoute()
const router = useRouter()
const isExecuteView = computed(() => route.path === '/execute')

const progressPct = computed(() => {
  if (!pipelineStore.total) return 0
  return Math.min(100, Math.round((pipelineStore.done / pipelineStore.total) * 100))
})

function goExecute() { router.push('/execute') }

async function handleStop() {
  try {
    await api.post('/execute/stop')
    ElMessage.info('正在停止…')
  } catch (e) {
    ElMessage.error(e.response?.data?.error || '停止失败')
  }
}

// Tick every second while running so elapsed / ETA refresh visually.
const _tick = ref(0)
let _interval = null
onMounted(() => {
  _interval = setInterval(() => { _tick.value++ }, 1000)
})
onUnmounted(() => {
  if (_interval) clearInterval(_interval)
})
</script>

<style scoped>
.hud {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  margin: var(--sp-3) var(--sp-5) 0;
  padding: var(--sp-3) var(--sp-4);
  background: var(--app-surface);
  border: 1px solid var(--el-color-primary-light-7);
  border-left: 3px solid var(--app-brand);
  border-radius: var(--rad-md);
  box-shadow: var(--sh-2);
}
.hud__spinner {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--el-color-primary-light-9);
  color: var(--app-brand);
  flex-shrink: 0;
}
.hud__spinner-icon {
  font-size: 18px;
  animation: hud-spin 1.4s linear infinite;
}
@keyframes hud-spin {
  to { transform: rotate(360deg); }
}

.hud__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.hud__line1 {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-md);
  color: var(--app-text-2);
  min-width: 0;
}
.hud__progress {
  font-weight: 600;
  color: var(--app-text);
  font-variant-numeric: tabular-nums;
}
.hud__email {
  font-family: var(--ff-mono);
  font-size: var(--fs-sm);
  color: var(--app-text);
  background: var(--app-surface-2);
  padding: 1px 6px;
  border-radius: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 280px;
}
.hud__phase {
  font-size: var(--fs-sm);
  color: var(--app-text-3);
}
.hud__bar {
  height: 4px;
  background: var(--app-surface-2);
  border-radius: 999px;
  overflow: hidden;
}
.hud__bar-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--app-brand), var(--el-color-primary-light-3));
  transition: width var(--tr-slow);
  border-radius: 999px;
}

.hud__meta {
  display: flex;
  gap: var(--sp-4);
  flex-shrink: 0;
}
.hud__meta-row {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}
.hud__meta-label {
  font-size: var(--fs-xs);
  color: var(--app-text-mute);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.hud__meta-value {
  font-size: var(--fs-md);
  color: var(--app-text);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.hud__actions {
  display: flex;
  gap: var(--sp-2);
  flex-shrink: 0;
}

/* Slide-down entry / exit */
.hud-enter-active, .hud-leave-active {
  transition: opacity var(--tr-base), transform var(--tr-base);
}
.hud-enter-from, .hud-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
