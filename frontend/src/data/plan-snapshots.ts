import type { EntryRow, PlanSnapshot } from './types'

// 测报方案留痕快照的纯函数部分：不碰存储，方便迁移与回放逻辑复用。
export const PLAN_KEY = 'plan'
export const STATIONHOUSE_KEY = 'stationhouse'
export const INSPECTION_KEY = 'inspection'

/** 站房维护待办、巡检清单通过「方案编号」关联测报方案。 */
export const LINK_FIELD = '方案编号'
export const APPROVED_DATE_FIELD = '批准日期'

/** 旧方案连批准日期也缺失时，快照时间补全为这个迁移基准日。 */
export const BASELINE_FALLBACK_DATE = '2026-09-01'

export const ADJUST_REASON = '调整适用范围/测次安排前留痕'
export const APPROVE_REASON = '批准归档'
export const BASELINE_REASON_APPROVED = '旧方案补录留痕（按批准日期补全快照时间）'
export const BASELINE_REASON_FALLBACK = '旧方案补录留痕（批准日期缺失，按迁移基准日补全）'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function planCodeOf(row: EntryRow): string {
  return String(row[LINK_FIELD] ?? '')
}

export function linkedRows(rows: EntryRow[], planCode: string): EntryRow[] {
  return rows.filter((row) => planCodeOf(row) === planCode)
}

/** 站房维护待办、巡检清单跟随测次安排的派生文案，自动合并与核对都用同一口径。 */
export function derivedMaintenance(schedule: string): string {
  return `测次保障：${schedule}`
}

export function derivedInspection(schedule: string): string {
  return `测次检查：${schedule}`
}

export function nextSnapshotId(existing: PlanSnapshot[], planCode: string): string {
  const seq = existing.filter((item) => item.planCode === planCode).length + 1
  return `${planCode}-SNAP-${String(seq).padStart(3, '0')}`
}

/**
 * 旧方案迁移：还没有任何快照的方案补一条基线快照，
 * 快照时间按批准日期补全；批准日期缺失的按迁移基准日补全。
 */
export function buildBaselineSnapshots(
  entries: Record<string, EntryRow[]>,
  existing: PlanSnapshot[],
): PlanSnapshot[] {
  const plans = entries[PLAN_KEY] ?? []
  const covered = new Set(existing.map((item) => item.planId))
  const accumulated = [...existing]
  const baselines: PlanSnapshot[] = []
  for (const plan of plans) {
    const planId = Number(plan.id)
    if (covered.has(planId)) {
      continue
    }
    const code = planCodeOf(plan)
    const approvedAt = String(plan[APPROVED_DATE_FIELD] ?? '').trim()
    const snapshot: PlanSnapshot = {
      id: nextSnapshotId(accumulated, code),
      planId,
      planCode: code,
      takenAt: approvedAt || BASELINE_FALLBACK_DATE,
      reason: approvedAt ? BASELINE_REASON_APPROVED : BASELINE_REASON_FALLBACK,
      plan: clone(plan),
      stationhouse: linkedRows(entries[STATIONHOUSE_KEY] ?? [], code).map(clone),
      inspection: linkedRows(entries[INSPECTION_KEY] ?? [], code).map(clone),
    }
    accumulated.push(snapshot)
    baselines.push(snapshot)
  }
  return baselines
}
