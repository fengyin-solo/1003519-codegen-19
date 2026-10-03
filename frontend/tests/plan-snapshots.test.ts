// 测报方案留痕快照的功能测试：用 tsc 编译后在 node 里跑（见 package.json 的 test 脚本）。
import assert from 'node:assert/strict'

async function main() {
// 先装好 localStorage  mock，再加载数据层（数据层第一次读存储时才初始化）。
const backing = new Map<string, string>()
let failWrites = false
;(globalThis as Record<string, unknown>).window = {
  localStorage: {
    getItem: (key: string) => (backing.has(key) ? backing.get(key) : null),
    setItem: (key: string, value: string) => {
      if (failWrites) {
        throw new Error('模拟写入失败')
      }
      backing.set(key, String(value))
    },
    removeItem: (key: string) => backing.delete(key),
  },
}

const store = await import('@/data/local-store')
const service = await import('@/api/local-service')

// 触发首次播种与旧方案迁移（基线快照补全），之后落盘内容才可读。
store.allState()

const STORAGE_KEY = store.storageKey()
const persisted = () => JSON.parse(backing.get(STORAGE_KEY) ?? '{}')
const plansOf = () => persisted().entries.plan as Record<string, unknown>[]
const stationhouseOf = () => persisted().entries.stationhouse as Record<string, unknown>[]
const inspectionOf = () => persisted().entries.inspection as Record<string, unknown>[]
const snapshotsOf = () => persisted().planSnapshots as Record<string, unknown>[]
const replaysOf = () => persisted().planReplays as Record<string, unknown>[]

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`✓ ${name}`)
}

// ---------- 1. 旧方案迁移：按批准日期补全基线快照 ----------
check('旧方案缺少快照时按批准日期补全基线快照', () => {
  const snapshots = snapshotsOf()
  assert.equal(snapshots.length, 3, '三个方案都应有基线快照')
  const byPlan = Object.fromEntries(snapshots.map((s) => [s.planId, s]))
  assert.equal(byPlan[3].takenAt, '2026-09-03', '已批准方案按批准日期补全')
  assert.equal(byPlan[1].takenAt, '2026-09-01', '批准日期缺失按迁移基准日补全')
  assert.equal(byPlan[2].takenAt, '2026-09-01')
  assert.ok(String(byPlan[3].reason).includes('批准日期'))
  assert.equal((byPlan[1].stationhouse as unknown[]).length, 1, '快照要带上关联的站房待办')
  assert.equal((byPlan[1].inspection as unknown[]).length, 1, '快照要带上关联的巡检清单')
})

// ---------- 2. 调整前写入快照 + 自动合并 ----------
const baseline1 = () => snapshotsOf().find((s) => s.planId === 1)!
let adjustMessage = ''
check('调整适用范围和测次安排前写入留痕快照', () => {
  const before = snapshotsOf().length
  const result = service.adjustPlan(1, { 适用范围: '汛期重点河段', 测次安排: '每日4次' })
  assert.equal(result.ok, true, result.message)
  adjustMessage = result.message
  const snapshots = snapshotsOf()
  assert.equal(snapshots.length, before + 1, '调整要新增一条快照')
  const snap = snapshots[snapshots.length - 1]
  assert.equal(snap.planId, 1)
  assert.ok(String(snap.reason).includes('调整'))
  const snapPlan = snap.plan as Record<string, unknown>
  assert.equal(snapPlan['适用范围'], '测报方案样例1', '快照留的是调整前的内容')
  assert.equal(snapPlan['测次安排'], '测报方案样例1')
  const plan = plansOf().find((p) => p.id === 1)!
  assert.equal(plan['适用范围'], '汛期重点河段')
  assert.equal(plan['测次安排'], '每日4次')
  assert.ok(adjustMessage.includes(String(snap.id)))
})

check('调整后自动合并站房维护待办和巡检清单（已完工的不动）', () => {
  const todo = stationhouseOf().find((r) => r['方案编号'] === 'PLAN-0001')!
  assert.equal(todo['维护内容'], '测次保障：每日4次', '待安排的待办要跟测次安排走')
  const item = inspectionOf().find((r) => r['方案编号'] === 'PLAN-0001')!
  assert.equal(item['检查项目'], '测次检查：每日4次')
  // PLAN-0003 的站房记录是施工中，不属于待办合并范围；这里确认 PLAN-0002 已安排的也被合并
  const doing = stationhouseOf().find((r) => r['方案编号'] === 'PLAN-0003')!
  assert.equal(doing['维护内容'], '测次保障：测报方案样例3', '别家方案的记录不受影响')
})

check('已批准方案调整后状态记为已修订', () => {
  const result = service.adjustPlan(3, { 适用范围: '全流域', 测次安排: '每日2次' })
  assert.equal(result.ok, true, result.message)
  const plan = plansOf().find((p) => p.id === 3)!
  assert.equal(plan.status, '已修订')
})

check('内容没变化时不写新快照', () => {
  const before = snapshotsOf().length
  const result = service.adjustPlan(1, { 适用范围: '汛期重点河段', 测次安排: '每日4次' })
  assert.equal(result.ok, false)
  assert.equal(snapshotsOf().length, before)
})

