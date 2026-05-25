import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
// Dark theme variables — toggled via document.documentElement.classList.add('dark').
import 'element-plus/theme-chalk/dark/css-vars.css'
// v2.34 design tokens (must come AFTER Element Plus so our --app-* layer wins).
import './styles/tokens.css'
// v2.35 visual polish — brand palette + multi-layer shadows + Element Plus
// global rounding / hover lift / scrollbars. Layered AFTER tokens.css to
// selectively override only what v2.35 changes.
import './styles/v235-polish.css'
// v2.36 GitHub theme — replaces v2.35 indigo/SaaS aesthetic. Loaded AFTER
// v2.35 so its tokens win. Kept v235-polish.css on disk so `git revert`
// brings indigo back without resurrecting deleted files.
import './styles/v236-github.css'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import App from './App.vue'
import router from './router'

// Restore dark-mode preference before mounting so first paint has the right theme.
{
  const saved = localStorage.getItem('theme')
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches
  if (saved === 'dark' || (!saved && prefersDark)) {
    document.documentElement.classList.add('dark')
  }
}

const app = createApp(App)
app.use(ElementPlus, { locale: zhCn })
app.use(router)
app.mount('#app')
