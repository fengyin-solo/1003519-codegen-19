import {
  PLAN_SNAPSHOT_CHANNEL,
  allRows,
  commitState,
  getChannel,
  listRows,
} from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  PlanSnapshot,
  SnapshotAuditItem,
  SnapshotBundle,
} from '@/data/types'

// 关联键：站房维护待办、巡检清单通过「方案编号」挂到测报方案上。
export const PLAN_CODE_FIELD = '方案编号'
const SCOPE_FIELD = '适用范围'
const SCHEDULE_FIELD = '测次安排'
const APPROVE_DATE_FIELD = '批准日期'
const PLAN_STATUS_FIELD = '方案状态'
const INSP_CODE_FIELD = '记录编号'

/**
 * 人工回放与自动合并冲突时的裁决原则（由系统固化，不让用户二选一）：
 * 人工回放是操作员明确纠错，按快照整体覆盖三处，且同一快照只生效一次；
 * 自动合并只「补缺」（补回被误删的待办/巡检项），绝不覆盖现有内容、绝不删除，
 * 因此自动合并永远无法顶替人工回放的结果——人工已回放的快照拒绝再次自动合并。
 */
export const CONFLICT_POLICY = '人工回放为准'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function todayText(): string {
  const now = new Date()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function nowText(): string {
  const now = new Date()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  const hour = `${now.getHours()}`.padStart(2, '0')
  const minute = `${now.getMinutes()}`.padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day} ${hour}:${minute}`
}

function padId(value: number): string {
  return `${value}`.padStart(4, '0')
}

function fail(error: unknown, fallback: string): ActionResult {
  const message = error instanceof Error && error.message ? error.message : fallback
  return {
    ok: false,
    message: `写入未成功，方案、站房维护待办与巡检清单保持原状：${message}`,
  }
}

function snapshotMap(): Record<string, PlanSnapshot> {
  return getChannel<Record<string, PlanSnapshot>>(PLAN_SNAPSHOT_CHANNEL) ?? {}
}

function linkedRows(rows: EntryRow[], planCode: string): EntryRow[] {
  return rows.filter((row) => String(row[PLAN_CODE_FIELD] ?? '') === planCode)
}

function buildBundle(plan: EntryRow): SnapshotBundle {
  const planCode = String(plan[PLAN_CODE_FIELD] ?? '')
  return {
    plan: clone(plan),
    stationhouse: clone(linkedRows(listRows('stationhouse'), planCode)),
    inspection: clone(linkedRows(listRows('inspection'), planCode)),
  }
}

function findPlan(planId: number): EntryRow | undefined {
  return listRows('plan').find((row) => Number(row.id) === planId)
}

function findApprovedSnapshot(
  map: Record<string, PlanSnapshot>,
  planId: number,
): PlanSnapshot | undefined {
  return Object.values(map)
    .filter((snap) => snap.planId === planId)
    .sort((a, b) => (a.snapshotTime < b.snapshotTime ? 1 : -1))[0]
}

// —— 旧方案补全：已批准方案缺快照时间的，按批准日期补全；再缺就用补录当天兜底 ——
let legacyEnsured = false

export function ensureLegacySnapshots(): void {
  if (legacyEnsured) {
    return
  }
  const plans = listRows('plan')
  // 在副本上补全，提交失败也不会污染内存缓存。
  const map = { ...snapshotMap() }
  let changed = false
  for (const plan of plans) {
    if (String(plan.status) !== '已批准') {
      continue
    }
    if (findApprovedSnapshot(map, Number(plan.id))) {
      continue
    }
    const approveDate = String(plan[APPROVE_DATE_FIELD] ?? '').trim()
    const backfill = approveDate || todayText()
    const snap: PlanSnapshot = {
      id: `SNAP-LEGACY-${plan.id}`,
      planId: Number(plan.id),
      planCode: String(plan[PLAN_CODE_FIELD] ?? padId(Number(plan.id))),
      source: '旧数据补全',
      reason: '旧方案缺少留痕快照，按批准日期补全',
      snapshotTime: backfill,
      note: approveDate
        ? '按批准日期补全的历史快照'
        : '原方案未登记批准日期，按补录当天补全，建议核实',
      bundle: buildBundle(plan),
    }
    map[snap.id] = snap
    changed = true
  }
  if (changed) {
    try {
      commitState({ ...allRows(), [PLAN_SNAPSHOT_CHANNEL]: map })
    } catch {
      // 补全落盘失败不阻断列表读取；不置标记，下次打开会重新尝试补全。
      return
    }
  }
  // 提交成功后才标记；提交抛错则下次还会重试，不会静默丢补全。
  legacyEnsured = true
}

function newSnapshotId(map: Record<string, PlanSnapshot>): string {
  let seq = Object.keys(map).length + 1
  let id = `SNAP-${`${Date.now()}`.slice(-8)}-${seq}`
  while (map[id]) {
    seq += 1
    id = `SNAP-${`${Date.now()}`.slice(-8)}-${seq}`
  }
  return id
}

function commitSnapshot(snap: PlanSnapshot): void {
  const map = { ...snapshotMap() }
  map[snap.id] = snap
  commitState({ ...allRows(), [PLAN_SNAPSHOT_CHANNEL]: map })
}

// 批准方案时顺手写一条批准基线快照（同样按批准日期留痕），之后无需再靠补全。
export function recordApprovalBaseline(plan: EntryRow): void {
  const map = snapshotMap()
  const planId = Number(plan.id)
  if (findApprovedSnapshot(map, planId)) {
    return
  }
  const approveDate = String(plan[APPROVE_DATE_FIELD] ?? '').trim() || todayText()
  commitSnapshot({
    id: newSnapshotId(map),
    planId,
    planCode: String(plan[PLAN_CODE_FIELD] ?? padId(planId)),
    source: '批准基线',
    reason: '方案批准时建立基线快照',
    snapshotTime: approveDate,
    bundle: buildBundle(plan),
  })
}

// 调整适用范围或测次安排前写入快照；两处都没改则不留痕、不保存。
export function adjustPlan(
  planId: number,
  patch: { scope?: string; schedule?: string },
): ActionResult {
  ensureLegacySnapshots()
  const plan = findPlan(planId)
  if (!plan) {
    return { ok: false, message: `没有找到编号为 ${planId} 的测报方案` }
  }
  const nextScope = (patch.scope ?? '').trim()
  const nextSchedule = (patch.schedule ?? '').trim()
  const scopeChanged =
    nextScope !== '' && nextScope !== String(plan[SCOPE_FIELD] ?? '')
  const scheduleChanged =
    nextSchedule !== '' && nextSchedule !== String(plan[SCHEDULE_FIELD] ?? '')
  if (!scopeChanged && !scheduleChanged) {
    return { ok: false, message: '适用范围与测次安排均未改动，无需调整留痕' }
  }

  // 先拍快照（改动前的三处内容），再落调整后的方案。
  const map = snapshotMap()
  const snap: PlanSnapshot = {
    id: newSnapshotId(map),
    planId,
    planCode: String(plan[PLAN_CODE_FIELD] ?? padId(planId)),
    source: '调整前留痕',
    reason: [scopeChanged ? '调整适用范围' : '', scheduleChanged ? '调整测次安排' : '']
      .filter(Boolean)
      .join('、') + '前留痕',
    snapshotTime: nowText(),
    bundle: buildBundle(plan),
  }

  const updated: EntryRow = { ...plan }
  if (scopeChanged) {
    updated[SCOPE_FIELD] = nextScope
  }
  if (scheduleChanged) {
    updated[SCHEDULE_FIELD] = nextSchedule
  }
  // 已批准方案再调整即进入「已修订」；其余状态不变。
  if (String(plan.status) === '已批准') {
    updated.status = '已修订'
    updated.pending = true
    updated[PLAN_STATUS_FIELD] = '已修订'
  }

  const plans = listRows('plan').map((row) =>
    Number(row.id) === planId ? updated : row,
  )
  const nextMap = { ...map, [snap.id]: snap }
  // 方案调整与快照留痕一次提交：快照没写成，方案也不会改动。
  try {
    commitState({ ...allRows(), plan: plans, [PLAN_SNAPSHOT_CHANNEL]: nextMap })
  } catch (error) {
    return fail(error, '快照或方案保存失败')
  }
  return {
    ok: true,
    message: `已在调整前写入快照（${snap.snapshotTime}），方案调整完成，可用该快照回放`,
  }
}

function replaceLinked(
  rows: EntryRow[],
  planCode: string,
  snapshotRows: EntryRow[],
): EntryRow[] {
  // 回放 = 全量恢复该方案关联的待办/巡检：移出现有关联项，再放回快照里的整批。
  const kept = rows.filter((row) => String(row[PLAN_CODE_FIELD] ?? '') !== planCode)
  return [...kept, ...clone(snapshotRows)]
}

function mergeMissing(rows: EntryRow[], snapshotRows: EntryRow[]): EntryRow[] {
  // 自动合并 = 只补缺：当前缺失的快照行插回，现有的一律不动（不覆盖、不删除）。
  const existingIds = new Set(rows.map((row) => Number(row.id)))
  const missing = snapshotRows.filter((row) => !existingIds.has(Number(row.id)))
  return [...rows, ...clone(missing)]
}

// 人工回放：按快照整体恢复方案、站房维护待办、巡检清单，三处一次提交。
export function replaySnapshot(snapshotId: string): ActionResult {
  ensureLegacySnapshots()
  const map = snapshotMap()
  const snap = map[snapshotId]
  if (!snap) {
    return { ok: false, message: '没有找到这份留痕快照' }
  }
  if (snap.replayed?.mode === 'manual') {
    return {
      ok: false,
      message: `该快照已于 ${snap.replayed.at} 人工回放，同一快照只生效一次，拒绝重复回放`,
    }
  }

  const planCode = snap.planCode
  const state = allRows()
  const plans = listRows('plan')
  const restoredPlan = clone(snap.bundle.plan)
  const planExists = plans.some((row) => Number(row.id) === snap.planId)
  const nextPlans = planExists
    ? plans.map((row) => (Number(row.id) === snap.planId ? restoredPlan : row))
    : [...plans, restoredPlan]
  const nextHouse = replaceLinked(
    listRows('stationhouse'),
    planCode,
    snap.bundle.stationhouse,
  )
  const nextInspection = replaceLinked(
    listRows('inspection'),
    planCode,
    snap.bundle.inspection,
  )

  const nextMap = clone(map)
  nextMap[snapshotId] = { ...snap, replayed: { at: nowText(), mode: 'manual' } }

  // 三处数据 + 回放标记单次提交；任一处未成功则整份根对象不落盘，三处保持一致。
  try {
    commitState({
      ...state,
      plan: nextPlans,
      stationhouse: nextHouse,
      inspection: nextInspection,
      [PLAN_SNAPSHOT_CHANNEL]: nextMap,
    })
  } catch (error) {
    return fail(error, '快照回放失败')
  }
  return {
    ok: true,
    message: `已按快照回放方案、站房维护待办与巡检清单（共 ${1 + snap.bundle.stationhouse.length + snap.bundle.inspection.length} 处记录）`,
  }
}

// 自动合并：只把被误删的关联待办/巡检项补回，方案与现有关联项都不改。
export function autoMergeSnapshot(snapshotId: string): ActionResult {
  ensureLegacySnapshots()
  const map = snapshotMap()
  const snap = map[snapshotId]
  if (!snap) {
    return { ok: false, message: '没有找到这份留痕快照' }
  }
  // 冲突裁决：人工回放优先，自动合并不能顶替人工结果。
  if (snap.replayed?.mode === 'manual') {
    return {
      ok: false,
      message: `该快照已按「${CONFLICT_POLICY}」人工回放并定版，自动合并只补缺，不再处理`,
    }
  }

  const nextHouse = mergeMissing(listRows('stationhouse'), snap.bundle.stationhouse)
  const nextInspection = mergeMissing(listRows('inspection'), snap.bundle.inspection)
  try {
    commitState({
      ...allRows(),
      stationhouse: nextHouse,
      inspection: nextInspection,
    })
  } catch (error) {
    return fail(error, '自动合并写入失败')
  }
  return {
    ok: true,
    message: `自动合并已补回缺失的站房维护待办与巡检项；现有内容一律未改动。若与人工回放冲突，以人工回放为准`,
  }
}

export function listSnapshots(planId?: number): PlanSnapshot[] {
  ensureLegacySnapshots()
  const all = Object.values(snapshotMap())
  return all
    .filter((snap) => planId === undefined || snap.planId === planId)
    .sort((a, b) => (a.snapshotTime < b.snapshotTime ? 1 : -1))
}

// —— 其余页面核对：巡检清单是否与最新方案快照一致 ——
function stableStringify(row: EntryRow): string {
  const keys = Object.keys(row).sort()
  return JSON.stringify(keys.map((key) => [key, row[key]]))
}

function diffDetail(current: EntryRow, snapshot: EntryRow): string {
  const keys = new Set([...Object.keys(current), ...Object.keys(snapshot)])
  const fields: string[] = []
  for (const key of keys) {
    if (key === 'status' || key === 'pending' || key === 'abnormal') {
      continue
    }
    if (String(current[key] ?? '') !== String(snapshot[key] ?? '')) {
      fields.push(key)
    }
  }
  const statusChanged = String(current.status) !== String(snapshot.status)
  return [...fields, ...(statusChanged ? ['状态'] : [])].join('、') || '内容'
}

export function auditInspectionAgainstSnapshots(): SnapshotAuditItem[] {
  ensureLegacySnapshots()
  const inspection = listRows('inspection')
  // listSnapshots 已按快照时间倒序，每个方案第一张即最新快照，只核对它。
  const seenPlans = new Set<number>()
  const latest = listSnapshots().filter((snap) => {
    if (seenPlans.has(snap.planId)) {
      return false
    }
    seenPlans.add(snap.planId)
    return true
  })
  return latest.map((snap) => {
      const currentRows = linkedRows(inspection, snap.planCode)
      const currentById = new Map(currentRows.map((row) => [Number(row.id), row]))
      const changed: SnapshotAuditItem['changed'] = []
      const missing: SnapshotAuditItem['missing'] = []
      for (const stored of snap.bundle.inspection) {
        const current = currentById.get(Number(stored.id))
        if (!current) {
          missing.push({ id: Number(stored.id), code: String(stored[INSP_CODE_FIELD] ?? '') })
        } else if (stableStringify(current) !== stableStringify(stored)) {
          changed.push({
            id: Number(current.id),
            code: String(current[INSP_CODE_FIELD] ?? ''),
            detail: diffDetail(current, stored),
          })
        }
      }
      const storedIds = new Set(snap.bundle.inspection.map((row) => Number(row.id)))
      const added = currentRows.filter((row) => !storedIds.has(Number(row.id))).length
      return {
        planId: snap.planId,
        planCode: snap.planCode,
        planName: String(snap.bundle.plan['方案名称'] ?? ''),
        snapshotId: snap.id,
        snapshotTime: snap.snapshotTime,
        total: snap.bundle.inspection.length,
        changed,
        missing,
        added,
        consistent: changed.length === 0 && missing.length === 0,
      }
    })
}
