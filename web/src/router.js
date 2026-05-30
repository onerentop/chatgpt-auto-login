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
    path: '/phone-pool',
    redirect: '/config',
  },
  {
    path: '/config',
    name: 'Config',
    component: () => import('./views/Config.vue'),
    meta: { title: '配置设置' },
  },
  {
    path: '/gopay',
    name: 'GoPay',
    component: () => import('./views/GoPayActivate.vue'),
    meta: { title: 'GoPay激活' },
  },
]

const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

export default router
