<template>
  <Teleport to="body">
    <Transition name="cmd-fade">
      <div
        v-if="paletteState.open"
        class="cmd-backdrop"
        @click.self="close"
      >
        <div class="cmd-modal" role="dialog" aria-label="Command palette">
          <div class="cmd-input-wrap">
            <el-icon class="cmd-input-icon"><Search /></el-icon>
            <input
              ref="inputRef"
              v-model="paletteState.query"
              type="text"
              placeholder="输入命令…  ↑↓ 选择  ↵ 执行  Esc 关闭"
              class="cmd-input"
              autocomplete="off"
              spellcheck="false"
              @keydown.down.prevent="move(1)"
              @keydown.up.prevent="move(-1)"
              @keydown.enter.prevent="execActive"
              @keydown.esc.prevent="close"
            />
            <kbd class="cmd-kbd">Esc</kbd>
          </div>

          <div class="cmd-results">
            <div v-if="flatList.length === 0" class="cmd-empty">
              没有匹配的命令
            </div>
            <div v-for="grp in groupedFilteredCommands.value" :key="grp.group" class="cmd-group">
              <div class="cmd-group__head">{{ grp.group }}</div>
              <div
                v-for="cmd in grp.items"
                :key="cmd.id"
                class="cmd-item"
                :class="{ 'cmd-item--active': cmd.id === activeId }"
                @mouseenter="activeId = cmd.id"
                @click="exec(cmd)"
              >
                <span class="cmd-item__label">{{ cmd.label }}</span>
                <kbd v-if="cmd.shortcut" class="cmd-kbd cmd-kbd--small">{{ cmd.shortcut }}</kbd>
              </div>
            </div>
          </div>

          <div class="cmd-footer">
            <span><kbd class="cmd-kbd cmd-kbd--small">↑</kbd> <kbd class="cmd-kbd cmd-kbd--small">↓</kbd> 选择</span>
            <span><kbd class="cmd-kbd cmd-kbd--small">↵</kbd> 执行</span>
            <span><kbd class="cmd-kbd cmd-kbd--small">Esc</kbd> 关闭</span>
            <span class="cmd-footer__spacer" />
            <span>{{ flatList.length }} 个命令</span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { Search } from '@element-plus/icons-vue'
import {
  paletteState, closePalette,
  filteredCommands, groupedFilteredCommands,
} from '../../stores/commands'

const inputRef = ref(null)
const activeId = ref('')

const flatList = computed(() => filteredCommands.value)

// Focus the input + reset highlight whenever palette opens.
watch(() => paletteState.open, async (open) => {
  if (open) {
    await nextTick()
    inputRef.value?.focus()
    activeId.value = flatList.value[0]?.id || ''
  }
})

// Reset active to top match when filter changes.
watch(() => paletteState.query, () => {
  activeId.value = flatList.value[0]?.id || ''
})

function move(delta) {
  const list = flatList.value
  if (list.length === 0) return
  const idx = list.findIndex((c) => c.id === activeId.value)
  const next = (idx + delta + list.length) % list.length
  activeId.value = list[next].id
  // Scroll the active item into view
  nextTick(() => {
    const el = document.querySelector(`.cmd-item--active`)
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' })
    }
  })
}

function execActive() {
  const cmd = flatList.value.find((c) => c.id === activeId.value)
  if (cmd) exec(cmd)
}

function exec(cmd) {
  closePalette()
  try { cmd.action() } catch (e) { console.error('[cmd]', cmd.id, e) }
}

function close() { closePalette() }
</script>

<style scoped>
.cmd-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.4);
  backdrop-filter: blur(2px);
  z-index: 9999;
  display: flex;
  justify-content: center;
  padding-top: 12vh;
}
.cmd-modal {
  width: min(640px, 92vw);
  max-height: 70vh;
  background: var(--app-surface);
  border-radius: var(--rad-md);
  box-shadow: var(--sh-3);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.cmd-input-wrap {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--app-border-soft);
}
.cmd-input-icon {
  color: var(--app-text-mute);
  font-size: 18px;
}
.cmd-input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font: inherit;
  font-size: var(--fs-xl);
  color: var(--app-text);
}
.cmd-input::placeholder { color: var(--app-text-mute); }

.cmd-results {
  flex: 1;
  overflow-y: auto;
  padding: var(--sp-2) 0;
}
.cmd-empty {
  padding: var(--sp-5);
  text-align: center;
  color: var(--app-text-mute);
  font-size: var(--fs-md);
}
.cmd-group {
  padding: var(--sp-1) 0;
}
.cmd-group__head {
  padding: var(--sp-1) var(--sp-4);
  font-size: var(--fs-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--app-text-mute);
  font-weight: 600;
}
.cmd-item {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-4);
  cursor: pointer;
  color: var(--app-text);
  transition: background var(--tr-fast);
}
.cmd-item--active {
  background: var(--el-color-primary-light-9);
}
.cmd-item__label {
  flex: 1;
  font-size: var(--fs-lg);
}

.cmd-footer {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-4);
  border-top: 1px solid var(--app-border-soft);
  font-size: var(--fs-xs);
  color: var(--app-text-mute);
  background: var(--app-surface-2);
}
.cmd-footer__spacer { flex: 1; }

.cmd-kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--app-surface-2);
  border: 1px solid var(--app-border-soft);
  font-family: var(--ff-mono);
  font-size: var(--fs-xs);
  color: var(--app-text-3);
  min-width: 18px;
  height: 18px;
  line-height: 1;
}
.cmd-kbd--small {
  padding: 1px 4px;
  font-size: 10px;
}

/* Backdrop fade-in */
.cmd-fade-enter-active, .cmd-fade-leave-active {
  transition: opacity var(--tr-fast);
}
.cmd-fade-enter-from, .cmd-fade-leave-to {
  opacity: 0;
}
.cmd-fade-enter-active .cmd-modal,
.cmd-fade-leave-active .cmd-modal {
  transition: transform var(--tr-base), opacity var(--tr-base);
}
.cmd-fade-enter-from .cmd-modal,
.cmd-fade-leave-to .cmd-modal {
  transform: translateY(-8px) scale(0.98);
  opacity: 0;
}
</style>
