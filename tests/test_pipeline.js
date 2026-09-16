// pipeline 离线单元测试（无浏览器/无网络）：
// 覆盖：卡级粗筛（薪资/打码/去重/大厂/学历/实习）、详情细筛规则、hook 生成与 own 唯一性、台账派生更新。
// 跑法：node tests/test_pipeline.js
const assert = require('assert')
const os = require('os')
const fs = require('fs')
const path = require('path')
const pipeline = require('../scripts/pipeline.js')
const { loadProfile, normalizeProfile, salaryCodesFor, validateProfile, EXAMPLE_PATH } = require('../scripts/profile.js')

const { filterCards, cardSalaryVerdict, evalDetail, makeHook, ownOf, updateLedgerFromCheckpoint, makePipeline, decodeSalaryFont, listUrl } = pipeline
// 测试用 profile：模板身份 + 本文件需要的黑名单/hook
const profile = loadProfile(EXAMPLE_PATH)
profile.rules.blockCompanies = ['字节跳动', '深度求索']
profile.hooks = [
  { keywords: ['MCP'], text: '日常在深度使用和改造 MCP 生态，对工具链集成有第一手实践' },
  { keywords: ['LangGraph', 'LangChain'], text: '有 LangChain/LangGraph 工作流编排的实战经验' },
  { keywords: ['Java'], text: 'Java 老兵出身，近三年转 AI 应用架构' },
]
const rules = profile.rules
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
  { title: 'AI工程师', co: '轻舟智航科技', salary: '30-50K', tags: [], url: 'https://www.zhipin.com/job_detail/a9.html' }, // 本批重复（子串）
  { title: 'AI工程师', co: '北京喜马拉雅科技', salary: '30-50K', tags: [], url: 'https://www.zhipin.com/job_detail/a10.html' }, // 台账「京喜」不能误杀
  { title: 'AI工程师', co: '硕优公司', salary: '30-50K', tags: ['硕士优先'], url: 'https://www.zhipin.com/job_detail/a11.html' }, // 硕士优先豁免
  { title: 'AI储备干部', co: '储备公司', salary: '30-50K', tags: [], url: 'https://www.zhipin.com/job_detail/a12.html' }, // 拒因要写对
  { title: 'AI标注', co: '兼职公司', salary: '-元/时', tags: [], url: 'https://www.zhipin.com/job_detail/a13.html' }, // 时薪岗
]
const f1 = filterCards(cards, { rules, appliedCos: ['已投公司', '京喜'] })
assert.deepStrictEqual(f1.keep.map(k => k.co), ['轻舟智航', '某Startup', '打码公司', '北京喜马拉雅科技', '硕优公司'])  // 某Startup：低薪卡被拒不拉黑公司，30-50K 卡保留
const reasonOf = (co) => f1.reject.find(r => r.co === co).reason
assert.strictEqual(reasonOf('轻舟智航科技'), '本批重复公司')
assert.strictEqual(reasonOf('储备公司'), '储备/管培岗')
assert.strictEqual(reasonOf('兼职公司'), '时薪/日薪岗')
assert.strictEqual(reasonOf('已投公司'), '台账已投')
assert(filterCards([{title:'AI销售VP',co:'X',salary:'45-75K',tags:[],url:'https://www.zhipin.com/job_detail/z.html'}]).keep.length === 0)  // 销售岗（默认规则）
assert(filterCards([{title:'AI工程师',co:'深度求索',salary:'45-75K',tags:[],url:'https://www.zhipin.com/job_detail/z2.html'}], { rules }).keep.length === 0) // 黑名单
assert(filterCards([{title:'AI工程师',co:'深度求索',salary:'45-75K',tags:[],url:'https://www.zhipin.com/job_detail/z2.html'}]).keep.length === 1) // 默认黑名单为空
// 猎头挂单：默认过滤；excludeHeadhunter=false 放行
const hh = {title:'AI Agent工程师',co:'某大型互联网公司',salary:'40-70K',tags:[],url:'https://www.zhipin.com/job_detail/hh.html'}
assert(filterCards([hh]).keep.length === 0)                                       // 默认过滤
assert(filterCards([hh], { rules: { headhunter: 'allow' } }).keep.length === 1)   // 显式放行
const hh2 = {title:'AI Agent工程师',co:'北京某中型实时云渲染软件服务公司',salary:'40-70K',tags:[],url:'https://www.zhipin.com/job_detail/hh2.html'}
assert(filterCards([hh2]).keep.length === 0)                                      // 长前缀 masked 同样命中
assert(filterCards([{title:'AI工程师',co:'轻舟智航',salary:'30-60K',tags:[],url:'https://www.zhipin.com/job_detail/hh3.html'}]).keep.length === 1) // 正常公司名不受影响
assert(f1.reject.some(r => r.reason.includes('黑名单')))
assert(f1.reject.some(r => r.reason.includes('薪资')))
assert(f1.reject.some(r => r.reason.includes('实习')))
assert(f1.reject.some(r => r.reason.includes('学历要求 硕士/博士')))
ok('filterCards 全规则')

