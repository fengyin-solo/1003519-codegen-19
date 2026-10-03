<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">重新统计</button>
      </div>
    </header>
    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>
    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>今日新增</th><th>待处理</th><th>异常量</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in moduleRows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td>{{ row.pending }}</td>
          <td>{{ row.abnormal }}</td>
        </tr>
      </tbody>
    </table>

    <h3 class="audit-title">巡检清单按测报方案快照核对</h3>
    <table class="data-table">
      <thead>
        <tr><th>方案编号</th><th>最新快照时间</th><th>被修改</th><th>已缺失</th><th>额外新增</th><th>核对结论</th></tr>
      </thead>
      <tbody>
        <tr v-for="item in auditItems" :key="item.planId">
          <td>{{ item.planCode }} {{ item.planName }}</td>
          <td>{{ item.snapshotTime }}</td>
          <td :class="item.changed.length ? 'audit-bad' : ''">{{ item.changed.length }}</td>
          <td :class="item.missing.length ? 'audit-bad' : ''">{{ item.missing.length }}</td>
          <td>{{ item.added }}</td>
          <td>
            <span class="badge" :class="item.consistent ? 'badge-ok' : 'badge-bad'">
              {{ item.consistent ? '与快照一致' : '与快照不符' }}
            </span>
          </td>
        </tr>
        <tr v-if="!auditItems.length">
          <td colspan="6" class="empty-state">暂无已留痕的测报方案</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { loadOverview } from '@/api/local-service'
import { auditInspectionAgainstSnapshots } from '@/api/plan-snapshot'
import type { OverviewResult, SnapshotAuditItem } from '@/data/types'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])
const auditItems = ref<SnapshotAuditItem[]>([])

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
  auditItems.value = auditInspectionAgainstSnapshots()
}

onMounted(refresh)
</script>

<style scoped>
.audit-title { font-size: 14px; margin: 18px 0 8px; }
.audit-bad { color: #b42318; font-weight: 600; }
.badge { border-radius: 999px; padding: 2px 8px; font-size: 12px; white-space: nowrap; }
.badge-ok { background: #dcfce7; color: #15803d; }
.badge-bad { background: #fee4e2; color: #b42318; }
</style>
