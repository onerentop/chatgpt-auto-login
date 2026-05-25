<template>
  <div class="empty">
    <el-icon class="empty__icon">
      <slot name="icon"><DataLine /></slot>
    </el-icon>
    <p class="empty__title">{{ title }}</p>
    <p v-if="hint || $slots.hint" class="empty__hint">
      <slot name="hint">{{ hint }}</slot>
    </p>
    <div v-if="$slots.action" class="empty__action">
      <slot name="action" />
    </div>
  </div>
</template>

<script setup>
import { DataLine } from '@element-plus/icons-vue'

defineProps({
  title: { type: String, required: true },
  hint:  { type: String, default: '' },
})
</script>

<style scoped>
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--sp-7) var(--sp-4);
  color: var(--app-text-mute);
  text-align: center;
  gap: var(--sp-2);
}
.empty__icon {
  font-size: 36px;
  color: var(--app-text-mute);
  opacity: 0.6;
  margin-bottom: var(--sp-1);
}
.empty__title {
  margin: 0;
  font-size: var(--fs-lg);
  color: var(--app-text-3);
  font-weight: 500;
}
.empty__hint {
  margin: 0;
  font-size: var(--fs-md);
  color: var(--app-text-mute);
  max-width: 360px;
  line-height: 1.5;
}
.empty__action { margin-top: var(--sp-3); }
</style>