// ---- evalDetail ----
assert.deepStrictEqual(evalDetail({}, 'AI Agent开发 30-60K·15薪', '负责AI Agent平台开发，Python/Java').pass, true)
assert.deepStrictEqual(evalDetail({}, '职位已关闭', 'xx').pass, false)
assert.deepStrictEqual(evalDetail({}, 'AI开发 20-28K', 'AI Agent 平台').pass, false)   // Max28<30
assert.deepStrictEqual(evalDetail({ title: '测试开发工程师' }, '测试 30-60K', 'AI测试平台 Python', rules).pass, false)   // example profile 追加了测试岗
assert.deepStrictEqual(evalDetail({ title: '测试开发工程师' }, '测试 30-60K', 'AI测试平台 Python').pass, true)           // 默认不拦
assert.deepStrictEqual(evalDetail({}, '后端 30-60K', '精通 C++ 与底层引擎').pass, false)      // C++ 红线
assert.deepStrictEqual(evalDetail({}, '后端 30-60K', 'Python 为主，AI Agent 平台，了解 C++ 加分').pass, true) // 加分项不淘汰
assert.deepStrictEqual(evalDetail({}, '后端 30-60K', 'Java SpringBoot 微服务高并发架构').pass, false) // 无AI要素
assert.deepStrictEqual(evalDetail({}, '后端 30-60K', 'Java SpringBoot 微服务高并发架构', { mustHaveKeywords: [] }).pass, true) // 不限关键词
ok('evalDetail 规则')

