import { createRouter, createWebHashHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    name: 'Dashboard',
    component: () => import('./views/Dashboard.vue'),
  },
  {
    path: '/accounts',
    name: 'Accounts',
    component: () => import('./views/Accounts.vue'),
  },
  {
    path: '/config',
    name: 'Config',
    component: () => import('./views/Config.vue'),
  },
  {
    path: '/execute',
    name: 'Execute',
    component: () => import('./views/Execute.vue'),
  },
  {
    path: '/results',
    name: 'Results',
    component: () => import('./views/Results.vue'),
  },
]

const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

export default router
