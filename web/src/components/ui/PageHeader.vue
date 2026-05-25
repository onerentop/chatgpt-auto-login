<template>
  <header class="page-header">
    <div class="page-header__main">
      <h1 class="page-header__title">{{ title }}</h1>
      <p v-if="subtitle || $slots.subtitle" class="page-header__subtitle">
        <slot name="subtitle">{{ subtitle }}</slot>
      </p>
    </div>
    <div v-if="$slots.actions" class="page-header__actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<script setup>
defineProps({
  title: { type: String, required: true },
  subtitle: { type: String, default: '' },
})
</script>

<style scoped>
.page-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--sp-4);
  margin-bottom: var(--sp-5);
  padding-bottom: var(--sp-3);
  border-bottom: 1px solid var(--app-border-soft);
}
.page-header__main { min-width: 0; }
.page-header__title {
  margin: 0;
  font-size: var(--fs-2xl);
  font-weight: 600;
  color: var(--app-text);
  line-height: 1.3;
}
.page-header__subtitle {
  margin: var(--sp-1) 0 0;
  font-size: var(--fs-md);
  color: var(--app-text-3);
  line-height: 1.5;
}
.page-header__actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-shrink: 0;
}
</style>