// ---- 2026-09-16 review 回归：正则误判 ----
assert.strictEqual(evalDetail({}, 'AI 30-60K', '负责 AI Agent，部署在 Google Cloud').pass, true)            // Go 不能命中 Google
assert.strictEqual(evalDetail({}, '后端 30-60K', '要求 Golang 服务端开发').reason, '主语言要求 Go')
assert.strictEqual(evalDetail({}, '后端 30-60K', '精通 Rust 网络编程').reason, '主语言要求 Rust')
assert.strictEqual(evalDetail({}, '后端 30-60K', 'AI Agent 平台，Trust & Safety').pass, true)                  // Rust 不能命中 Trust
assert.strictEqual(evalDetail({}, '后端 30-60K', '精通PHP，负责核心开发。有AI Agent经验优先').reason, '主语言要求 PHP') // 豁免只看本句
assert.strictEqual(evalDetail({}, '后端 30-60K', '精通 Go 者优先，AI Agent 平台').pass, true)                   // 本句豁免
assert.strictEqual(evalDetail({}, '后端 30-60K', 'Java 微服务, maintain legacy system, email 通知').reason, 'JD 未命中必含关键词') // ai 不能命中 maintain
assert.strictEqual(evalDetail({}, '后端 30-60K', '构建 Agentic 系统').pass, true)
assert.strictEqual(evalDetail({}, 'AI工程师 30K-60K', 'AI Agent').pass, true)                                   // 30K-60K 格式
assert.strictEqual(evalDetail({}, 'AI工程师 薪资面议', 'AI Agent').reason, '薪资面议')
assert.strictEqual(evalDetail({}, '职位已关闭', 'x').toLedger, false)                                           // 岗位级淘汰不进台账
assert.strictEqual(evalDetail({}, 'AI开发 20-28K', 'AI Agent').toLedger, true)
ok('evalDetail review 回归（Go/Google、豁免范围、AI 边界、薪资格式、toLedger）')
// 外包：其余规则全过 → review；本身就不过的 → 正常淘汰
const oc = evalDetail({ co: '某人力资源服务', title: 'AI Agent 工程师' }, 'AI 30-60K', 'AI Agent 平台，驻场客户现场')
assert.strictEqual(oc.pass, false); assert.strictEqual(oc.review, true); assert.strictEqual(oc.toLedger, false)
assert.strictEqual(evalDetail({ co: 'X', title: 'AI外包工程师' }, 'AI 20-25K', 'AI Agent').review, undefined)
assert.strictEqual(evalDetail({ co: '某人力资源服务', title: 'AI Agent 工程师' }, 'AI 30-60K', 'AI Agent 平台，驻场', { outsourcing: 'reject' }).reason, '外包岗位')
assert.strictEqual(evalDetail({ co: '某人力资源服务', title: 'AI Agent 工程师' }, 'AI 30-60K', 'AI Agent 平台，驻场', { outsourcing: 'allow' }).pass, true)
ok('外包岗 → review 不淘汰 / reject / allow')
assert.strictEqual(evalDetail({}, 'AI 30-60K 硕士优先', 'AI Agent').pass, true)
assert.strictEqual(evalDetail({}, 'AI 30-60K 硕士', 'AI Agent').reason, '学历要求 硕士/博士')
ok('详情页 硕士优先 豁免')

// ---- sameCompany / kwHit ----
const { sameCompany, kwHit } = pipeline
assert.strictEqual(sameCompany('万联易达', '北京万联易达互联科技'), true)
assert.strictEqual(sameCompany('京喜', '北京喜马拉雅科技'), false)   // 短名只认全等
assert.strictEqual(sameCompany('京喜', '京 喜'), true)
assert.strictEqual(sameCompany('北京中科星图维天...', '北京中科星图维天信息'), true)
assert.strictEqual(kwHit('熟悉 JavaScript', 'Java'), false)
assert.strictEqual(kwHit('熟悉 Java 与 Spring', 'Java'), true)
assert.strictEqual(kwHit('WebSocket 推送', 'Web'), false)
assert.strictEqual(kwHit('多 Agents 协作', 'Agent'), true)
assert.strictEqual(kwHit('encoding 处理', 'coding'), false)
assert.strictEqual(kwHit('Fine-tuning 经验', 'fine-tuning'), true)
assert(!makeHook({ co: 'x' }, '熟悉 JavaScript 与 Node，AI Agent', profile).hook.includes('Java 老兵'))
ok('sameCompany 短名保护 + kwHit 整词')

// ---- 卡级新增：岗位类型 / 标题语言 / 无「某」猎头 ----
const card = (co, title) => ({ title, co, salary: '30-50K', tags: [], url: 'https://www.zhipin.com/job_detail/' + Math.random().toString(36).slice(2) + '.html' })
const rs = (co, title) => filterCards([card(co, title)], { rules }).reject.map(r => r.reason)[0]
assert.strictEqual(rs('A', 'AI Agent 产品经理'), '岗位类型不匹配')
assert.strictEqual(rs('A', 'AI大模型测试平台开发工程师'), '岗位类型不匹配')
assert.strictEqual(rs('A', 'Agent 爬虫后端开发（Go）'), '标题主语言 Go/C++/Rust/PHP/C#')
assert.strictEqual(rs('A', 'AI Agent 工程师（Java 方向）'), undefined)   // Java 不拦
assert.strictEqual(rs('知名公司', 'AI 工程师'), '猎头挂单(默认过滤)')
assert.strictEqual(rs('北京锐仕方达铂鸿人力', 'AI 工程师'), '猎头挂单(默认过滤)')
assert.strictEqual(rs('神舟人力', 'AI 工程师'), '猎头挂单(默认过滤)')
assert.strictEqual(rs('德勤', 'AI 工程师'), undefined)
assert.strictEqual(evalDetail({ title: 'AI 讲师' }, 'AI 30-60K', 'AI Agent', rules).reason, '岗位类型不匹配:AI 讲师')
ok('卡级岗位类型/标题语言/无某猎头')

