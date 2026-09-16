// pipeline_v2_lib 离线单元测试（无浏览器/无网络）：
// 覆盖：卡级粗筛（薪资/打码/去重/大厂/学历/实习）、详情细筛规则、hook 生成与 own 唯一性、台账派生更新。
// 跑法：node ~/.hermes/scripts/boss-apply/test_pipeline_v2.js
const assert = require('assert')
const os = require('os')
const fs = require('fs')
const path = require('path')
const v2 = require('../scripts/pipeline_v2_lib.js')

const { filterCards, cardSalaryVerdict, evalDetail, makeHook, updateLedgerFromCheckpoint } = v2
let n = 0
const ok = (name) => { n++; console.log('PASS', n, name) }

// ---- cardSalaryVerdict ----
assert.deepStrictEqual(cardSalaryVerdict('30-60K·15薪').keep, true)
assert.deepStrictEqual(cardSalaryVerdict('25-35K').keep, true)        // Max35>=30 过
assert.deepStrictEqual(cardSalaryVerdict('20-28K').keep, false)       // Max28<30 淘汰
assert.deepStrictEqual(cardSalaryVerdict('-K·薪').keep, true)         // 打码留细筛
assert.deepStrictEqual(cardSalaryVerdict('·薪').keep, true)           // 含薪特征无数字=打码，留细筛
// 2026-09-16 实测：BOSS 反爬把数字替换为 PUA 不可见字符，「-K·薪」textContent 即「-K·薪」无 ASCII 数字；
// 规则改为：含 K/薪/元 且无 ASCII 数字 → 打码保留。真正无薪资特征的串（空/乱文本）才淘汰。
assert.deepStrictEqual(cardSalaryVerdict('面议').keep, false)
assert.deepStrictEqual(cardSalaryVerdict('').keep, false)

// ---- filterCards ----
const cards = [
  { title: 'AI Agent开发', co: '轻舟智航', salary: '30-60K·15薪', tags: ['3-5年', '本科'], url: 'https://www.zhipin.com/job_detail/a1.html' },
  { title: 'AI工程师', co: '字节跳动', salary: '40-70K', tags: [], url: 'https://www.zhipin.com/job_detail/a2.html' },   // 大厂
  { title: 'AI工程师', co: '某Startup', salary: '20-25K', tags: [], url: 'https://www.zhipin.com/job_detail/a3.html' },   // 薪资低
  { title: 'AI工程师', co: '某Startup', salary: '30-50K', tags: [], url: 'https://www.zhipin.com/job_detail/a4.html' },   // 重复公司
  { title: 'AI实习', co: '实习生联盟', salary: '30-50K', tags: ['实习'], url: 'https://www.zhipin.com/job_detail/a5.html' }, // 实习
  { title: 'AI工程师', co: '硕博研究院', salary: '30-50K', tags: ['硕士'], url: 'https://www.zhipin.com/job_detail/a6.html' }, // 硕士（masked同时命中猎头规则，reason以猎头为准）
  { title: 'AI工程师', co: '已投公司', salary: '30-50K', tags: [], url: 'https://www.zhipin.com/job_detail/a7.html' },   // 台账已投
  { title: 'AI工程师', co: '打码公司', salary: '-K·薪', tags: [], url: 'https://www.zhipin.com/job_detail/a8.html' },   // 打码留细筛
]
const f1 = filterCards(cards, { appliedCos: ['已投公司'] })
assert.strictEqual(f1.keep.length, 3)
assert.strictEqual(f1.keep[0].co, '轻舟智航')
assert.strictEqual(f1.keep[1].co, '某Startup')   // 低薪卡被拒不拉黑公司，30-50K 卡保留
assert.strictEqual(f1.keep[2].co, '打码公司')
assert(filterCards([{title:'AI销售VP',co:'X',salary:'45-75K',tags:[],url:'https://www.zhipin.com/job_detail/z.html'}]).keep.length === 0)  // 销售岗
assert(filterCards([{title:'AI工程师',co:'深度求索',salary:'45-75K',tags:[],url:'https://www.zhipin.com/job_detail/z2.html'}]).keep.length === 0) // DeepSeek中文名
// 猎头挂单：默认过滤；excludeHeadhunter=false 放行
const hh = {title:'AI Agent工程师',co:'某大型互联网公司',salary:'40-70K',tags:[],url:'https://www.zhipin.com/job_detail/hh.html'}
assert(filterCards([hh]).keep.length === 0)                                       // 默认过滤
assert(filterCards([hh], {excludeHeadhunter:false}).keep.length === 1)            // 显式放行
const hh2 = {title:'AI Agent工程师',co:'北京某中型实时云渲染软件服务公司',salary:'40-70K',tags:[],url:'https://www.zhipin.com/job_detail/hh2.html'}
assert(filterCards([hh2]).keep.length === 0)                                      // 长前缀 masked 同样命中
assert(filterCards([{title:'AI工程师',co:'轻舟智航',salary:'30-60K',tags:[],url:'https://www.zhipin.com/job_detail/hh3.html'}]).keep.length === 1) // 正常公司名不受影响
assert(f1.reject.some(r => r.reason.includes('大厂')))
assert(f1.reject.some(r => r.reason.includes('薪资')))
assert(f1.reject.some(r => r.reason.includes('重复公司')))
assert(f1.reject.some(r => r.reason.includes('实习')))
assert(f1.reject.some(r => r.reason.includes('硕士')))
assert(f1.reject.some(r => r.reason.includes('已投')))
ok('filterCards 全规则')

