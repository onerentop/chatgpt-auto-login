<template>
  <el-drawer
    :model-value="modelValue"
    :title="email ? `步骤详情 — ${email}` : '步骤详情'"
    direction="rtl"
    size="480px"
    @update:model-value="emit('update:modelValue', $event)"
    @open="onOpen"
  >
    <div class="asd-body">
      <!-- Loading state -->
      <div v-if="loading" class="asd-loading">
        <el-icon class="asd-loading-icon"><Loading /></el-icon>
        <span>加载中…</span>
      </div>

      <!-- Error state -->
      <div v-else-if="loadError" class="asd-error">
        <span>{{ loadError }}</span>
        <el-button size="small" @click="fetchSteps">重试</el-button>
      </div>

      <!-- Step list -->
      <template v-else>
        <div class="asd-header-actions">
          <el-button size="small" :icon="Refresh" @click="fetchSteps">刷新</el-button>
        </div>
        <div v-if="steps.length === 0" class="asd-empty">暂无步骤数据</div>
        <div v-else class="asd-steps">
          <div
            v-for="(step, idx) in steps"
            :key="step.stepId"
            class="asd-step"
            :class="`asd-step--${effectiveStatus(step)}`"
          >
            <!-- Connector line (not on last) -->
            <div class="asd-step__track">
              <div class="asd-step__icon" :class="`asd-step__icon--${effectiveStatus(step)}`">
                <el-icon v-if="effectiveStatus(step) === 'running'" class="asd-spin"><Loading /></el-icon>
                <el-icon v-else-if="effectiveStatus(step) === 'success'"><CircleCheck /></el-icon>
                <el-icon v-else-if="effectiveStatus(step) === 'failed'"><CircleClose /></el-icon>
                <el-icon v-else-if="effectiveStatus(step) === 'skipped'"><Remove /></el-icon>
                <span v-else class="asd-step__dot"></span>
              </div>
              <div v-if="idx < steps.length - 1" class="asd-step__line"></div>
            </div>
            <div class="asd-step__content">
              <div class="asd-step__header">
                <span class="asd-step__label">{{ step.label }}</span>
                <el-tag
                  size="small"
                  :type="stepStatusTagType(effectiveStatus(step))"
                  style="flex-shrink:0"
                >{{ stepStatusLabel(effectiveStatus(step)) }}</el-tag>
              </div>
              <!-- Timing -->
              <div v-if="step.startedAt || step.finishedAt" class="asd-step__timing">
                <span v-if="step.startedAt">开始: {{ formatTs(step.startedAt) }}</span>
                <span v-if="step.finishedAt">结束: {{ formatTs(step.finishedAt) }}</span>
                <span v-if="step.startedAt && step.finishedAt">
                  耗时: {{ durationLabel(step.startedAt, step.finishedAt) }}
                </span>
              </div>
              <!-- Failure reason -->
              <div v-if="effectiveReason(step)" class="asd-step__reason">
                {{ effectiveReason(step) }}
              </div>
              <!-- Logs toggle -->
              <div v-if="step.logs && step.logs.length > 0" class="asd-step__logs-toggle">
                <el-button
                  size="small"
                  link
                  type="primary"
                  @click="toggleLogs(step.stepId)"
                >
                  {{ expandedLogs.has(step.stepId) ? '▼ 收起日志' : `▶ 展开日志 (${step.logs.length})` }}
                </el-button>
              </div>
              <div
                v-if="step.logs && step.logs.length > 0 && expandedLogs.has(step.stepId)"
                class="asd-step__logs"
              >
                <div
                  v-for="(log, li) in step.logs"
                  :key="li"
                  class="asd-step__log-line"
                >
                  <span class="asd-log__ts">{{ formatTs(log.timestamp) }}</span>
                  <span class="asd-log__msg">{{ log.message }}</span>
                </div>
              </div>
              <!-- Retry button — only for failed steps -->
              <div v-if="effectiveStatus(step) === 'failed'" class="asd-step__retry">
                <el-button
                  size="small"
                  type="danger"
                  plain
                  :loading="retryingStep === step.stepId"
                  :disabled="retryingStep !== null"
                  @click="retryStep(step)"
                >重试这一步</el-button>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>
  </el-drawer>