// ---- makeHook：按优先级取第一个命中；同一 hook 可被多岗复用（不再要求跨岗唯一）----
const h1 = makeHook({ co: 'A公司' }, '需要 MCP 与工具链集成', profile)
const h2 = makeHook({ co: 'B公司' }, '需要 LangGraph 编排', profile)
assert(h1.hook.includes('MCP'))
assert(h2.hook.includes('LangChain') || h2.hook.includes('LangGraph'))
assert.strictEqual(makeHook({ co: 'C公司' }, '也要 MCP', profile).hook, h1.hook)   // 第 N 岗照样拿到最匹配的 hook
ok('makeHook 命中 + 可复用')
// 兜底 own 必须含公司名，不同公司不撞；own ⊂ hook
const fa = makeHook({ co: '甲公司' }, '无关键词', profile), fb = makeHook({ co: '乙公司' }, '无关键词', profile)
assert.notStrictEqual(fa.own, fb.own)
assert(fa.hook.includes(fa.own) && fb.hook.includes(fb.own))
assert.strictEqual(fa.hook, '仔细读过贵司 JD，与我的经验高度匹配（甲公司岗）')
// hooks 为空 → 全走兜底
assert(makeHook({ co: '丙' }, 'MCP', { ...profile, hooks: [] }).hook.includes('丙岗'))
assert.strictEqual(ownOf('日常在深度使用和改造 MCP 生态，对工具链集成有第一手实践'), '在深度使用和改造 M')
ok('makeHook 兜底 own 独一 + ownOf 统一')

// ---- 反爬字体解码 + 服务端筛选 URL ----
const PUA = (digits) => [...digits].map(d => String.fromCodePoint(0xE031 + Number(d))).join('')
assert.strictEqual(decodeSalaryFont(PUA('30') + '-' + PUA('50') + 'K·' + PUA('15') + '薪'), '30-50K·15薪')
assert.strictEqual(decodeSalaryFont('面议'), '面议')
const lowCard = { title: 'AI Agent', co: '低薪打码', salary: PUA('15') + '-' + PUA('25') + 'K', tags: [], url: 'https://www.zhipin.com/job_detail/p1.html' }
assert.strictEqual(filterCards([lowCard]).keep.length, 1)                          // 不解码：打码留细筛
assert.strictEqual(filterCards([lowCard], { decodeSalary: true }).keep.length, 0)  // 解码后卡级直接淘汰
assert.strictEqual(filterCards([lowCard], { decodeSalary: true }).reject[0].reason, '卡片薪资Max 25K<30K')
const okCard = { ...lowCard, co: '高薪打码', salary: PUA('30') + '-' + PUA('60') + 'K' }
assert.strictEqual(filterCards([okCard], { decodeSalary: true }).keep[0].salary, '30-60K')     // shortlist 里存解码后的
assert.strictEqual(listUrl('AI Agent'), 'https://www.zhipin.com/web/geek/jobs?city=101010100&query=AI%20Agent&salary=406,407&experience=105,106,107')
assert.strictEqual(listUrl('x', { city: '101020100', salaryCodes: [407], experienceCodes: [] }), 'https://www.zhipin.com/web/geek/jobs?city=101020100&query=x&salary=407')
ok('decodeSalaryFont + listUrl')

