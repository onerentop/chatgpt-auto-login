import { createRouter, createWebHashHistory } from 'vue-router'

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('./views/Login.vue'),
    meta: { public: true },
  },
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

router.beforeEach((to, from, next) => {
  const token = localStorage.getItem('token')
  if (!to.meta.public && !token) {
    next('/login')
  } else {
    next()
  }
})

export default router