// ---- evalDetail ----
assert.deepStrictEqual(evalDetail({}, 'AI Agent开发 30-60K·15薪', '负责AI Agent平台开发，Python/Java').pass, true)
assert.deepStrictEqual(evalDetail({}, '职位已关闭', 'xx').pass, false)
assert.deepStrictEqual(evalDetail({}, 'AI开发 20-28K', 'AI Agent 平台').pass, false)   // Max28<30
assert.deepStrictEqual(evalDetail({ title: '测试开发工程师' }, '测试 30-60K', 'AI测试平台 Python').pass, false)
assert.deepStrictEqual(evalDetail({}, '后端 30-60K', '精通 C++ 与底层引擎').pass, false)      // C++ 红线
assert.deepStrictEqual(evalDetail({}, '后端 30-60K', 'Python 为主，AI Agent 平台，了解 C++ 加分').pass, true) // 加分项不淘汰
assert.deepStrictEqual(evalDetail({}, '后端 30-60K', 'Java SpringBoot 微服务高并发架构').pass, false) // 无AI要素
ok('evalDetail 规则')

// ---- makeHook + own 唯一性 ----
const used = new Set()
const h1 = makeHook({ co: 'A公司' }, '需要 MCP 与工具链集成', used); used.add(h1.own)
const h2 = makeHook({ co: 'B公司' }, '需要 LangGraph 编排', used); used.add(h2.own)
assert.notStrictEqual(h1.own, h2.own)
assert(h1.hook.includes('MCP'))
assert(h2.hook.includes('LangChain') || h2.hook.includes('LangGraph'))
ok('makeHook 命中与 own 唯一')

// ---- updateLedgerFromCheckpoint（幂等） ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v2test-'))
const ledgerPath = path.join(tmp, 'ledger.json')
const ckPath = path.join(tmp, 'checkpoint.jsonl')
fs.writeFileSync(ledgerPath, JSON.stringify({ applied: [{ co: '老公司', date: '2026-09-01' }], eliminated: [] }))
fs.writeFileSync(ckPath, [
  JSON.stringify({ co: '新公司A', title: 'T', url: 'https://www.zhipin.com/job_detail/x1.html', status: 'OK', verify: { ok: true } }),
  JSON.stringify({ co: '新公司B', title: 'T', url: 'https://www.zhipin.com/job_detail/x2.html', status: 'OK', verify: { ok: false } }),
  JSON.stringify({ co: '老公司', title: 'T', url: 'https://www.zhipin.com/job_detail/x3.html', status: 'OK', verify: { ok: true } }),
].join('\n') + '\n')
const u1 = updateLedgerFromCheckpoint(ledgerPath, ckPath, '2026-09-16')
assert.strictEqual(u1.added, 1)   // 只有新公司A
assert.strictEqual(u1.total, 2)
const u2 = updateLedgerFromCheckpoint(ledgerPath, ckPath, '2026-09-16')
assert.strictEqual(u2.added, 0)   // 幂等
// eliminated 派生
const dtPath = path.join(tmp, 'details.jsonl')
fs.writeFileSync(dtPath, [
  JSON.stringify({ co: '淘汰公司X', decision: 'ELIMINATED', reason: 'Max 28K<30K' }),
  JSON.stringify({ co: '淘汰公司X', decision: 'ELIMINATED', reason: 'dup' }),
].join('\n') + '\n')
const u3 = updateLedgerFromCheckpoint(ledgerPath, ckPath, '2026-09-16', dtPath)
assert.strictEqual(u3.addedElim, 1)
const u4 = updateLedgerFromCheckpoint(ledgerPath, ckPath, '2026-09-16', dtPath)
assert.strictEqual(u4.addedElim, 0)  // 幂等
ok('updateLedgerFromCheckpoint 幂等 + eliminated 派生')

console.log('\nALL', n, 'ASSERTS PASSED')