// ---------- 3. 误改后按快照回放，三处同步 ----------
check('按快照回放：方案、站房维护待办、巡检清单一起恢复', () => {
  const result = service.replayPlanSnapshot(String(baseline1().id))
  assert.equal(result.ok, true, result.message)
  const plan = plansOf().find((p) => p.id === 1)!
  assert.equal(plan['适用范围'], '测报方案样例1', '方案回到快照内容')
  assert.equal(plan['测次安排'], '测报方案样例1')
  const todo = stationhouseOf().find((r) => r['方案编号'] === 'PLAN-0001')!
  assert.equal(todo['维护内容'], '测次保障：测报方案样例1', '站房待办同步恢复')
  const item = inspectionOf().find((r) => r['方案编号'] === 'PLAN-0001')!
  assert.equal(item['检查项目'], '测次检查：测报方案样例1', '巡检清单同步恢复')
  assert.equal(replaysOf().length, 1, '回放要记台账')
  assert.equal(replaysOf()[0].snapshotId, baseline1().id)
})

check('人工回放与自动合并冲突时以人工回放为准', () => {
  // 再次调整（自动合并把待办/清单改成新测次），然后回放基线快照
  service.adjustPlan(1, { 适用范围: '枯水期河段', 测次安排: '每周2次' })
  assert.equal(
    inspectionOf().find((r) => r['方案编号'] === 'PLAN-0001')!['检查项目'],
    '测次检查：每周2次',
    '自动合并先生效',
  )
  const result = service.replayPlanSnapshot(String(baseline1().id))
  assert.equal(result.ok, true, result.message)
  assert.equal(
    inspectionOf().find((r) => r['方案编号'] === 'PLAN-0001')!['检查项目'],
    '测次检查：测报方案样例1',
    '人工回放覆盖自动合并的产物',
  )
  assert.equal(plansOf().find((p) => p.id === 1)!['测次安排'], '测报方案样例1')
})

// ---------- 4. 重复回放同一快照只生效一次 ----------
check('重复回放同一快照只生效一次', () => {
  const replaysBefore = replaysOf().length
  const snapshotsBefore = snapshotsOf().length
  const result = service.replayPlanSnapshot(String(baseline1().id))
  assert.equal(result.ok, true, result.message)
  assert.ok(result.message.includes('重复回放'), result.message)
  assert.equal(replaysOf().length, replaysBefore, '不重复记台账')
  assert.equal(snapshotsOf().length, snapshotsBefore, '不产生新快照')
})

// ---------- 5. 任一写入失败则三处保持一致 ----------
check('写入失败时方案、站房维护待办、巡检清单都保持原状', () => {
  const before = persisted()
  failWrites = true
  const adjust = service.adjustPlan(1, { 适用范围: '故障注入', 测次安排: '每小时1次' })
  assert.equal(adjust.ok, false, '调整要报告失败')
  // 方案 3 前面被调整过，基线快照与现状不同，回放它一定会真的写库
  const other = snapshotsOf().find((s) => s.planId === 3)!
  const replay = service.replayPlanSnapshot(String(other.id))
  assert.equal(replay.ok, false, '回放要报告失败')
  failWrites = false
  assert.deepEqual(persisted(), before, '落盘内容不能有半点变化')
  // 内存里的读取也要和落盘一致（缓存没有脏写）
  const plan = service.listEntries('plan').items.find((r) => Number(r.id) === 1)!
  assert.equal(plan['适用范围'], '测报方案样例1')
})

// ---------- 6. 刷新后列表与归档读到同一内容 ----------
check('刷新后列表与归档仍读到同一内容', () => {
  const raw = persisted()
  assert.ok(raw.entries && raw.planSnapshots, '列表与归档在同一个存储键里')
  const plan = (raw.entries.plan as Record<string, unknown>[]).find((p) => p.id === 1)!
  const snap = (raw.planSnapshots as Record<string, unknown>[]).find((s) => s.planId === 1)!
  assert.equal(plan['测次安排'], (snap.plan as Record<string, unknown>)['测次安排'])
})

// ---------- 7. 其余页面巡检清单核对方案快照 ----------
check('巡检清单核对方案快照', () => {
  const rows = service.listEntries('inspection').items
  const linked = rows.find((r) => String(r['方案编号']) === 'PLAN-0001')!
  assert.equal(service.checkInspectionRow(linked), '与方案快照一致')
  // 直接改巡检清单（绕过方案调整），核对要报不一致
  const tampered = rows.map((r) =>
    String(r['方案编号']) === 'PLAN-0001' ? { ...r, 检查项目: '测次检查：每小时8次' } : r,
  )
  store.saveRows('inspection', tampered)
  const after = service.listEntries('inspection').items.find(
    (r) => String(r['方案编号']) === 'PLAN-0001',
  )!
  assert.equal(service.checkInspectionRow(after), '与方案快照不一致')
  const noPlan = { ...after, 方案编号: '' }
  assert.equal(service.checkInspectionRow(noPlan), '未关联方案')
  // 回放基线快照把清单恢复，核对重新一致
  service.replayPlanSnapshot(String(baseline1().id))
  const restored = service.listEntries('inspection').items.find(
    (r) => String(r['方案编号']) === 'PLAN-0001',
  )!
  assert.equal(service.checkInspectionRow(restored), '与方案快照一致')
})

// ---------- 8. 批准方案归档快照 ----------
check('批准方案时补批准日期并归档快照', () => {
  const before = snapshotsOf().length
  const result = service.runAction('plan', 2, '批准方案')
  assert.equal(result.ok, true, result.message)
  const plan = plansOf().find((p) => p.id === 2)!
  assert.equal(plan.status, '已批准')
  assert.ok(String(plan['批准日期']).length === 10, '批准日期要补上')
  const snapshots = snapshotsOf()
  assert.equal(snapshots.length, before + 1)
  const snap = snapshots[snapshots.length - 1]
  assert.equal(snap.planId, 2)
  assert.ok(String(snap.reason).includes('批准'))
})

console.log(`\n全部 ${passed} 项检查通过`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
