<template>
  <div>
    <el-row style="margin-bottom: 16px" :gutter="12" align="middle">
      <el-col :span="24">
        <el-button type="primary" @click="showImport = true">批量导入</el-button>
        <el-button @click="exportAccounts">导出</el-button>
        <el-button type="success" @click="openAdd">添加单个</el-button>
        <el-tag style="margin-left: 12px">共 {{ accounts.length }} 个账号</el-tag>
      </el-col>
    </el-row>

    <el-table :data="accounts" stripe border size="small">
      <el-table-column type="index" label="#" width="50" />
      <el-table-column prop="email" label="邮箱" min-width="220" />
      <el-table-column prop="loginType" label="类型" width="90">
        <template #default="{ row }">
          <el-tag :type="row.loginType === 'Google' ? 'danger' : 'warning'" size="small">{{ row.loginType }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="计划" width="80">
        <template #default="{ row }">
          <el-tag v-if="row._plan === 'plus'" type="success" size="small">Plus</el-tag>
          <el-tag v-else-if="row._plan === 'free'" size="small">Free</el-tag>
          <span v-else style="color:#c0c4cc">-</span>
        </template>
      </el-table-column>
      <el-table-column label="密码" width="150">
        <template #default="{ row }">
          <span style="font-family:monospace">{{ row._showPw ? row.password : '••••••' }}</span>
          <el-button size="small" text @click.stop="row._showPw = !row._showPw">{{ row._showPw ? '隐' : '显' }}</el-button>
        </template>
      </el-table-column>
      <el-table-column prop="totp_secret" label="TOTP" min-width="120" show-overflow-tooltip>
        <template #default="{ row }">{{ row.totp_secret || '-' }}</template>
      </el-table-column>
      <el-table-column prop="client_id" label="Client ID" min-width="120" show-overflow-tooltip>
        <template #default="{ row }">{{ row.client_id || '-' }}</template>
      </el-table-column>
      <el-table-column label="Refresh Token" min-width="120" show-overflow-tooltip>
        <template #default="{ row }">{{ row.refresh_token ? row.refresh_token.slice(0, 20) + '...' : '-' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="140">
        <template #default="{ row }">
          <el-button size="small" text type="primary" @click="openEdit(row)">编辑</el-button>
          <el-popconfirm title="确定删除?" @confirm="del(row.email)">
            <template #reference><el-button size="small" text type="danger">删除</el-button></template>
          </el-popconfirm>
        </template>
      </el-table-column>
    </el-table>

    <!-- Import Dialog -->
    <el-dialog v-model="showImport" title="批量导入" width="650">
      <p style="color:#909399;margin-bottom:12px">每行一个账号，格式：<code>邮箱----密码----2FA/ClientID----RefreshToken</code><br>空白符会自动去除</p>
      <el-input v-model="importText" type="textarea" :rows="12" placeholder="email----password----2fa----token&#10;email2----password2----clientId----refreshToken" />
      <template #footer>
        <el-button @click="showImport = false">取消</el-button>
        <el-button type="primary" @click="doImport">导入</el-button>
      </template>
    </el-dialog>

    <!-- Add / Edit Dialog -->
    <el-dialog v-model="showEdit" :title="editMode ? '编辑账号' : '添加账号'" width="520">
      <el-form label-width="120px">
        <el-form-item label="邮箱"><el-input v-model="form.email" :disabled="editMode" /></el-form-item>
        <el-form-item label="密码"><el-input v-model="form.password" /></el-form-item>
        <el-form-item label="TOTP 密钥"><el-input v-model="form.totp_secret" placeholder="Gmail 账号填写" /></el-form-item>
        <el-form-item label="Client ID"><el-input v-model="form.client_id" placeholder="Outlook 账号填写" /></el-form-item>
        <el-form-item label="Refresh Token"><el-input v-model="form.refresh_token" type="textarea" :rows="3" placeholder="Outlook 账号填写" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEdit = false">取消</el-button>
        <el-button type="primary" @click="saveEdit">{{ editMode ? '保存' : '添加' }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'

const accounts = ref([])
const showImport = ref(false)
const showEdit = ref(false)
const editMode = ref(false)
const importText = ref('')
const form = ref({ email: '', password: '', totp_secret: '', client_id: '', refresh_token: '' })
const editOrigEmail = ref('')

async function load() {
  try {
    const [acctRes, statusRes] = await Promise.all([api.get('/accounts/raw'), api.get('/results').catch(() => ({ data: [] }))])
    const statusMap = {}
    for (const s of (statusRes.data || [])) {
      statusMap[s.email] = s.status
    }
    accounts.value = acctRes.data.map(a => {
      const st = (statusMap[a.email] || '').toLowerCase()
      const plan = ['success', 'already_plus'].includes(st) ? 'plus' : (st === 'error' || st === 'failed' || st === 'no_link' ? 'free' : '')
      return { ...a, _showPw: false, _plan: plan }
    })
  } catch {}
}
onMounted(load)

function openAdd() {
  editMode.value = false
  form.value = { email: '', password: '', totp_secret: '', client_id: '', refresh_token: '' }
  showEdit.value = true
}

function openEdit(row) {
  editMode.value = true
  editOrigEmail.value = row.email
  form.value = { email: row.email, password: row.password, totp_secret: row.totp_secret || '', client_id: row.client_id || '', refresh_token: row.refresh_token || '' }
  showEdit.value = true
}

async function saveEdit() {
  try {
    if (editMode.value) {
      await api.put(`/accounts/${encodeURIComponent(editOrigEmail.value)}`, form.value)
      ElMessage.success('已更新')
    } else {
      await api.post('/accounts', form.value)
      ElMessage.success('已添加')
    }
    showEdit.value = false
    load()
  } catch (e) { ElMessage.error(e.response?.data?.error || '操作失败') }
}

async function doImport() {
  try {
    const { data } = await api.post('/accounts/import', { text: importText.value })
    ElMessage.success(`导入 ${data.added} 个，跳过 ${data.skipped} 个`)
    showImport.value = false
    importText.value = ''
    load()
  } catch (e) { ElMessage.error(e.response?.data?.error || '导入失败') }
}

async function del(email) {
  try { await api.delete(`/accounts/${encodeURIComponent(email)}`); ElMessage.success('已删除'); load() }
  catch { ElMessage.error('删除失败') }
}

function exportAccounts() { window.open(`/api/accounts/export?token=${localStorage.getItem('token') || ''}`) }
</script>