</template>

<script setup>
import { ref, watch, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { Loading, CircleCheck, CircleClose, Remove, Refresh } from '@element-plus/icons-vue'
import api from '../api'
import { stepStore } from '../stores/stepStore'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  email: { type: String, default: '' },
  // When live=true, step-status socket events in stepStore override the
  // fetched step statuses in real time. Used by Execute.vue.
  live: { type: Boolean, default: false },
})

const emit = defineEmits(['update:modelValue'])

const steps = ref([])
const loading = ref(false)
const loadError = ref('')
const expandedLogs = ref(new Set())
const retryingStep = ref(null)

// ---------- merge logic ----------

// Effective status: prefer live stepStore override when live=true and the
// socket has emitted an update for this (email, stepId) pair; otherwise
// fall back to the fetched step.status.
function effectiveStatus(step) {
  if (props.live && props.email && stepStore.byEmail[props.email]?.[step.stepId]?.status) {
    return stepStore.byEmail[props.email][step.stepId].status
  }
  return step.status
}

// Effective reason: same merge priority.
function effectiveReason(step) {
  if (props.live && props.email && stepStore.byEmail[props.email]?.[step.stepId]?.status) {
    return stepStore.byEmail[props.email][step.stepId].reason || step.reason || ''
  }
  return step.reason || ''
}

// ---------- fetch ----------

async function fetchSteps() {
  if (!props.email) return
  loading.value = true
  loadError.value = ''
  try {
    const { data } = await api.get(`/accounts/${encodeURIComponent(props.email)}/steps`)
    steps.value = data.steps || []
  } catch (e) {
    loadError.value = e.response?.data?.error || '加载步骤失败'
    ElMessage.error(loadError.value)
  } finally {
    loading.value = false
  }
}

// ---------- open trigger ----------

function onOpen() {
  expandedLogs.value = new Set()
  fetchSteps()
}

// Re-fetch when email changes while drawer is already open
watch(() => props.email, (newEmail) => {
  if (props.modelValue && newEmail) {
    expandedLogs.value = new Set()
    fetchSteps()
  }
})

// Also trigger when drawer opens (modelValue false→true)
watch(() => props.modelValue, (isOpen) => {
  if (isOpen && props.email) {
    expandedLogs.value = new Set()
    fetchSteps()
  }
})

// ---------- logs toggle ----------

function toggleLogs(stepId) {
  const s = new Set(expandedLogs.value)
  if (s.has(stepId)) {
    s.delete(stepId)
  } else {
    s.add(stepId)
  }
  expandedLogs.value = s
}

// ---------- retry ----------

async function retryStep(step) {
  retryingStep.value = step.stepId
  try {
    await api.post('/execute/retry-step', { email: props.email, stepId: step.stepId })
    ElMessage.success('已从该步重试')
    // Re-fetch after a short delay to let engine start updating steps
    setTimeout(() => fetchSteps(), 1500)
  } catch (e) {
    const status = e.response?.status
    if (status === 409) {
      ElMessage.warning('引擎正在运行，请先停止')
    } else {
      ElMessage.error(e.response?.data?.error || '重试失败')
    }
  } finally {
    retryingStep.value = null
  }
}

// ---------- display helpers ----------

const STEP_STATUS_LABEL = {
  pending: '待执行',
  running: '执行中',
  success: '成功',
  failed: '失败',
  skipped: '已跳过',
}

const STEP_STATUS_TAG_TYPE = {
  pending: 'info',
  running: '',
  success: 'success',
  failed: 'danger',
  skipped: 'info',
}

function stepStatusLabel(s) {
  return STEP_STATUS_LABEL[s] || s || '-'
}

function stepStatusTagType(s) {
  return STEP_STATUS_TAG_TYPE[s] ?? 'info'
}

function formatTs(ts) {
  if (!ts) return ''
  const s = typeof ts === 'string' ? ts : new Date(ts).toISOString()
  return s.slice(0, 19).replace('T', ' ')
}

