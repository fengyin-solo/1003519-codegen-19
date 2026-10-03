<template>
  <section class="page" data-module="plan">
    <header class="page-head">
      <div>
        <h2>测报方案管理</h2>
        <p class="page-desc">维护测报方案，调整适用范围、测次安排前自动写入留痕快照，误改后可按快照回放方案、站房维护待办与巡检清单。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记测报方案</button>
        <button class="btn" type="button" @click="openArchive()">快照归档</button>
        <button class="btn" type="button" @click="exportRows">导出测报方案清单</button>
      </div>
    </header>

    <p class="snapshot-policy">
      留痕规则：调整适用范围或测次安排前先拍快照；人工回放与自动合并冲突时，以「人工回放」为准；同一快照重复回放只生效一次。
    </p>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button class="link" type="button" @click="openAdjust(row)">调整方案</button>
            <button class="link" type="button" @click="openArchive(row)">快照归档</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无测报方案数据，可先登记测报方案</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条测报方案记录 · 快照 {{ snapshotCount }} 份</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="okMessage" class="ok-text">{{ okMessage }}</span>
    </footer>

    <!-- 调整方案：草稿仅存在于本次会话的内存中，关闭或离开页面即丢弃，不沿用旧草稿 -->
    <div v-if="adjustTarget" class="modal-mask" @click.self="closeAdjust">
      <div class="modal">
        <h3 class="modal-title">调整测报方案 · 先留痕</h3>
        <p class="modal-hint">
          方案 {{ adjustTarget['方案编号'] }}：保存调整前会先写入一份快照（含站房维护待办、巡检清单），误改后可整体回放。
        </p>
        <label class="modal-field">
          <span>适用范围</span>
          <textarea v-model="adjustForm.scope" rows="2" placeholder="调整后的适用范围"></textarea>
        </label>
        <label class="modal-field">
          <span>测次安排</span>
          <textarea v-model="adjustForm.schedule" rows="2" placeholder="调整后的测次安排"></textarea>
        </label>
        <p v-if="adjustError" class="error-text">{{ adjustError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeAdjust">取消（丢弃草稿）</button>
          <button class="btn primary" type="button" @click="submitAdjust">写入快照并保存调整</button>
        </div>
      </div>
    </div>

    <!-- 快照归档：与列表读同一个存储通道，刷新后内容一致 -->
    <div v-if="archiveOpen" class="modal-mask" @click.self="closeArchive">
      <div class="modal modal-wide">
        <h3 class="modal-title">
          留痕快照归档<template v-if="archivePlan"> · 方案 {{ archivePlan['方案编号'] }}</template>
        </h3>
        <p class="modal-hint">
          人工回放按快照整体恢复方案、站房维护待办、巡检清单；自动合并仅补回被误删项，冲突时以人工回放为准。
        </p>
        <table class="data-table">
          <thead>
            <tr>
              <th>快照时间</th>
              <th>方案编号</th>
              <th>来源</th>
              <th>留痕原因</th>
              <th>打包内容</th>
              <th>回放状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="snap in archiveSnaps" :key="snap.id">
              <td>{{ snap.snapshotTime }}</td>
              <td>{{ snap.planCode }}</td>
              <td>{{ snap.source }}</td>
              <td>
                {{ snap.reason }}
                <span v-if="snap.note" class="snapshot-note">（{{ snap.note }}）</span>
              </td>
              <td>
                方案 1 · 待办 {{ snap.bundle.stationhouse.length }} · 巡检 {{ snap.bundle.inspection.length }}
              </td>
              <td>
                <span v-if="snap.replayed" class="badge badge-done">
                  已{{ snap.replayed.mode === 'manual' ? '人工回放' : '自动合并' }} {{ snap.replayed.at }}
                </span>
                <span v-else class="badge badge-undo">未回放</span>
              </td>
              <td class="row-actions">
                <button class="link" type="button" @click="replay(snap.id)">人工回放</button>
                <button class="link" type="button" @click="autoMerge(snap.id)">自动合并</button>
              </td>
            </tr>
            <tr v-if="!archiveSnaps.length">
              <td colspan="7" class="empty-state">该方案暂无留痕快照；已批准旧方案会按批准日期自动补全</td>
            </tr>
          </tbody>
        </table>
        <p v-if="archiveError" class="error-text">{{ archiveError }}</p>
        <div class="modal-actions">
          <button class="btn primary" type="button" @click="closeArchive">关闭</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  adjustPlan,
  autoMergeSnapshot,
  listSnapshots,
  replaySnapshot,
} from '@/api/plan-snapshot'
import type { EntryRow, PlanSnapshot } from '@/data/types'

const meta = moduleMeta('plan')
const columns = ["方案编号", "方案名称", "适用范围", "监测项目", "测次安排", "编制人", "批准人", "方案状态"]
const actions = ["提交审批", "批准方案", "废止方案"]
const statuses = ["编制中", "待审批", "已批准", "已修订", "已废止"]
const stats = [{"label": "方案总数", "value": 0}, {"label": "已批准方案", "value": 0}, {"label": "待审批方案", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const okMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// —— 调整方案草稿：只放在组件内存，绝不写 localStorage；重新进入页面拿到的是干净表单 ——
const adjustTarget = ref<EntryRow | null>(null)
const adjustForm = ref<{ scope: string; schedule: string }>({ scope: '', schedule: '' })
const adjustError = ref('')

// —— 快照归档弹窗 ——
const archiveOpen = ref(false)
const archivePlan = ref<EntryRow | null>(null)
const archiveSnaps = ref<PlanSnapshot[]>([])
const archiveError = ref('')

const snapshotCount = computed(() => listSnapshots().length)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '测报方案登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  okMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  okMessage.value = result.message
  reload()
}

function openAdjust(row: EntryRow) {
  // 每次进入都用当前存储里的方案值重置表单，不沿用任何旧草稿。
  adjustTarget.value = row
  adjustForm.value = {
    scope: String(row['适用范围'] ?? ''),
    schedule: String(row['测次安排'] ?? ''),
  }
  adjustError.value = ''
}

function closeAdjust() {
  adjustTarget.value = null
  adjustForm.value = { scope: '', schedule: '' }
  adjustError.value = ''
}

function submitAdjust() {
  if (!adjustTarget.value) {
    return
  }
  const result = adjustPlan(Number(adjustTarget.value.id), {
    scope: adjustForm.value.scope,
    schedule: adjustForm.value.schedule,
  })
  if (!result.ok) {
    adjustError.value = result.message
    return
  }
  okMessage.value = result.message
  errorMessage.value = ''
  closeAdjust()
  reload()
}

function openArchive(row?: EntryRow) {
  archivePlan.value = row ?? null
  archiveOpen.value = true
  archiveError.value = ''
  refreshArchive()
}

function refreshArchive() {
  archiveSnaps.value = listSnapshots(
    archivePlan.value ? Number(archivePlan.value.id) : undefined,
  )
}

function closeArchive() {
  archiveOpen.value = false
  archivePlan.value = null
  archiveSnaps.value = []
  archiveError.value = ''
}

function replay(id: string) {
  archiveError.value = ''
  const result = replaySnapshot(id)
  if (!result.ok) {
    archiveError.value = result.message
    return
  }
  okMessage.value = result.message
  errorMessage.value = ''
  refreshArchive()
  reload()
}

function autoMerge(id: string) {
  archiveError.value = ''
  const result = autoMergeSnapshot(id)
  if (!result.ok) {
    archiveError.value = result.message
    return
  }
  okMessage.value = result.message
  errorMessage.value = ''
  refreshArchive()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '测报方案列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.snapshot-policy {
  margin: 0 0 12px;
  padding: 8px 12px;
  font-size: 12px;
  color: #475569;
  background: #eef4ff;
  border: 1px solid #c7d9f7;
  border-radius: 6px;
}
.ok-text { color: #15803d; }
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.modal {
  width: 480px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  overflow: auto;
  background: #fff;
  border-radius: 10px;
  padding: 18px 20px;
}
.modal-wide { width: 860px; }
.modal-title { margin: 0 0 6px; font-size: 16px; }
.modal-hint { margin: 0 0 12px; font-size: 12px; color: var(--muted); }
.modal-field { display: block; margin-bottom: 12px; }
.modal-field span { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.modal-field textarea {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  font: inherit;
  resize: vertical;
}
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
.snapshot-note { color: var(--muted); }
.badge { border-radius: 999px; padding: 2px 8px; font-size: 12px; white-space: nowrap; }
.badge-done { background: #dcfce7; color: #15803d; }
.badge-undo { background: #e2e8f0; color: #475569; }
</style>
