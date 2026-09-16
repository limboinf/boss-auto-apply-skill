// BOSS直聘流水线 v2：粗筛（滚动记录+卡级规则）→ 细筛（串行单岗闭环：读JD→规则→定hook→立即发送→验证→当场记账）。
// 设计原则：
//   1. 粗筛只滚动只记录：滚到平台期或轮上限，全量落盘 pool.json，卡级规则过出 shortlist.json；
//   2. 细筛严格串行：逐岗打开详情页，满足条件【立即发送对应消息】（用 lib.applyOne + verifyCurrent），
//      绝不攒到最后统一发（防风控）；发完立即 append checkpoint.jsonl 与 details.jsonl；
//   3. 台账 applied-ledger.json 由 checkpoint 中 VERIFIED 记录派生更新（幂等，按公司去重）。
// 只在 ego-browser heredoc 内 require；h = {js, click, wait, gotoAndWait, pageInfo}。
// 纯逻辑函数（filterCards/evalDetail/makeHook/updateLedgerFromCheckpoint）不依赖浏览器，可直接离线测试。
// 数据目录解析：环境变量 BOSS_APPLY_DATA 优先；缺省用仓库内 data/（相对本文件定位，无机器特有路径）。
const fs = require('fs')
const pathMod = require('path')
const makeApplyLib = require('./batch_apply_lib.js')

const REPO_ROOT = pathMod.resolve(__dirname, '..')
function dataDir() {
  return process.env.BOSS_APPLY_DATA || pathMod.join(REPO_ROOT, 'data')
}
function ledgerPath() {
  return pathMod.join(dataDir(), 'applied-ledger.json')
}

// ---------------- 纯逻辑（可离线测试） ----------------

const DEFAULT_BLOCK_COS = [
  '腾讯', '阿里', '字节', '抖音', '百度', '滴滴', '金山云', '高德', '美团', '京东', '网易', '华为',
  '小米', '快手', '哔哩', 'B站', '拼多多', '携程', '小红书', '理想汽车', '蔚来', '小鹏',
  'DeepSeek', '深度求索', '智谱', '月之暗面', 'Moonshot', 'MiniMax', '名之梦', '百川', '阶跃', '面壁',
]

const TITLE_BAD = [/实习/, /校招/, /应届/, /2[5-9]届/, /储备/, /管培/, /销售/, /销售VP/, /电话销售/, /客服/, /电销/]
const EDU_BAD = [/硕士/, /博士/]

// 卡级粗筛：薪资可解析则 Max>=30；打码('-K·薪')保留待细筛；面议/无法解析淘汰。
function cardSalaryVerdict(salaryText) {
  const s = String(salaryText || '').trim()
  if (!s) return { keep: false, reason: '卡片无薪资' }
  if (/面议/.test(s)) return { keep: false, reason: '薪资面议' }
  const m = /(\d+)\s*-\s*(\d+)\s*K/i.exec(s)
  if (m) {
    const max = Number(m[2])
    return max >= 30
      ? { keep: true, reason: '卡片薪资Max' + max + 'K' }
      : { keep: false, reason: '卡片薪资Max ' + max + 'K<30K' }
  }
  // 反爬字体打码：数字被替换成 PUA 不可见字符（如「-K·薪」字符间有私用区码点）。
  // 规则：无 ASCII 数字但含 K/薪/元 特征 → 视为打码，保留给细筛读详情页真实薪资。
  if (/[Kk薪元]/.test(s)) {
    const hasPua = /[\uE000-\uF8FF]/.test(s)
    const noAsciiDigit = !/\d/.test(s)
    if (hasPua || noAsciiDigit) return { keep: true, reason: '薪资打码，留细筛', masked: true }
  }
  if (/-\s*K(·|$)|\d+\s*-\s*K/.test(s)) return { keep: true, reason: '薪资打码，留细筛', masked: true }
  return { keep: false, reason: '薪资无法解析:' + s }
}

