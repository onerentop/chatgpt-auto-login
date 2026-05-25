<template>
  <Transition name="cab">
    <div v-if="count > 0" class="cab" role="toolbar" aria-label="Bulk action toolbar">
      <div class="cab__count">
        <strong>{{ count }}</strong>
        <span class="cab__count-label">{{ label }}</span>
      </div>
      <div class="cab__divider" />
      <div class="cab__actions"><slot /></div>
      <div class="cab__spacer" />
      <el-button text @click="$emit('clear')">取消选中</el-button>
    </div>
  </Transition>
</template>

<script setup>
defineProps({
  count: { type: Number, default: 0 },
  label: { type: String, default: '已选' },
})
defineEmits(['clear'])
</script>

<style scoped>
.cab {
  position: fixed;
  left: 50%;
  bottom: var(--sp-5);
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-3) var(--sp-2) var(--sp-4);
  background: var(--app-surface);
  border: 1px solid var(--app-border);
  border-radius: 999px;
  box-shadow: var(--sh-3);
  z-index: 100;
  max-width: calc(100vw - var(--sp-5) * 2);
}
.cab__count {
  display: flex;
  align-items: baseline;
  gap: var(--sp-1);
}
.cab__count strong {
  font-size: var(--fs-xl);
  font-weight: 600;
  color: var(--app-brand);
  font-variant-numeric: tabular-nums;
}
.cab__count-label {
  font-size: var(--fs-md);
  color: var(--app-text-3);
}
.cab__divider {
  width: 1px;
  height: 24px;
  background: var(--app-border-soft);
}
.cab__actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.cab__spacer { width: var(--sp-2); }

.cab-enter-active, .cab-leave-active {
  transition: opacity var(--tr-base), transform var(--tr-base);
}
.cab-enter-from, .cab-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(12px);
}
</style>
