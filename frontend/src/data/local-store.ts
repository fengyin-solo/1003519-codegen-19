import { buildBaselineSnapshots } from './plan-snapshots'
import { SEED_ROWS } from './seed'
import type { EntryRow, PlanReplay, PlanSnapshot } from './types'

// 本地持久化：方案列表、快照归档、回放台账放在同一个 localStorage 键里，
// 每次写入都是整份状态一次落盘——刷新后列表与归档读到同一内容，
// 任一写入失败则三处（方案、站房维护待办、巡检清单）都保持原状。
const STORAGE_KEY = 'hydrology-monitor-station:entries'

export type PersistedState = {
  entries: Record<string, EntryRow[]>
  planSnapshots: PlanSnapshot[]
  planReplays: PlanReplay[]
}

export type CommitUpdate = {
  entries?: Record<string, EntryRow[]>
  addSnapshots?: PlanSnapshot[]
  addReplays?: PlanReplay[]
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function defaultState(): PersistedState {
  return { entries: clone(SEED_ROWS), planSnapshots: [], planReplays: [] }
}

function normalize(parsed: unknown): PersistedState {
  // 兼容旧格式：旧版整个对象就是 entries 表，没有快照与台账。
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const raw = parsed as Record<string, unknown>
    const looksNew = raw.entries && typeof raw.entries === 'object' && !Array.isArray(raw.entries)
    const entries = (looksNew ? raw.entries : raw) as Record<string, EntryRow[]>
    return {
      entries: { ...clone(SEED_ROWS), ...entries },
      planSnapshots: looksNew && Array.isArray(raw.planSnapshots) ? (raw.planSnapshots as PlanSnapshot[]) : [],
      planReplays: looksNew && Array.isArray(raw.planReplays) ? (raw.planReplays as PlanReplay[]) : [],
    }
  }
  return defaultState()
}

function migrate(state: PersistedState): { state: PersistedState; changed: boolean } {
  // 旧方案缺少快照：按批准日期补全基线快照，保证列表与归档同源。
  const baselines = buildBaselineSnapshots(state.entries, state.planSnapshots)
  if (baselines.length === 0) {
    return { state, changed: false }
  }
  return { state: { ...state, planSnapshots: [...state.planSnapshots, ...baselines] }, changed: true }
}

function persist(state: PersistedState): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

function readStorage(): PersistedState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return migrate(defaultState()).state
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = migrate(defaultState()).state
    persist(seeded)
    return seeded
  }
  try {
    const migrated = migrate(normalize(JSON.parse(raw)))
    if (migrated.changed) {
      persist(migrated.state)
    }
    return migrated.state
  } catch {
    const seeded = migrate(defaultState()).state
    persist(seeded)
    return seeded
  }
}

let cache: PersistedState | null = null

export function allState(): PersistedState {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

/**
 * 唯一的写入入口：先整份落盘，成功后才更新内存缓存。
 * localStorage 写失败（如配额超限）时抛错，缓存不动，三处数据保持一致。
 */
export function commit(update: CommitUpdate): void {
  const current = allState()
  const next: PersistedState = {
    entries: { ...current.entries, ...(update.entries ?? {}) },
    planSnapshots: [...current.planSnapshots, ...(update.addSnapshots ?? [])],
    planReplays: [...current.planReplays, ...(update.addReplays ?? [])],
  }
  persist(next)
  cache = next
}

export function allRows(): Record<string, EntryRow[]> {
  return allState().entries
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commit({ entries: { [key]: rows } })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function planSnapshots(): PlanSnapshot[] {
  return allState().planSnapshots
}

export function planReplays(): PlanReplay[] {
  return allState().planReplays
}

export function storageKey(): string {
  return STORAGE_KEY
}
