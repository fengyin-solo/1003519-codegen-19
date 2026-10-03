<template>
  <section class="page" data-module="plan">
    <header class="page-head">
      <div>
        <h2>测报方案管理</h2>
        <p class="page-desc">维护测报方案，围绕方案编号、方案名称、适用范围、监测项目做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记测报方案</button>
        <button class="btn" type="button" @click="exportRows">导出测报方案清单</button>
      </div>
    </header>

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
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
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
            <button class="link" type="button" @click="openEditor(row)">调整范围/测次</button>
            <button class="link" type="button" @click="openSnapshots(row)">留痕快照</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无测报方案数据，可先登记测报方案</td>
        </tr>
      </tbody>
    </table>

    <section v-if="editing" class="panel" data-panel="adjust">
      <h3 class="panel-title">调整适用范围 / 测次安排 — {{ editing['方案编号'] }}</h3>
      <p class="panel-hint">保存前会把当前状态写入留痕快照；草稿只留在本页，重新进入页面不会沿用。</p>
      <form class="panel-form" @submit.prevent="saveEdit">
        <label class="filter-item">
          <span>适用范围</span>
          <input v-model="draft.适用范围" placeholder="填写调整后的适用范围" />
        </label>
        <label class="filter-item">
          <span>测次安排</span>
          <input v-model="draft.测次安排" placeholder="填写调整后的测次安排" />
        </label>
        <button class="btn primary" type="submit">保存调整</button>
        <button class="btn ghost" type="button" @click="closeEditor">取消</button>
      </form>
    </section>

    <section v-if="snapshotPlan" class="panel" data-panel="snapshots">
      <h3 class="panel-title">留痕快照归档 — {{ snapshotPlan['方案编号'] }}</h3>
      <p class="panel-hint">
        回放会把方案、站房维护待办、巡检清单一起恢复到快照内容；重复回放同一快照只生效一次。
      </p>
      <table class="data-table">
        <thead>
          <tr>
            <th>快照编号</th>
            <th>快照时间</th>
            <th>留痕原因</th>
            <th>适用范围</th>
            <th>测次安排</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in snapshots" :key="item.id">
            <td>{{ item.id }}</td>
            <td>{{ item.takenAt }}</td>
            <td>{{ item.reason }}</td>
            <td>{{ item.plan['适用范围'] ?? '—' }}</td>
            <td>{{ item.plan['测次安排'] ?? '—' }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="replay(item)">回放</button>
            </td>
          </tr>
          <tr v-if="!snapshots.length">
            <td colspan="6" class="empty-state">该方案还没有留痕快照</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条测报方案记录</span>
      <span v-if="okMessage" class="ok-text">{{ okMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  adjustPlan,
  downloadEntries,
  listEntries,
  listPlanSnapshots,
  moduleMeta,
  replayPlanSnapshot,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow, PlanSnapshot } from '@/data/types'

const meta = moduleMeta('plan')
const columns = ["方案编号", "方案名称", "适用范围", "监测项目", "测次安排", "编制人", "批准人", "批准日期", "方案状态"]
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

// 调整草稿只放在组件内存里，不落盘；重新进入页面时 onMounted 会清空，不沿用旧草稿。
const editing = ref<EntryRow | null>(null)
const draft = ref({ 适用范围: '', 测次安排: '' })
const snapshotPlan = ref<EntryRow | null>(null)
const snapshots = ref<PlanSnapshot[]>([])

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
  showResult(applyAction(meta.key, Number(row.id), action))
}

function openEditor(row: EntryRow) {
  snapshotPlan.value = null
  editing.value = row
  draft.value = {
    适用范围: String(row['适用范围'] ?? ''),
    测次安排: String(row['测次安排'] ?? ''),
  }
}

function closeEditor() {
  editing.value = null
  draft.value = { 适用范围: '', 测次安排: '' }
}

function saveEdit() {
  if (!editing.value) {
    return
  }
  const result = adjustPlan(Number(editing.value.id), { ...draft.value })
  if (result.ok) {
    closeEditor()
  }
  showResult(result)
}

function openSnapshots(row: EntryRow) {
  closeEditor()
  snapshotPlan.value = row
  snapshots.value = listPlanSnapshots(Number(row.id))
}

function replay(item: PlanSnapshot) {
  const result = replayPlanSnapshot(item.id)
  if (result.ok && snapshotPlan.value) {
    snapshots.value = listPlanSnapshots(Number(snapshotPlan.value.id))
  }
  showResult(result)
}

function showResult(result: { ok: boolean; message: string }) {
  if (result.ok) {
    okMessage.value = result.message
    errorMessage.value = ''
    reload()
  } else {
    errorMessage.value = result.message
    okMessage.value = ''
  }
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '测报方案列表读取失败'
  }
}

onMounted(() => {
  // 重新进入页面不沿用旧草稿：编辑面板与快照面板都重置。
  closeEditor()
  snapshotPlan.value = null
  snapshots.value = []
  reload()
})
</script>
