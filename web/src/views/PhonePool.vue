<template>
  <div>
    <PageHeader title="号池" :subtitle="`共 ${items.length} 个号 / 已用 ${totalBindings} 个绑定`">
      <template #actions>
        <el-button @click="showImport = true">批量导入</el-button>
        <el-button @click="exportAll">导出</el-button>
        <el-button @click="$router.push('/config')">号池配置</el-button>
      </template>
    </PageHeader>
    <SectionCard>
      <el-table :data="items" stripe border size="small" style="width:100%">
        <el-table-column type="expand">
          <template #default="{ row }">
            <div style="padding:8px 16px;color:#606266">
              已绑定账户 ({{ row.boundEmails.length }}):
              <el-tag v-for="e in row.boundEmails" :key="e" size="small" style="margin:2px">{{ e }}</el-tag>
              <span v-if="row.boundEmails.length === 0" style="color:#909399">（无）</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="phone" label="手机号" width="160" />
        <el-table-column label="SMS URL" min-width="280">
          <template #default="{ row }">
            <el-tooltip :content="row.smsApiUrl" placement="top">
              <span style="font-family:monospace">{{ row.smsApiUrl.slice(0, 50) }}{{ row.smsApiUrl.length > 50 ? '...' : '' }}</span>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="绑定数" width="100">
          <template #default="{ row }">
            <el-tag :type="row.bindings_used >= maxBindingsPerPhone ? 'danger' : 'success'" size="small">
              {{ row.bindings_used }} / {{ maxBindingsPerPhone }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="created_at" label="创建时间" width="160">
          <template #default="{ row }">
            <span style="color:#909399">{{ row.created_at }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100">
          <template #default="{ row }">
            <el-popconfirm :title="`删除 ${row.phone}？已有 ${row.boundEmails.length} 个绑定会一并删除。`" @confirm="del(row.phone)">
              <template #reference><el-button size="small" text type="danger">删除</el-button></template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>
    </SectionCard>

    <el-dialog v-model="showImport" title="批量导入手机号" width="600px">
      <el-input
        v-model="importText"
        type="textarea"
        :rows="12"
        placeholder="每行一条，格式：&#10;+14642840651|http://a.62-us.com/api/get_sms?key=...&#10;+15001234567|http://b.cd.com/sms?key=..."
      />
      <div style="margin-top:8px;color:#909399;font-size:12px">
        手机号必须 E.164 格式（+ 开头 10-15 位数字）。重复、非法、空 URL 会跳过。
      </div>
      <template #footer>
        <el-button @click="showImport = false">取消</el-button>
        <el-button type="primary" @click="doImport" :loading="importing">导入</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'
import PageHeader from '../components/ui/PageHeader.vue'
import SectionCard from '../components/ui/SectionCard.vue'

const items = ref([])
const maxBindingsPerPhone = ref(5)
const showImport = ref(false)
const importText = ref('')
const importing = ref(false)

const totalBindings = computed(() => items.value.reduce((s, r) => s + r.bindings_used, 0))

async function load() {
  try {
    const { data } = await api.get('/phone-pool')
    items.value = data.items || []
    maxBindingsPerPhone.value = data.maxBindingsPerPhone || 5
  } catch (e) { ElMessage.error(e?.response?.data?.error || '加载失败') }
}

async function doImport() {
  if (!importText.value.trim()) return ElMessage.warning('请粘贴号池数据')
  importing.value = true
  try {
    const { data } = await api.post('/phone-pool/import', { text: importText.value })
    ElMessage.success(`导入完成：新增 ${data.added}，跳过 ${data.skipped}`)
    showImport.value = false
    importText.value = ''
    await load()
  } catch (e) { ElMessage.error(e?.response?.data?.error || '导入失败') }
  finally { importing.value = false }
}

function exportAll() {
  window.open('/api/phone-pool/export')
}

async function del(phone) {
  try {
    await api.delete(`/phone-pool/${encodeURIComponent(phone)}`)
    ElMessage.success('已删除')
    await load()
  } catch (e) { ElMessage.error(e?.response?.data?.error || '删除失败') }
}

onMounted(load)
</script>
