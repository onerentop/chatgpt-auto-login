<template>
  <div>
    <el-row style="margin-bottom: 16px" :gutter="12" align="middle">
      <el-col :span="18">
        <el-button type="primary" @click="showAddDialog = true">添加账号</el-button>
        <el-button @click="showImportDialog = true">批量导入</el-button>
        <el-button @click="handleExport">导出</el-button>
        <el-tag style="margin-left: 12px" type="info">共 {{ accounts.length }} 个账号</el-tag>
      </el-col>
    </el-row>

    <el-table :data="accounts" stripe style="width: 100%">
      <el-table-column prop="email" label="邮箱" min-width="220" />
      <el-table-column prop="loginType" label="类型" width="100">
        <template #default="{ row }">
          <el-tag :type="row.loginType === 'plus' ? 'success' : 'info'" size="small">
            {{ row.loginType || 'normal' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="密码" width="150">
        <template #default="{ row }">
          {{ row.password ? '******' : '-' }}
        </template>
      </el-table-column>
      <el-table-column label="操作" width="100" fixed="right">
        <template #default="{ row }">
          <el-popconfirm title="确认删除该账号？" @confirm="handleDelete(row.email)">
            <template #reference>
              <el-button type="danger" size="small" link>删除</el-button>
            </template>
          </el-popconfirm>
        </template>
      </el-table-column>
    </el-table>

    <!-- Add Dialog -->
    <el-dialog v-model="showAddDialog" title="添加账号" width="500px">
      <el-form :model="addForm" label-width="120px">
        <el-form-item label="邮箱" required>
          <el-input v-model="addForm.email" placeholder="账号邮箱" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="addForm.password" type="password" show-password placeholder="登录密码" />
        </el-form-item>
        <el-form-item label="TOTP Secret">
          <el-input v-model="addForm.totp_secret" placeholder="两步验证密钥（可选）" />
        </el-form-item>
        <el-form-item label="Client ID">
          <el-input v-model="addForm.client_id" placeholder="OAuth Client ID（可选）" />
        </el-form-item>
        <el-form-item label="Refresh Token">
          <el-input v-model="addForm.refresh_token" type="password" show-password placeholder="Refresh Token（可选）" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddDialog = false">取消</el-button>
        <el-button type="primary" :loading="addLoading" @click="handleAdd">添加</el-button>
      </template>
    </el-dialog>

    <!-- Import Dialog -->
    <el-dialog v-model="showImportDialog" title="批量导入" width="600px">
      <p style="margin-bottom: 12px; color: #909399">
        每个账号用 <code>----</code> 分隔，每行格式：key=value 或 key: value
      </p>
      <el-input
        v-model="importText"
        type="textarea"
        :rows="12"
        placeholder="email=user@example.com
password=xxx
totp_secret=xxx
----
email=user2@example.com
password=yyy"
      />
      <template #footer>
        <el-button @click="showImportDialog = false">取消</el-button>
        <el-button type="primary" :loading="importLoading" @click="handleImport">导入</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'

const accounts = ref([])
const showAddDialog = ref(false)
const showImportDialog = ref(false)
const addLoading = ref(false)
const importLoading = ref(false)
const importText = ref('')

const addForm = reactive({
  email: '',
  password: '',
  totp_secret: '',
  client_id: '',
  refresh_token: '',
})

async function loadAccounts() {
  try {
    const { data } = await api.get('/accounts')
    accounts.value = data.accounts || data || []
  } catch (err) {
    console.error('Failed to load accounts:', err)
  }
}

onMounted(loadAccounts)

async function handleAdd() {
  if (!addForm.email) {
    ElMessage.warning('请输入邮箱')
    return
  }
  addLoading.value = true
  try {
    await api.post('/accounts', { ...addForm })
    ElMessage.success('添加成功')
    showAddDialog.value = false
    Object.keys(addForm).forEach((k) => (addForm[k] = ''))
    await loadAccounts()
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '添加失败')
  } finally {
    addLoading.value = false
  }
}

async function handleDelete(email) {
  try {
    await api.delete(`/accounts/${encodeURIComponent(email)}`)
    ElMessage.success('已删除')
    await loadAccounts()
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '删除失败')
  }
}

function handleExport() {
  const token = localStorage.getItem('token')
  window.open(`/api/accounts/export?token=${token}`)
}

async function handleImport() {
  if (!importText.value.trim()) {
    ElMessage.warning('请输入账号数据')
    return
  }
  importLoading.value = true
  try {
    const blocks = importText.value.split('----').filter((b) => b.trim())
    const parsed = blocks.map((block) => {
      const obj = {}
      block
        .trim()
        .split('\n')
        .forEach((line) => {
          const sep = line.includes('=') ? '=' : ':'
          const idx = line.indexOf(sep)
          if (idx > 0) {
            const key = line.slice(0, idx).trim()
            const val = line.slice(idx + 1).trim()
            obj[key] = val
          }
        })
      return obj
    })

    await api.post('/accounts/import', { accounts: parsed })
    ElMessage.success(`成功导入 ${parsed.length} 个账号`)
    showImportDialog.value = false
    importText.value = ''
    await loadAccounts()
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '导入失败')
  } finally {
    importLoading.value = false
  }
}
</script>
