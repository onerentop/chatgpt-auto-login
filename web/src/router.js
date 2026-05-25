import { createRouter, createWebHashHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    name: 'Dashboard',
    component: () => import('./views/Dashboard.vue'),
    meta: { title: '仪表盘' },
  },
  {
    path: '/accounts',
    name: 'Accounts',
    component: () => import('./views/Accounts.vue'),
    meta: { title: '账号管理' },
  },
  {
    path: '/execute',
    name: 'Execute',
    component: () => import('./views/Execute.vue'),
    meta: { title: '执行控制' },
  },
  {
    path: '/results',
    name: 'Results',
    component: () => import('./views/Results.vue'),
    meta: { title: '执行结果' },
  },
  {
    path: '/phone-pool',
    name: 'PhonePool',
    component: () => import('./views/PhonePool.vue'),
    meta: { title: '号池' },
  },
  {
    path: '/config',
    name: 'Config',
    component: () => import('./views/Config.vue'),
    meta: { title: '配置设置' },
  },
]

const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

export default router
