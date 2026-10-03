import { MODULE_BY_KEY } from '@/data/modules'
import {
  ADJUST_REASON,
  APPROVE_REASON,
  INSPECTION_KEY,
  PLAN_KEY,
  STATIONHOUSE_KEY,
  derivedInspection,
  derivedMaintenance,
  linkedRows,
  nextSnapshotId,
  planCodeOf,
} from '@/data/plan-snapshots'
import {
  allRows,
  commit,
  listRows,
  planReplays,
  planSnapshots,
  resetRows,
} from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  PlanSnapshot,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function now(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 给某方案当前状态写一条留痕快照（方案行 + 关联的站房维护待办、巡检清单）。 */
function snapshotOf(planRow: EntryRow, reason: string): PlanSnapshot {
  const code = planCodeOf(planRow)
  return {
    id: nextSnapshotId(planSnapshots(), code),
    planId: Number(planRow.id),
    planCode: code,
    takenAt: now(),
    reason,
    plan: clone(planRow),
    stationhouse: linkedRows(listRows(STATIONHOUSE_KEY), code).map(clone),
    inspection: linkedRows(listRows(INSPECTION_KEY), code).map(clone),
  }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  // 批准测报方案时补批准日期，并把批准后的状态归档成快照。
  const extraSnapshots: PlanSnapshot[] = []
  if (key === PLAN_KEY && action === '批准方案') {
    updated['批准日期'] = now().slice(0, 10)
    extraSnapshots.push(snapshotOf(updated, APPROVE_REASON))
  }
  const next = [...rows]
  next[index] = updated
  try {
    commit({ entries: { [key]: next }, addSnapshots: extraSnapshots })
  } catch {
    return { ok: false, message: `${meta.entity}${action}写入失败，数据未改动` }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

/** 测报方案留痕快照归档，新的在前。 */
export function listPlanSnapshots(planId?: number): PlanSnapshot[] {
  const all = planSnapshots()
  const matched = planId === undefined ? all : all.filter((item) => item.planId === planId)
  return [...matched].reverse()
}

/**
 * 调整适用范围和测次安排：先把当前状态写入留痕快照，再应用调整，
 * 并自动合并关联的站房维护待办与巡检清单（已完工/已处置的不动）。
 * 三处一次落盘，任一写入失败都保持原状。
 */
export function adjustPlan(
  id: number,
  patch: { 适用范围?: string; 测次安排?: string },
): ActionResult {
  const rows = listRows(PLAN_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的测报方案` }
  }
  const current = rows[index]
  const scope = String(patch.适用范围 ?? '').trim()
  const schedule = String(patch.测次安排 ?? '').trim()
  if (!scope || !schedule) {
    return { ok: false, message: '适用范围和测次安排都不能为空' }
  }
  if (scope === String(current['适用范围'] ?? '') && schedule === String(current['测次安排'] ?? '')) {
    return { ok: false, message: '适用范围和测次安排都没有变化，未写入新快照' }
  }
  // 1) 调整前留痕
  const snapshot = snapshotOf(current, ADJUST_REASON)
  // 2) 应用调整：已批准/已修订的方案调整后记为「已修订」
  const status = ['已批准', '已修订'].includes(String(current.status))
    ? '已修订'
    : String(current.status)
  const updated: EntryRow = {
    ...current,
    '适用范围': scope,
    '测次安排': schedule,
    status,
    pending: true,
  }
  const nextPlans = [...rows]
  nextPlans[index] = updated
  // 3) 自动合并：同步跟测次安排走的待办与清单，已完工/已处置的保持不动
  const code = planCodeOf(current)
  const nextStationhouse = listRows(STATIONHOUSE_KEY).map((row) =>
    planCodeOf(row) === code && ['待安排', '已安排'].includes(String(row.status))
      ? { ...row, '维护内容': derivedMaintenance(schedule) }
      : row,
  )
  const nextInspection = listRows(INSPECTION_KEY).map((row) =>
    planCodeOf(row) === code && String(row.status) === '待巡检'
      ? { ...row, '检查项目': derivedInspection(schedule) }
      : row,
  )
  // 4) 方案、站房维护待办、巡检清单与快照一次落盘
  try {
    commit({
      entries: {
        [PLAN_KEY]: nextPlans,
        [STATIONHOUSE_KEY]: nextStationhouse,
        [INSPECTION_KEY]: nextInspection,
      },
      addSnapshots: [snapshot],
    })
  } catch {
    return { ok: false, message: '调整写入失败，方案、站房维护待办与巡检清单均未改动' }
  }
  return { ok: true, message: `测报方案已调整，调整前状态已写入留痕快照 ${snapshot.id}` }
}

/**
 * 按快照回放：方案、站房维护待办、巡检清单三处一起恢复到快照内容。
 * 人工回放与自动合并冲突时以人工回放为准（直接覆盖自动合并的产物）。
 * 重复回放同一快照只生效一次：现状已与快照一致时不再写入、不重复记台账。
 */
export function replayPlanSnapshot(snapshotId: string): ActionResult {
  const snapshot = planSnapshots().find((item) => item.id === snapshotId)
  if (!snapshot) {
    return { ok: false, message: `没有找到快照 ${snapshotId}` }
  }
  const plans = listRows(PLAN_KEY)
  const index = plans.findIndex((row) => Number(row.id) === snapshot.planId)
  if (index < 0) {
    return { ok: false, message: `快照 ${snapshotId} 对应的测报方案已不存在，无法回放` }
  }
  const code = snapshot.planCode
  const alreadyApplied =
    JSON.stringify(plans[index]) === JSON.stringify(snapshot.plan) &&
    JSON.stringify(linkedRows(listRows(STATIONHOUSE_KEY), code)) ===
      JSON.stringify(snapshot.stationhouse) &&
    JSON.stringify(linkedRows(listRows(INSPECTION_KEY), code)) ===
      JSON.stringify(snapshot.inspection)
  if (alreadyApplied) {
    return { ok: true, message: `快照 ${snapshotId} 的内容已经生效，重复回放不再写入` }
  }
  const nextPlans = [...plans]
  nextPlans[index] = clone(snapshot.plan)
  const keepStationhouse = listRows(STATIONHOUSE_KEY).filter((row) => planCodeOf(row) !== code)
  const keepInspection = listRows(INSPECTION_KEY).filter((row) => planCodeOf(row) !== code)
  try {
    commit({
      entries: {
        [PLAN_KEY]: nextPlans,
        [STATIONHOUSE_KEY]: [...keepStationhouse, ...snapshot.stationhouse.map(clone)],
        [INSPECTION_KEY]: [...keepInspection, ...snapshot.inspection.map(clone)],
      },
      addReplays: [{ snapshotId, planId: snapshot.planId, replayedAt: now() }],
    })
  } catch {
    return { ok: false, message: '回放写入失败，方案、站房维护待办与巡检清单保持原状' }
  }
  return { ok: true, message: `已按快照 ${snapshotId} 回放，方案、站房维护待办与巡检清单已同步恢复` }
}

/** 回放台账，新的在前。 */
export function listPlanReplays(planId?: number) {
  const all = planReplays()
  const matched = planId === undefined ? all : all.filter((item) => item.planId === planId)
  return [...matched].reverse()
}

/**
 * 其余页面的巡检清单核对方案快照：以方案现行内容（回放后即为快照内容）
 * 推导巡检清单应有的检查项目，逐条比对。
 */
export function checkInspectionRow(row: EntryRow): string {
  const code = planCodeOf(row)
  if (!code) {
    return '未关联方案'
  }
  const plan = listRows(PLAN_KEY).find((item) => planCodeOf(item) === code)
  if (!plan) {
    return '方案不存在'
  }
  const expected = derivedInspection(String(plan['测次安排'] ?? ''))
  return String(row['检查项目'] ?? '') === expected ? '与方案快照一致' : '与方案快照不一致'
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
