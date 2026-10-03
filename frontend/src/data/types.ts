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

/** 测报方案留痕快照：调整适用范围/测次安排前、批准归档时写入，误改后按它回放。 */
export type PlanSnapshot = {
  id: string
  planId: number
  planCode: string
  /** 快照时间；旧方案补录时按批准日期补全 */
  takenAt: string
  reason: string
  plan: EntryRow
  /** 快照时与方案关联的站房维护待办、巡检清单，回放时一并恢复 */
  stationhouse: EntryRow[]
  inspection: EntryRow[]
}

/** 回放台账：只登记真正生效的回放，重复回放同一快照不重复入账。 */
export type PlanReplay = {
  snapshotId: string
  planId: number
  replayedAt: string
}
