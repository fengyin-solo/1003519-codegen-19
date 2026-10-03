/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 一次留痕快照打包的三处内容：测报方案、站房维护待办、巡检清单。 */
export type SnapshotBundle = {
  plan: EntryRow
  stationhouse: EntryRow[]
  inspection: EntryRow[]
}

/** 测报方案留痕快照。调整前拍快照，误改后按它回放。 */
export type PlanSnapshot = {
  id: string
  planId: number
  planCode: string
  source: '调整前留痕' | '批准基线' | '旧数据补全'
  reason: string
  /** 快照时间；旧方案补全时取批准日期，无批准日期才用补录当天兜底。 */
  snapshotTime: string
  note?: string
  bundle: SnapshotBundle
  /** 人工回放成功后落标记：同一快照重复回放只生效一次。 */
  replayed?: { at: string; mode: 'manual' | 'auto-merge' }
}

/** 其余页面核对「巡检清单 vs 最新方案快照」的结果行。 */
export type SnapshotAuditItem = {
  planId: number
  planCode: string
  planName: string
  snapshotId: string
  snapshotTime: string
  total: number
  changed: { id: number; code: string; detail: string }[]
  missing: { id: number; code: string }[]
  added: number
  consistent: boolean
}