// ---- profile：默认合并 / 薪资码派生 / 校验 ----
assert.deepStrictEqual(salaryCodesFor(30), [406, 407])
assert.deepStrictEqual(salaryCodesFor(15), [405, 406, 407])
assert.deepStrictEqual(salaryCodesFor(0), [])
const np = normalizeProfile({ candidate: { intro: 'x', links: [{ label: 'G', url: 'https://g.com/a' }] }, rules: { minSalaryK: 15, blockCompanies: ['甲'] } })
assert.deepStrictEqual(np.search.salaryCodes, [405, 406, 407])
assert.strictEqual(np.rules.headhunter, 'reject')                 // 默认值补齐
assert.strictEqual(np.rules.allRejectTitles.length, 4)                // 固定 4 条
const np2 = normalizeProfile({ ...np, rules: { ...np.rules, extraRejectTitles: [{ pattern: '数据分析', reason: '数据分析岗' }] } })
assert.strictEqual(np2.rules.allRejectTitles.length, 5)               // 追加不覆盖
assert.strictEqual(filterCards([{ title: 'AI数据分析师', co: 'A', salary: '30-50K', tags: [], url: 'https://www.zhipin.com/job_detail/t1.html' }], { rules: np2.rules }).reject[0].reason, '数据分析岗')
assert.strictEqual(filterCards([{ title: 'AI实习生', co: 'A', salary: '30-50K', tags: [], url: 'https://www.zhipin.com/job_detail/t2.html' }], { rules: np2.rules }).reject[0].reason, '实习/校招/应届')  // 基础条仍在
assert.strictEqual(filterCards([{ title: 'AI 产品经理', co: 'A', salary: '30-50K', tags: [], url: 'https://www.zhipin.com/job_detail/t3.html' }], { rules: np2.rules }).keep.length, 1)  // 没追加就不拦产品
assert(validateProfile(normalizeProfile({ ...np, rules: { ...np.rules, rejectTitles: [] } })).errors.some(e => /extraRejectTitles/.test(e)))  // 旧字段名报错
assert.strictEqual(validateProfile(np).ok, true)
assert(validateProfile(normalizeProfile({})).errors.some(e => /candidate.intro/.test(e)))
assert(validateProfile(normalizeProfile({ candidate: { intro: 'x', links: [] } })).errors.some(e => /candidate.links/.test(e)))
assert(validateProfile(normalizeProfile({ ...np, rules: { ...np.rules, outsourcing: 'maybe' } })).errors.some(e => /outsourcing/.test(e)))
assert(validateProfile(normalizeProfile({ ...np, search: { ...np.search, city: '北京' } })).errors.some(e => /city/.test(e)))
// 规则真的生效：minSalaryK=15 时 20-25K 过；rejectLanguages=[] 时 C++ 不拦
assert.strictEqual(filterCards([{ title: 'AI', co: 'A', salary: '20-25K', tags: [], url: 'https://www.zhipin.com/job_detail/r1.html' }], { rules: np.rules }).keep.length, 1)
assert.strictEqual(evalDetail({}, '后端 30-60K', '精通 C++ 与底层引擎，AI Agent', { rejectLanguages: [] }).pass, true)
assert.strictEqual(evalDetail({}, '后端 30-60K', '精通 Kotlin 开发，AI Agent', { rejectLanguages: ['Kotlin'] }).reason, '主语言要求 Kotlin')
assert.strictEqual(filterCards([{ title: 'Kotlin 开发', co: 'A', salary: '30-50K', tags: [], url: 'https://www.zhipin.com/job_detail/r2.html' }], { rules: { rejectLanguages: ['Kotlin'] } }).reject[0].reason, '标题主语言 Kotlin')
ok('profile 默认合并 / 派生 / 校验 / 规则生效')