// 猎头挂单识别：masked 公司名。实战验证：这类岗位点沟通后会话挂在猎头公司名下（可为天下/莱恩咨询等），岗位信息被猎头包装，默认过滤。
// 模式：含「某」且（以「公司/企业/央企…」结尾 或 纯「某知名企业」式短名）。「获融资」括注也是猎头话术特征。
function isHeadhunterPost(co) {
  const n = String(co || '').replace(/\s/g, '')
  if (!/某/.test(n)) return false
  if (/公司|企业|央企|集团|独角兽/.test(n)) return true
  if (/获.{0,12}融资|融资.{0,6}亿/.test(n)) return true
  if (/^某.{2,6}(知名|大型|中型|小型|上市)/.test(n)) return true
  return false
}

// 粗筛入口：cards = [{title,co,salary,tags,url}]
// opts.excludeHeadhunter（默认 true）：过滤猎头挂单（masked 公司名岗位）。
function filterCards(cards, opts = {}) {
  const excludeHeadhunter = opts.excludeHeadhunter !== false
  const blockCos = opts.hardBlockCos || DEFAULT_BLOCK_COS
  const appliedCos = (opts.appliedCos || []).map(x => String(typeof x === 'string' ? x : x.co || '').replace(/\s/g, ''))
  const elimCos = (opts.eliminatedCos || []).map(x => String(typeof x === 'string' ? x : x.co || '').replace(/\s/g, ''))
  const seenCompanies = []   // 本批已收公司名（含已投/已淘汰）
  const keep = []
  const reject = []
  const companyDup = (n) => seenCompanies.some(e => e && (n.includes(e) || e.includes(n)))
  const inList = (n, list) => list.some(e => e && (n.includes(e) || e.includes(n)))
  for (const raw of cards || []) {
    const co = String(raw.co || '').replace(/\s/g, '')
    const title = String(raw.title || '')
    const tags = (raw.tags || []).map(t => String(t))
    const all = title + '|' + tags.join('|')
    const R = (reason) => reject.push({ co: raw.co, title, url: raw.url, reason })
    if (!raw.url || !/^https:\/\/www\.zhipin\.com\/job_detail\//.test(raw.url)) { R('URL异常'); continue }
    if (!co) { R('无公司名'); continue }
    if (blockCos.some(b => co.includes(b))) { R('大厂/模型公司:' + co); continue }
    if (inList(co, appliedCos) || companyDup(co)) { R('已投/重复公司'); continue }
    if (inList(co, elimCos)) { R('台账已淘汰'); continue }
    if (excludeHeadhunter && isHeadhunterPost(co)) { R('猎头挂单(默认过滤)'); continue }
    if (TITLE_BAD.some(re => re.test(all))) { R('实习/校招/应届'); continue }
    if (EDU_BAD.some(re => re.test(tags.join('|')))) { R('硕士及以上'); continue }
    const v = cardSalaryVerdict(raw.salary)
    if (!v.keep) { R(v.reason); continue }
    seenCompanies.push(co)
    keep.push({ ...raw, cardSalary: raw.salary, why: v.reason })
  }
  return { keep, reject }
}

// 详情级细筛规则：bannerText（含职位名+薪资）、tags、jdText。
// 返回 {pass, reason, salary}。pass=false 一律给 reason（写台账用）。
function evalDetail(job, bannerText, jdText) {
  const banner = String(bannerText || '')
  const jd = String(jdText || '')
  if (/职位已关闭|已停止招聘/.test(banner)) return { pass: false, reason: '职位已关闭' }
  const m = /(\d+)\s*-\s*(\d+)\s*K/i.exec(banner)
  if (!m) return { pass: false, reason: '详情薪资无法解析:' + banner.slice(0, 40) }
  const max = Number(m[2])
  if (max < 30) return { pass: false, reason: 'Max ' + max + 'K<30K', salary: m[0] }
  if (EDU_BAD.some(re => re.test(banner))) return { pass: false, reason: '硕士及以上', salary: m[0] }
  // 语言红线：Go/C++/Rust/PHP/C# 作为「要求/精通/熟悉」出现（非加分/可选措辞）才淘汰
  const LANGS = [['Go', /Go|Golang/], ['Golang', /Golang/], ['C++', /C\+\+/], ['Rust', /Rust/], ['PHP', /PHP/], ['C#', /C#/]]
  for (const [label, langRe] of LANGS) {
    const re = new RegExp('(精通|熟练|掌握|要求|使用)[ ]{0,3}' + langRe.source + '|【' + langRe.source + '】|' + langRe.source + '[工程师开发]{2,}|主要[^。\n]{0,8}' + langRe.source)
    if (re.test(jd) && !/(加分|优先|可选|了解|plus)/.test(jd.split(langRe).slice(0, 2).join('x').slice(-60))) {
      return { pass: false, reason: '主语言要求 ' + label, salary: m[0] }
    }
  }
  // 岗位类型红线
  if (/(测试开发|测试工程师|运维工程师|AIOps|产品经理|讲师|助教|销售|电销|客服)/.test(String(job.title) + '|' + String(bannerText))) {
    return { pass: false, reason: '岗位类型不匹配:' + job.title, salary: m[0] }
  }
  // 画像匹配：JD 必须含 AI/Agent/大模型 要素
  if (!/(AI|Agent|智能体|大模型|LLM|AIGC|RAG|多模态|机器学习|深度学习)/i.test(jd)) {
    return { pass: false, reason: 'JD无AI/Agent要素', salary: m[0] }
  }
  return { pass: true, reason: 'Max' + max + 'K+画像匹配', salary: m[0] }
}

// JD→hook 映射表：按优先级取第一个命中。hook 追加进消息正文，own 取自 hook 内独一短语。
const HOOK_TABLE = [
  { kws: ['MCP', 'Model Context Protocol'], hook: '日常在深度使用和改造 MCP 生态，对工具链集成有第一手实践' },
  { kws: ['LangGraph', 'LangChain'], hook: '有 LangChain/LangGraph 工作流编排和多轮对话的实战落地经验' },
  { kws: ['RAG', '检索增强', '知识库'], hook: '做过多个 RAG 知识库检索增强系统的架构与调优' },
  { kws: ['多模态'], hook: '有多模态大模型应用的开发与落地经验' },
  { kws: ['工作流', '编排', 'pipeline', 'Pipeline'], hook: '擅长 Agent 工作流编排设计，能把复杂业务拆成稳定可观测的流水线' },
  { kws: ['Claude', 'Claude Code', 'Copilot', 'Cursor', 'AI编程', 'AI 编程', 'coding'], hook: '自己就在深度改造 Claude Code 等开源 Agent 框架做日常开发，和贵司方向高度对口' },
  { kws: ['开源'], hook: '给多个知名 AI 开源项目贡献过源码，GitHub 持续活跃' },
  { kws: ['微调', 'fine-tun', 'SFT', 'LoRA'], hook: '有大模型微调与效果评估的完整实践经验' },
  { kws: ['评估', '评测', 'benchmark', 'Benchmark'], hook: '搭过 Agent 效果评估体系，懂指标设计与回归验证' },
  { kws: ['全栈', '前端', '后端', 'Web'], hook: '全栈出身，能一人闭环从前端交互到后端服务到部署上线' },
  { kws: ['Python'], hook: 'Python 重度用户，近三年 AI 应用全部 Python 技术栈交付' },
  { kws: ['Java'], hook: 'Java 老兵出身，近三年转 AI 应用架构，工程底子和 AI 能力都在线' },
  { kws: ['大模型', 'LLM', 'Agent', '智能体', 'AI应用', 'AI 应用'], hook: '近三年专注 AI Agent 落地，从架构设计到上线运维的完整闭环都亲手做过' },
]

function makeHook(job, jdText, usedOwns) {
  const jd = String(jdText || '')
  const used = usedOwns || new Set()
  const hits = HOOK_TABLE.filter(e => e.kws.some(k => jd.includes(k)))
  for (const e of hits) {
    // own 取 hook 中间一段独一短语（去掉开头两字避免通用撞词）
    const own = e.hook.length > 10 ? e.hook.slice(2, 12) : e.hook
    if (!used.has(own)) return { hook: e.hook, own }
  }
  // 兜底：own 必须取自 hook 文本内（validateJob 要求 own⊂hook），公司名拼进 hook 保独一
  const coTag = String(job.co || '').slice(0, 8)
  const hook = '仔细读过贵司 JD，与我的 Agent 落地经验高度匹配（' + coTag + '岗）'
  const own = hook.slice(2, 12)
  return { hook, own }
}

// 台账派生更新：从 checkpoint.jsonl 的 VERIFIED 行合并进 applied-ledger.json（幂等）。
// 同时从 details.jsonl 的 ELIMINATED 行合并 eliminated（幂等，跳过已存在公司）。
function updateLedgerFromCheckpoint(ledgerPathArg, checkpointPath, dateStr, detailsPath) {
  const ledger = JSON.parse(fs.readFileSync(ledgerPathArg, 'utf8'))
  const origElim = new Set(ledger.eliminated.map(e => String(typeof e === 'string' ? e : e.co || '').replace(/\s/g, '')))
  let added = 0, addedElim = 0
  if (detailsPath && fs.existsSync(detailsPath)) {
    for (const line of fs.readFileSync(detailsPath, 'utf8').split('\n').filter(Boolean)) {
      let d
      try { d = JSON.parse(line) } catch (e) { continue }
      if (d.decision === 'ELIMINATED' && d.co && d.reason) {
        const co = String(d.co).replace(/\s/g, '')
        if (!origElim.has(co) && ![...origElim].some(e => co.includes(e) || e.includes(co))) {
          ledger.eliminated.push({ co: d.co, reason: d.reason })
          origElim.add(co)
          addedElim++
        }
      }
    }
  }
  if (fs.existsSync(checkpointPath)) {
    const lines = fs.readFileSync(checkpointPath, 'utf8').split('\n').filter(Boolean)
    const doneCos = new Set(ledger.applied.map(a => String(a.co).replace(/\s/g, '')))
    for (const line of lines) {
      let r
      try { r = JSON.parse(line) } catch (e) { continue }
      if (r.status === 'OK' && r.verify && r.verify.ok) {
        const co = String(r.co).replace(/\s/g, '')
        if (!doneCos.has(co) && ![...doneCos].some(e => co.includes(e) || e.includes(co))) {
          ledger.applied.push({ co: r.co, date: dateStr, title: r.title, url: r.url })
          doneCos.add(co)
          added++
        }
      }
    }
  }
  if (added || addedElim) fs.writeFileSync(ledgerPathArg, JSON.stringify(ledger, null, 2))
  return { added, addedElim, total: ledger.applied.length, totalElim: ledger.eliminated.length }
}

// ---------------- 浏览器流程（heredoc 内使用） ----------------

function makePipelineV2(h) {
  const lib = makeApplyLib(h)

  async function waitFor(fn, timeoutS) {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutS * 1000) {
      try { const v = await fn(); if (v) return v } catch (e) {}
      await h.wait(0.6)
    }
    return null
  }

  function log(runDir, name, line) {
    fs.mkdirSync(runDir, { recursive: true })
    fs.appendFileSync(pathMod.join(runDir, name), line + '\n')
  }

  function appendJsonl(path, obj) {
    fs.mkdirSync(pathMod.dirname(path), { recursive: true })
    fs.appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...obj }) + '\n')
  }

  const readJson = (p, dflt) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return dflt } }

  // ---------- 粗筛：滚动记录 ----------
  // 逐查询滚动至平台期（连续 stableRounds 轮卡数不增）或 maxRounds 上限；全量落盘 pool-<q>.json。
  // 不打开任何详情页、不发任何消息。opts.excludeHeadhunter 透传 filterCards（默认 true 过滤猎头挂单）。
  async function discover(runDir, page, queries, opts = {}) {
    const maxRounds = opts.maxRounds || 60
    const stableRounds = opts.stableRounds || 6
    const results = []
    for (const q of queries) {
      const url = 'https://www.zhipin.com/web/geek/jobs?city=101010100&query=' + encodeURIComponent(q)
      await page.goto(url)
      await page.waitForLoadState()
      await h.wait(2)
      const loginOk = await h.js(String.raw`(() => !!document.querySelector('.nav-figure, .user-info, [class*="avatar" i]'))()`)
      if (!loginOk) return { ok: false, phase: 'login', error: '登录态失效：停止粗筛，交 handOff' }
      let rounds = 0, prev = 0, stable = 0
      for (let i = 0; i < maxRounds; i++) {
        await page.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 500, y: 500, deltaX: 0, deltaY: 900, pointerType: 'mouse' })
        await h.wait(1.2)
        rounds++
        const n = await h.js(String.raw`(() => document.querySelectorAll('li.job-card-box').length)()`)
        log(runDir, 'scroll-' + q + '.log', 'round ' + rounds + ' cards ' + n + ' stable ' + stable)
        if (n > prev) { prev = n; stable = 0 } else { stable++ }
        if (stable >= stableRounds) break
      }
      const cards = await h.js(String.raw`(() => {
        const cards = [...document.querySelectorAll('li.job-card-box')];
        return cards.map(c => {
          const t = (sel) => { const el = c.querySelector(sel); return el ? el.textContent.trim() : '' };
          const link = c.querySelector('a[href*="job_detail"]');
          return { title: t('.job-name'), co: t('.boss-name'), salary: t('.job-salary'), tags: [...c.querySelectorAll('.tag-list li')].map(x => x.textContent.trim()), url: link ? link.href : '' };
        }).filter(x => x.url);
      })()`)
      fs.writeFileSync(pathMod.join(runDir, 'pool-' + q + '.json'), JSON.stringify({ query: q, rounds, count: cards.length, candidates: cards }, null, 1))
      results.push({ query: q, rounds, cards: cards.length })
    }
    // 合并双查询池 + 卡级粗筛 → shortlist.json
    const pool = []
    for (const q of queries) pool.push(...(readJson(pathMod.join(runDir, 'pool-' + q + '.json'), { candidates: [] })).candidates)
    const seenUrl = new Set()
    const uniq = pool.filter(c => c.url && !seenUrl.has(c.url) && seenUrl.add(c.url))
    const ledger = readJson(ledgerPath(), { applied: [], eliminated: [] })
    const f = filterCards(uniq, { appliedCos: ledger.applied, eliminatedCos: ledger.eliminated, hardBlockCos: opts.hardBlockCos, excludeHeadhunter: opts.excludeHeadhunter })
    fs.writeFileSync(pathMod.join(runDir, 'shortlist.json'), JSON.stringify({ at: new Date().toISOString(), kept: f.keep.length, rejected: f.reject.length, keep: f.keep }, null, 1))
    fs.writeFileSync(pathMod.join(runDir, 'coarse-reject.json'), JSON.stringify(f.reject, null, 1))
    return { ok: true, phase: 'discover', results, poolUnique: uniq.length, kept: f.keep.length, rejected: f.reject.length }
  }

  // ---------- 细筛：单岗闭环 ----------
  // 打开详情 → 规则判定 → 通过则【立即发送】（applyOne+verifyCurrent）→ 当场 append details.jsonl + checkpoint.jsonl。
  // opts.dryRun=true：只判定落盘（decision: DRY_PASS / ELIMINATED），绝不点击、绝不发送——用于上线前只读验证。
  async function screenAndSendOne(runDir, job, ctx, opts = {}) {
    await h.gotoAndWait(job.url, { timeout: 20, settle: 2 })
    await h.wait(1.5)
    const banner = await h.js(String.raw`(() => { const b = document.querySelector('.job-banner, .job-title'); return b ? b.innerText.trim() : document.body.innerText.slice(0, 120) })()`)
    const jd = await h.js(String.raw`(() => { const s = document.querySelector('.job-sec-text'); return s ? s.innerText.trim().slice(0, 4000) : '' })()`)
    const verdict = evalDetail(job, banner, jd)
    if (!verdict.pass) {
      appendJsonl(pathMod.join(runDir, 'details.jsonl'), { co: job.co, title: job.title, url: job.url, salary: verdict.salary || null, decision: 'ELIMINATED', reason: verdict.reason })
      return { co: job.co, decision: 'ELIMINATED', reason: verdict.reason }
    }
    // 通过 → 定 hook
    let hook, own
    if (ctx.hooks && ctx.hooks[job.co]) { hook = ctx.hooks[job.co]; own = hook.slice(2, 14) }
    else { const m = makeHook(job, jd, ctx.usedOwns); hook = m.hook; own = m.own }
    ctx.usedOwns.add(own)
    if (opts.dryRun) {
      appendJsonl(pathMod.join(runDir, 'details.jsonl'), { co: job.co, title: job.title, url: job.url, salary: verdict.salary, decision: 'DRY_PASS', hook })
      return { co: job.co, decision: 'DRY_PASS', salary: verdict.salary, hook }
    }
    // 立即发送
    const full = { co: job.co, key: job.key || job.convKey || String(job.co).slice(0, 4), title: job.title, hook, own, url: job.url }
    const v = lib.validateJob(full)
    if (!v.ok) {
      appendJsonl(pathMod.join(runDir, 'details.jsonl'), { co: job.co, title: job.title, url: job.url, salary: verdict.salary, decision: 'FAILED', reason: 'preflight:' + v.error })
      return { co: job.co, decision: 'FAILED', reason: v.error }
    }
    const sent = await lib.applyOne(full, lib.makeMsg(full.title, hook))
    let verify = { ok: false, skipped: true }
    if (sent.status === 'OK') {
      verify = await lib.verifyCurrent(full)
      if (!verify.ok) { await h.wait(1.2); verify = await lib.verifyCurrent(full) }
    }
    appendJsonl(pathMod.join(runDir, 'checkpoint.jsonl'), { co: job.co, title: job.title, url: job.url, status: sent.status, secs: sent.secs || null, verify })
    appendJsonl(pathMod.join(runDir, 'details.jsonl'), { co: job.co, title: job.title, url: job.url, salary: verdict.salary, decision: 'SENT', status: sent.status, verifyOk: !!(verify && verify.ok), hook })
    return { co: job.co, decision: 'SENT', status: sent.status, verifyOk: !!(verify && verify.ok) }
  }

  // ---------- 细筛串行主循环（每轮一个 heredoc，控时 550s 内） ----------
  // order：ctx.hooks 里点名的公司优先；其余按 shortlist 顺序。opts.dryRun 透传给 screenAndSendOne。
  async function screenLoop(runDir, page, opts = {}) {
    const maxSend = opts.maxSend || 7
    const budgetS = opts.budgetS || 480
    const t0 = Date.now()
    const shortlist = readJson(pathMod.join(runDir, 'shortlist.json'), { keep: [] }).keep
    const doneCos = new Set()
    try {
      for (const line of fs.readFileSync(pathMod.join(runDir, 'details.jsonl'), 'utf8').split('\n').filter(Boolean)) {
        try { doneCos.add(JSON.parse(line).co) } catch (e) {}
      }
    } catch (e) {}
    const hooks = opts.hooks || {}
    const ranked = [
      ...shortlist.filter(j => hooks[j.co]),
      ...shortlist.filter(j => !hooks[j.co]),
    ]
    const ctx = { hooks, usedOwns: new Set() }
    const out = []
    let sent = 0
    for (const job of ranked) {
      if (sent >= maxSend) break
      if ((Date.now() - t0) / 1000 > budgetS) { out.push({ stop: 'time-budget' }); break }
      if (doneCos.has(job.co)) continue
      try {
        const r = await screenAndSendOne(runDir, job, ctx, opts)
        out.push(r)
        if (r.decision === 'SENT') {
          sent++
          await h.wait(20 + Math.floor(Math.random() * 15)) // 发送间隔 20-35s，防风控
        } else if (r.decision === 'DRY_PASS' || r.decision === 'ELIMINATED') {
          await h.wait(1.2)
        }
      } catch (e) {
        appendJsonl(pathMod.join(runDir, 'details.jsonl'), { co: job.co, title: job.title, url: job.url, decision: 'FAILED', reason: String(e && e.message || e).slice(0, 200) })
        out.push({ co: job.co, decision: 'EXCEPTION', error: String(e && e.message || e).slice(0, 120) })
      }
    }
    return { sent, elapsedS: Math.round((Date.now() - t0) / 1000), out }
  }

  return { waitFor, log, discover, screenAndSendOne, screenLoop, lib }
}

module.exports = { makePipelineV2, filterCards, cardSalaryVerdict, evalDetail, makeHook, updateLedgerFromCheckpoint, isHeadhunterPost, dataDir, ledgerPath, DEFAULT_BLOCK_COS, HOOK_TABLE }
