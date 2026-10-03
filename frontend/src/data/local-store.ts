import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydrology-monitor-station:entries'
// 留痕快照与业务数据共用同一个根对象，保证「列表」和「归档」刷新后读到同一份内容。
export const PLAN_SNAPSHOT_CHANNEL = '__plan_snapshots__'

type StoredState = Record<string, unknown>

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function seedState(): StoredState {
  return clone(SEED_ROWS) as StoredState
}

// 兼容旧版本：以前 localStorage 里只存各业务模块数组，遇到旧结构直接当模块数据使用。
function readStorage(): StoredState {
  const fallback = seedState()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as StoredState
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: StoredState | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache as Record<string, EntryRow[]>
}

export function listRows(key: string): EntryRow[] {
  return (allRows()[key] as EntryRow[] | undefined) ?? []
}

// 单次 setItem 提交整个根对象。调用方先在内存里组装好 nextState，
// 任一处写入未成功（如配额超限抛错）都不会触碰 cache，三处数据保持原状。
export function commitState(nextState: StoredState): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    // 先序列化：序列化或落盘抛错都在 cache 更新之前发生。
    const serialized = JSON.stringify(nextState)
    window.localStorage.setItem(STORAGE_KEY, serialized)
  }
  cache = nextState
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commitState({ ...allRows(), [key]: rows })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

// 非模块通道（快照等）与模块数据共用同一个根对象，刷新后仍读到同一内容。
export function getChannel<T>(key: string): T | undefined {
  return allRows()[key] as T | undefined
}

export function storageKey(): string {
  return STORAGE_KEY
}