// ---- updateLedgerFromCheckpoint（幂等） ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pipetest-'))
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
// toLedger:false 的淘汰不进台账
fs.appendFileSync(dtPath, JSON.stringify({ co: '瞬态公司', decision: 'ELIMINATED', reason: '职位已关闭', toLedger: false }) + '\n')
assert.strictEqual(updateLedgerFromCheckpoint(ledgerPath, ckPath, '2026-09-16', dtPath).addedElim, 0)
ok('toLedger=false 不进台账')
// 台账文件不存在 → 从空表创建
const freshLedger = path.join(tmp, 'sub', 'fresh-ledger.json')
assert.strictEqual(updateLedgerFromCheckpoint(freshLedger, ckPath, '2026-09-16').added, 2)  // 新公司A + 老公司（fresh 表里没有）
assert(fs.existsSync(freshLedger))
ok('台账缺失自动创建')
// SKIPPED（BOSS 显示已沟通）也进 applied
fs.appendFileSync(dtPath, JSON.stringify({ co: '漏记公司', title: 'T', url: 'https://www.zhipin.com/job_detail/s1.html', decision: 'SKIPPED', status: '已投过，跳过' }) + '\n')
const u5 = updateLedgerFromCheckpoint(ledgerPath, ckPath, '2026-09-16', dtPath)
assert.strictEqual(u5.added, 1)
assert(JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).applied.some(a => a.co === '漏记公司' && a.via === 'skipped'))
assert.strictEqual(updateLedgerFromCheckpoint(ledgerPath, ckPath, '2026-09-16', dtPath).added, 0)  // 幂等
ok('SKIPPED 进台账 applied')

// ---- screenLoop：mock 浏览器，测 decision 映射 / 断点 / 详情页未加载 ----
async function testScreenLoop() {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeloop-'))
  const jobs = [
    { co: '好公司', title: 'AI Agent 工程师', url: 'https://www.zhipin.com/job_detail/g1.html' },
    { co: '按钮坏公司', title: 'AI Agent 工程师', url: 'https://www.zhipin.com/job_detail/g2.html' },
    { co: '已投过公司', title: 'AI Agent 工程师', url: 'https://www.zhipin.com/job_detail/g3.html' },
    { co: '没加载公司', title: 'AI Agent 工程师', url: 'https://www.zhipin.com/job_detail/g4.html' },
    { co: '外包公司', title: 'AI Agent 工程师（驻场）', url: 'https://www.zhipin.com/job_detail/g5.html' },
  ]
  fs.writeFileSync(path.join(runDir, 'shortlist.json'), JSON.stringify({ keep: jobs }))
  let cur = null
  const btnByCo = { '好公司': '', '按钮坏公司': '', '已投过公司': '继续沟通', '没加载公司': '', '外包公司': '继续沟通' }
  const h = {
    wait: async () => {},
    click: async () => {},
    pageInfo: async () => ({ url: '' }),
    gotoAndWait: async (url) => { cur = jobs.find(j => j.url === url) },
    js: async (expr) => {
      if (expr.includes('.job-banner')) return cur.co === '没加载公司' ? null : cur.title + ' 30-60K'
      if (expr.includes('.job-sec-text')) return '负责 AI Agent 平台'
      if (expr.includes('btn-startchat')) return btnByCo[cur.co]
      return ''
    },
  }
  const pipe = makePipeline(h, profile)
  const r1 = await pipe.screenLoop(runDir, null, { maxSend: 7, budgetS: 60 })
  assert.strictEqual(r1.sent, 0, '按钮异常不能算 SENT')
  const byCo = Object.fromEntries(r1.out.map(o => [o.co, o.decision]))
  assert.strictEqual(byCo['好公司'], 'FAILED')
  assert.strictEqual(byCo['已投过公司'], 'SKIPPED')
  assert.strictEqual(byCo['没加载公司'], 'FAILED')
  assert.strictEqual(byCo['外包公司'], 'NEEDS_REVIEW')
  const d1 = fs.readFileSync(path.join(runDir, 'details.jsonl'), 'utf8')
  assert(!d1.includes('ELIMINATED'), '详情页未加载不能判定淘汰')
  // 第二轮：FAILED 重试，SKIPPED 跳过
  const r2 = await pipe.screenLoop(runDir, null, { maxSend: 7, budgetS: 60 })
  const cos2 = r2.out.map(o => o.co)
  assert(cos2.includes('好公司') && cos2.includes('没加载公司'), 'FAILED 下轮必须重试')
  assert(!cos2.includes('已投过公司'), 'SKIPPED 是终态')
  assert(!cos2.includes('外包公司'), 'NEEDS_REVIEW 是终态，不重复开')
  // agent 判断后点名补发：放行 review，走完整闭环（mock 按钮态=继续沟通 → SKIPPED，证明已越过 review）
  const rv = await pipe.sendReviewed(runDir, '外包公司')
  assert.strictEqual(rv.decision, 'SKIPPED')
  assert.strictEqual((await pipe.sendReviewed(runDir, '不存在公司')).decision, 'FAILED')
  ok('screenLoop decision 映射 + 断点重试语义 + 详情页未加载不淘汰')
}