function durationLabel(startedAt, finishedAt) {
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime()
  if (isNaN(ms) || ms < 0) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return s ? `${m}m ${s}s` : `${m}m`
}
</script>

<style scoped>
.asd-body {
  padding: var(--sp-3) var(--sp-4);
  min-height: 100px;
}

.asd-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  padding: var(--sp-6);
  color: var(--app-text-3);
  font-size: var(--fs-md);
}

.asd-loading-icon {
  font-size: 20px;
  animation: asd-spin 1.2s linear infinite;
}

@keyframes asd-spin {
  to { transform: rotate(360deg); }
}

.asd-error {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-4);
  color: var(--el-color-danger);
  font-size: var(--fs-md);
}

.asd-header-actions {
  display: flex;
  justify-content: flex-end;
  margin-bottom: var(--sp-3);
}

.asd-empty {
  padding: var(--sp-6);
  text-align: center;
  color: var(--app-text-mute);
  font-size: var(--fs-md);
}

/* ---------- Stepper ---------- */

.asd-steps {
  display: flex;
  flex-direction: column;
}

.asd-step {
  display: flex;
  gap: var(--sp-3);
  min-height: 48px;
}

.asd-step__track {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex-shrink: 0;
  width: 28px;
}

.asd-step__icon {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  flex-shrink: 0;
  background: var(--app-surface-2);
  border: 2px solid var(--app-border-soft);
  color: var(--app-text-mute);
}

.asd-step__icon--pending {
  background: var(--app-surface-2);
  border-color: var(--app-border-soft);
  color: var(--app-text-mute);
}

.asd-step__icon--running {
  background: var(--el-color-primary-light-9);
  border-color: var(--app-brand);
  color: var(--app-brand);
}

.asd-step__icon--success {
  background: var(--el-color-success-light-9);
  border-color: var(--el-color-success);
  color: var(--el-color-success);
}

.asd-step__icon--failed {
  background: var(--el-color-danger-light-9);
  border-color: var(--el-color-danger);
  color: var(--el-color-danger);
}

.asd-step__icon--skipped {
  background: var(--app-surface-2);
  border-color: var(--app-border-soft);
  color: var(--app-text-mute);
  opacity: 0.6;
}

.asd-step__dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}

.asd-spin {
  animation: asd-spin 1.2s linear infinite;
}

.asd-step__line {
  flex: 1;
  width: 2px;
  background: var(--app-border-soft);
  margin: 4px 0;
  min-height: 12px;
}

.asd-step__content {
  flex: 1;
  min-width: 0;
  padding-bottom: var(--sp-4);
  padding-top: 4px;
}

.asd-step__header {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}

.asd-step__label {
  font-size: var(--fs-md);
  font-weight: 500;
  color: var(--app-text);
}

.asd-step--pending .asd-step__label {
  color: var(--app-text-mute);
}

.asd-step--skipped .asd-step__label {
  color: var(--app-text-mute);
  text-decoration: line-through;
}

.asd-step__timing {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-3);
  margin-top: var(--sp-1);
  font-size: var(--fs-sm);
  color: var(--app-text-3);
}

.asd-step__reason {
  margin-top: var(--sp-1);
  font-size: var(--fs-sm);
  color: var(--el-color-danger);
  word-break: break-word;
}

.asd-step__logs-toggle {
  margin-top: var(--sp-1);
}

.asd-step__logs {
  margin-top: var(--sp-1);
  max-height: 200px;
  overflow-y: auto;
  background: #1e1e1e;
  border-radius: var(--rad-sm);
  padding: var(--sp-2) var(--sp-3);
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.6;
}

.asd-step__log-line {
  white-space: pre-wrap;
  word-break: break-all;
}

.asd-log__ts {
  color: #606060;
  margin-right: 6px;
  flex-shrink: 0;
}

.asd-log__msg {
  color: #d4d4d4;
}

.asd-step__retry {
  margin-top: var(--sp-2);
}
</style>
