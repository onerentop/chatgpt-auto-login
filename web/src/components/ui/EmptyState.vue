<template>
  <div class="empty">
    <div class="empty__icon-wrap">
      <el-icon class="empty__icon">
        <slot name="icon"><DataLine /></slot>
      </el-icon>
    </div>
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
  animation: app-fade-in var(--tr-base) both;
}
.empty__icon-wrap {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--app-surface-2);
  border: 1px solid var(--app-border-soft);
  box-shadow: var(--sh-1);
  margin-bottom: var(--sp-2);
}
.empty__icon {
  font-size: 28px;
  color: var(--app-text-3);
}
.empty__title {
  margin: 0;
  font-size: var(--fs-xl);
  color: var(--app-text);
  font-weight: 600;
  letter-spacing: -0.01em;
}
.empty__hint {
  margin: 0;
  font-size: var(--fs-md);
  color: var(--app-text-3);
  max-width: 380px;
  line-height: 1.6;
}
.empty__action { margin-top: var(--sp-3); }
</style>