// ---- discover：mock page，测滚动/合并去重/字体校验分支 ----
async function testDiscover(fontOk) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipedisc-'))
  const mk = (i, sal) => ({ title: 'AI Agent 工程师', co: '公司' + i, salary: sal, tags: ['3-5年', '本科'], url: 'https://www.zhipin.com/job_detail/d' + i + '.html' })
  const cards = [mk(1, PUA('30') + '-' + PUA('50') + 'K'), mk(2, PUA('15') + '-' + PUA('25') + 'K'), mk(3, '40-60K')]
  let gotoUrls = [], rounds = 0, onDetail = false
  const page = {
    goto: async (u) => { gotoUrls.push(u); onDetail = false },
    waitForLoadState: async () => {},
    cdp: async () => { rounds++ },
  }
  const h = {
    wait: async () => {}, click: async () => {}, pageInfo: async () => ({ url: '' }),
    gotoAndWait: async (u) => { gotoUrls.push(u); onDetail = true },
    js: async (expr) => {
      if (expr.includes('hasUser')) return true                             // 登录预检
      if (expr.includes('.job-banner')) return fontOk ? 'AI Agent 工程师 30-50K' : 'AI Agent 工程师 20-40K'
      if (expr.includes('.length')) return rounds < 3 ? rounds : 3          // 第 3 轮起平台期
      if (expr.includes('job-card-box')) return cards
      return ''
    },
  }
  const pipe = makePipeline(h, profile)
  const r = await pipe.discover(runDir, page, ['Agent', '智能体'], { stableRounds: 2, maxRounds: 10 })
  assert.strictEqual(r.ok, true, JSON.stringify(r))
  assert(gotoUrls[0].includes('query=Agent&salary=406,407&experience=105,106,107'), '列表 URL 带服务端筛选')
  assert.strictEqual(gotoUrls.filter(u => u.includes('job_detail')).length, 1, '只开 1 个详情页校验字体')
  assert.strictEqual(r.poolUnique, 3, '双查询同卡按 url 去重')
  assert.strictEqual(r.salaryFont.verified, fontOk, JSON.stringify(r.salaryFont))
  const sl = JSON.parse(fs.readFileSync(path.join(runDir, 'shortlist.json'), 'utf8'))
  if (fontOk) assert.deepStrictEqual(sl.keep.map(k => k.co), ['公司1', '公司3'])          // 解码：15-25K 卡级淘汰
  else assert.deepStrictEqual(sl.keep.map(k => k.co), ['公司1', '公司2', '公司3'])        // 字体不对：打码全留细筛
  ok('discover 服务端筛选 + 字体校验 ' + (fontOk ? '通过' : '失败退回'))
}

testDiscover(true).then(() => testDiscover(false)).then(testScreenLoop).then(() => console.log('\nALL', n, 'ASSERTS PASSED')).catch(e => { console.error(e); process.exit(1) })
