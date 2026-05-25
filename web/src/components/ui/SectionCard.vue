<template>
  <section class="sec-card">
    <header v-if="$slots.title || title || $slots.extra" class="sec-card__head">
      <h3 class="sec-card__title">
        <slot name="title">{{ title }}</slot>
      </h3>
      <div v-if="$slots.extra" class="sec-card__extra">
        <slot name="extra" />
      </div>
    </header>
    <div class="sec-card__body" :class="{ 'sec-card__body--flush': flush }">
      <slot />
    </div>
  </section>
</template>

<script setup>
defineProps({
  title: { type: String, default: '' },
  /**
   * Drops body padding — use for tables / lists that should bleed to the
   * edge of the card. Header still has its own padding.
   */
  flush: { type: Boolean, default: false },
})
</script>

<style scoped>
.sec-card {
  background: var(--app-surface);
  border: 1px solid var(--app-border-soft);
  border-radius: var(--rad-md);
  box-shadow: var(--sh-1);
  overflow: hidden;
}
.sec-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--app-border-soft);
}
.sec-card__title {
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: 600;
  color: var(--app-text);
  line-height: 1.4;
}
.sec-card__extra {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.sec-card__body { padding: var(--sp-4); }
.sec-card__body--flush { padding: 0; }
</style>
