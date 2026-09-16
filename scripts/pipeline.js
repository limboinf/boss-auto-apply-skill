// BOSS直聘流水线：粗筛（滚动记录+卡级规则）→ 细筛（串行单岗闭环：读JD→规则→定hook→立即发送→验证→当场记账）。
// 设计原则：
//   1. 粗筛只滚动只记录：滚到平台期或轮上限，全量落盘 pool.json，卡级规则过出 shortlist.json；
//   2. 细筛严格串行：逐岗打开详情页，满足条件【立即发送对应消息】（用 lib.applyOne + verifyCurrent），
//      绝不攒到最后统一发（防风控）；发完立即 append checkpoint.jsonl 与 details.jsonl；
//   3. 台账 applied-ledger.json 由 checkpoint 中 VERIFIED 记录派生更新（幂等，按公司去重）。
// 只在 ego-browser heredoc 内 require；h = {js, click, wait, gotoAndWait, pageInfo}。
// 纯逻辑函数（filterCards/evalDetail/makeHook/updateLedgerFromCheckpoint）不依赖浏览器，可直接离线测试。
// 数据目录由 profile.js 统一解析（BOSS_APPLY_DATA 或 ~/.boss-auto-apply），代码目录里不放任何个人数据。
const fs = require('fs')
const pathMod = require('path')
const makeApplyLib = require('./apply.js')
const { DEFAULTS: PROFILE_DEFAULTS, BASE_REJECT_TITLES, normalizeProfile, dataDir } = require('./profile.js')

function ledgerPath() {
  return pathMod.join(dataDir(), 'applied-ledger.json')
}
// 每批次工作目录：<data>/runs/<name>，name 形如 2026-09-16-AM
function runDir(name) {
  return pathMod.join(dataDir(), 'runs', name)
}

// ---------------- 纯逻辑（可离线测试） ----------------
// 规则参数全部来自 profile（scripts/profile.js）：纯函数接 rules / profile 入参，缺省用 DEFAULTS。
// 这里只剩「机制」常量（反爬字体、薪资正则、猎头名模式）。

const DEFAULT_RULES = PROFILE_DEFAULTS.rules

// 薪资区间：兼容「30-60K」「30K-60K」「30-60K·15薪」
const SALARY_RE = /(\d+)\s*K?\s*-\s*(\d+)\s*K/i
// BOSS 列表页反爬字体：薪资数字被替换成私用区 U+E031..U+E03A，依次对应 0..9（2026-09 实测两天 143 对零冲突）。
// 详情页不打码。粗筛用这个把卡级薪资还原，但每批先开 1 个详情页校验（字体一换就退回「留细筛」）。
const SALARY_FONT_BASE = 0xE031
const SALARY_FONT_RE = /[-]/   // 不带 g：带 g 的 test() 会记 lastIndex，连续调用结果交替
function decodeSalaryFont(text) {
  return String(text || '').replace(/[-]/g, ch => String(ch.codePointAt(0) - SALARY_FONT_BASE))
}
const parseSalaryRange = (text) => { const m = SALARY_RE.exec(String(text || '')); return m ? { min: +m[1], max: +m[2] } : null }

// 学历红线：硬要求才拦；「硕士优先/加分」豁免
function hardEduRequired(text, degrees = DEFAULT_RULES.rejectDegrees) {
  const t = String(text || '')
  if (!degrees.length) return false
  const alt = degrees.map(escapeRe).join('|')
  return new RegExp(alt).test(t) && !new RegExp('(' + alt + ').{0,4}(优先|加分)').test(t)
}
const escapeRe = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// 语言 label → 带字母边界的正则源（Go 不能命中 Google、Rust 不能命中 Trust；Go 兼容 Golang）
function langSource(label) {
  const core = label === 'Go' ? 'Go(?:lang)?' : escapeRe(label)
  const tail = /[A-Za-z]$/.test(label) ? '(?![A-Za-z])' : ''
  return '(?<![A-Za-z])' + core + tail
}
const titleLangRe = (langs) => langs.length ? new RegExp('(' + langs.map(langSource).join('|') + ')') : null

// 岗位标题/标签红线：固定 4 条 + profile.rules.extraRejectTitles + rejectLanguages（标题带 Go/C++ 之类直接淘汰）
function titleRules(rules) {
  const all = rules.allRejectTitles || [...BASE_REJECT_TITLES, ...(rules.extraRejectTitles || [])]
  const list = all.map(t => [new RegExp(t.pattern), t.reason])
  const lr = titleLangRe(rules.rejectLanguages)
  if (lr) list.push([lr, '标题主语言 ' + rules.rejectLanguages.join('/')])
  return list
}

// 公司名归一 + 同名判定。BOSS 展示名常带地域/主体后缀（「万联易达」vs「北京万联易达互联科技」），允许子串匹配；
// 但 2 字短名子串会误杀（「京喜」⊂「北京喜马拉雅」），短名只认完全相等。
const normCo = (x) => String(typeof x === 'string' ? x : (x && x.co) || '').replace(/\s/g, '').replace(/(\.\.\.|…)$/, '')
function sameCompany(a, b) {
  const x = normCo(a), y = normCo(b)
  if (!x || !y) return false
  if (x === y) return true
  if (x.length < 3 || y.length < 3) return false
  return x.includes(y) || y.includes(x)
}

// 卡级粗筛：薪资可解析则 Max>=minK；打码('-K·薪')保留待细筛；面议/无法解析淘汰。
function cardSalaryVerdict(salaryText, minK = DEFAULT_RULES.minSalaryK) {
  const s = String(salaryText || '').trim()
  if (!s) return { keep: false, reason: '卡片无薪资' }
  if (/面议/.test(s)) return { keep: false, reason: '薪资面议' }
  if (/元\/(时|天|日)/.test(s)) return { keep: false, reason: '时薪/日薪岗' }
  const m = SALARY_RE.exec(s)
  if (m) {
    const max = Number(m[2])
    return max >= minK
      ? { keep: true, reason: '卡片薪资Max' + max + 'K' }
      : { keep: false, reason: '卡片薪资Max ' + max + 'K<' + minK + 'K' }
  }
  // 反爬字体打码：数字被替换成 PUA 不可见字符（如「-K·薪」字符间有私用区码点）。
  // 规则：无 ASCII 数字但含 K/薪/元 特征 → 视为打码，保留给细筛读详情页真实薪资。
  if (/[Kk薪元]/.test(s)) {
    const hasPua = /[-]/.test(s)
    const noAsciiDigit = !/\d/.test(s)
    if (hasPua || noAsciiDigit) return { keep: true, reason: '薪资打码，留细筛', masked: true }
  }
  if (/-\s*K(·|$)|\d+\s*-\s*K/.test(s)) return { keep: true, reason: '薪资打码，留细筛', masked: true }
  return { keep: false, reason: '薪资无法解析:' + s }
}

// 列表页 URL：城市 + 关键词 + 服务端筛选（薪资码由 minSalaryK 派生，经验码来自 profile）
function listUrl(query, search = PROFILE_DEFAULTS.search) {
  const s = normalizeProfile({ search }).search
  // 逗号不编码：BOSS 实测认 salary=406,407 这种裸逗号
  let url = 'https://www.zhipin.com/web/geek/jobs?city=' + s.city + '&query=' + encodeURIComponent(query)
  if (s.salaryCodes && s.salaryCodes.length) url += '&salary=' + s.salaryCodes.join(',')
  if (s.experienceCodes && s.experienceCodes.length) url += '&experience=' + s.experienceCodes.join(',')
  return url
}

// 猎头挂单识别：masked 公司名。实战验证：这类岗位点沟通后会话挂在猎头公司名下（可为天下/莱恩咨询等），岗位信息被猎头包装，默认过滤。
// 模式：含「某」且（以「公司/企业/央企…」结尾 或 纯「某知名企业」式短名）。「获融资」括注也是猎头话术特征。
function isHeadhunterPost(co) {
  const n = String(co || '').replace(/\s/g, '')
  // 不带「某」的猎头/人力挂单：「知名公司」「头部XX公司」、公司名本身就是人力/猎头机构
  if (/^(知名|头部|大型|上市)[^某]{0,6}(公司|企业|互联网|大厂)$/.test(n)) return true
  if (/人力|猎头|人才服务|锐仕方达|科锐国际|万宝盛华/.test(n)) return true
  if (!/某/.test(n)) return false
  if (/公司|企业|央企|集团|独角兽/.test(n)) return true
  if (/获.{0,12}融资|融资.{0,6}亿/.test(n)) return true
  if (/^某.{2,6}(知名|大型|中型|小型|上市)/.test(n)) return true
  return false
}

// 粗筛入口：cards = [{title,co,salary,tags,url}]
// opts.rules：profile.rules（缺省 DEFAULT_RULES）。opts.decodeSalary：卡级薪资先按反爬字体还原再判（discover 校验通过后才传 true）。
function filterCards(cards, opts = {}) {
  const rules = { ...DEFAULT_RULES, ...(opts.rules || {}) }
  const excludeHeadhunter = rules.headhunter !== 'allow'
  const decodeSalary = !!opts.decodeSalary
  const titleBadList = titleRules(rules)
  const appliedCos = opts.appliedCos || []
  const elimCos = opts.eliminatedCos || []
  const seenCompanies = []   // 本批已收公司名
  const keep = []
  const reject = []
  const inList = (n, list) => list.some(e => sameCompany(n, e))
  for (const raw of cards || []) {
    const co = normCo(raw.co)
    const title = String(raw.title || '')
    const tags = (raw.tags || []).map(t => String(t))
    const all = title + '|' + tags.join('|')
    const R = (reason) => reject.push({ co: raw.co, title, url: raw.url, reason })
    if (!raw.url || !/^https:\/\/www\.zhipin\.com\/job_detail\//.test(raw.url)) { R('URL异常'); continue }
    if (!co) { R('无公司名'); continue }
    if (rules.blockCompanies.some(b => co.includes(b))) { R('黑名单公司:' + co); continue }
    if (inList(co, appliedCos)) { R('台账已投'); continue }
    if (inList(co, seenCompanies)) { R('本批重复公司'); continue }
    if (inList(co, elimCos)) { R('台账已淘汰'); continue }
    if (excludeHeadhunter && isHeadhunterPost(co)) { R('猎头挂单(默认过滤)'); continue }
    const bad = titleBadList.find(([re]) => re.test(all))
    if (bad) { R(bad[1]); continue }
    if (hardEduRequired(tags.join('|'), rules.rejectDegrees)) { R('学历要求 ' + rules.rejectDegrees.join('/')); continue }
    const salary = decodeSalary ? decodeSalaryFont(raw.salary) : raw.salary
    const v = cardSalaryVerdict(salary, rules.minSalaryK)
    if (!v.keep) { R(v.reason); continue }
    seenCompanies.push(co)
    keep.push({ ...raw, salary, cardSalary: raw.salary, why: v.reason })
  }
  return { keep, reject }
}

// 语言红线：rules.rejectLanguages 里的语言作为「要求/精通/熟悉」出现（非加分/可选措辞）才淘汰。
const LANG_EXEMPT = /(加分|优先|可选|了解|plus)/i
const CLAUSE_SEP = /[。；;\n]/

// 返回命中的语言 label；豁免只看命中处所在的句子（句号/分号/换行为界），不看全文。
function langRedLine(jd, langs = DEFAULT_RULES.rejectLanguages) {
  for (const label of langs) {
    const src = langSource(label)
    const re = new RegExp('(?:精通|熟练|掌握|要求|使用)[ ]{0,3}(?:' + src + ')|【(?:' + src + ')】|(?:' + src + ')[工程师开发]{2,}|主要[^。\n]{0,8}(?:' + src + ')')
    const m = re.exec(jd)
    if (!m) continue
    const before = jd.slice(0, m.index).split(CLAUSE_SEP).pop()
    const after = jd.slice(m.index + m[0].length).split(CLAUSE_SEP)[0]
    if (LANG_EXEMPT.test(before + m[0] + after)) continue
    return label
  }
  return null
}

// 外包岗位特征（公司名/标题/JD）
const OUTSOURCING_RE = /外包|驻场|外派|派驻|人力资源服务|人才派遣|劳务派遣/

// 详情级细筛规则：bannerText（含职位名+薪资）、jdText、rules。
// 返回 {pass, reason, salary, toLedger, review}。pass=false 一律给 reason（写台账用）。
// toLedger=false 的淘汰是岗位级/瞬态（职位关闭、薪资没解析出来），不写进总台账 eliminated，下次仍可再看这家公司。
// review=true：其余规则全过但命中外包特征且 rules.outsourcing=review，落 NEEDS_REVIEW 由 agent 决定是否投。
function evalDetail(job, bannerText, jdText, rulesArg) {
  const rules = { ...DEFAULT_RULES, ...(rulesArg || {}) }
  const banner = String(bannerText || '')
  const jd = String(jdText || '')
  if (/职位已关闭|已停止招聘/.test(banner)) return { pass: false, reason: '职位已关闭', toLedger: false }
  if (/面议/.test(banner)) return { pass: false, reason: '薪资面议', toLedger: true }
  const m = SALARY_RE.exec(banner)
  if (!m) return { pass: false, reason: '详情薪资无法解析:' + banner.slice(0, 40), toLedger: false }
  const max = Number(m[2])
  const fail = (reason) => ({ pass: false, reason, salary: m[0], toLedger: true })
  if (max < rules.minSalaryK) return fail('Max ' + max + 'K<' + rules.minSalaryK + 'K')
  if (hardEduRequired(banner, rules.rejectDegrees)) return fail('学历要求 ' + rules.rejectDegrees.join('/'))
  const lang = langRedLine(jd, rules.rejectLanguages)
  if (lang) return fail('主语言要求 ' + lang)
  const titleBad = titleRules(rules).find(([re]) => re.test(String(job.title) + '|' + banner))
  if (titleBad) return fail(titleBad[1] + ':' + job.title)
  if (rules.mustHaveKeywords.length && !rules.mustHaveKeywords.some(k => kwHit(jd, k))) return fail('JD 未命中必含关键词')
  if (rules.outsourcing !== 'allow' && OUTSOURCING_RE.test(String(job.co) + '|' + String(job.title) + '|' + banner + '|' + jd)) {
    if (rules.outsourcing === 'reject') return fail('外包岗位')
    return { pass: false, reason: '外包岗位待判断', salary: m[0], toLedger: false, review: true }
  }
  return { pass: true, reason: 'Max' + max + 'K+画像匹配', salary: m[0] }
}

// 关键词命中：拉丁词整词匹配（Java 不命中 JavaScript、Web 不命中 WebSocket），允许复数；中文子串匹配
const kwRe = new Map()
function kwHit(jd, k) {
  if (!/^[A-Za-z][A-Za-z -]*$/.test(k)) return jd.includes(k)
  if (!kwRe.has(k)) kwRe.set(k, new RegExp('(?<![A-Za-z])' + k.replace(/[-\s]/g, '\\$&') + 's?(?![A-Za-z])', 'i'))
  return kwRe.get(k).test(jd)
}

// own = hook 内独一短语（发送验证用）：去掉开头两字避免通用撞词。点名 hook 与表内 hook 统一走这里。
function ownOf(hook) {
  const h = String(hook || '')
  return h.length > 10 ? h.slice(2, 12) : h
}

// 按 profile.hooks 顺序取第一个命中。单岗闭环里 own 只用于验证当前会话，不要求跨岗唯一
//（跨岗唯一只会让第 N 岗以后退化成兜底文案）。
function makeHook(job, jdText, profile) {
  const p = normalizeProfile(profile)
  const jd = String(jdText || '')
  const hit = p.hooks.find(e => e.keywords.some(k => kwHit(jd, k)))
  if (hit) return { hook: hit.text, own: ownOf(hit.text) }
  // 兜底：own 必须取自 hook 文本内（validateJob 要求 own⊂hook）；公司名进 own 才独一
  const coTag = normCo(job.co).slice(0, 8)
  const hook = p.message.fallbackHook.replace('{co}', coTag)
  const idx = hook.indexOf(coTag)
  const own = coTag && idx >= 0 ? hook.slice(Math.max(0, idx - 1), idx + coTag.length + 1) : ownOf(hook)
  return { hook, own }
}

// 台账派生更新（幂等，按 sameCompany 去重）：
//   applied    ← checkpoint.jsonl 的 VERIFIED 行 + details.jsonl 的 SKIPPED 行（BOSS 显示「继续沟通」= 已投过，
//                典型场景：发送成功后验证阶段抛异常没写 checkpoint，下轮重试才发现已投）
//   eliminated ← details.jsonl 的 ELIMINATED 行（toLedger=false 的岗位级/瞬态淘汰除外）
function updateLedgerFromCheckpoint(ledgerPathArg, checkpointPath, dateStr, detailsPath) {
  // 台账不存在（新机器/外置数据目录首跑）从空表起
  const ledger = fs.existsSync(ledgerPathArg) ? JSON.parse(fs.readFileSync(ledgerPathArg, 'utf8')) : { applied: [], eliminated: [] }
  const readJsonl = (p) => (p && fs.existsSync(p))
    ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch (e) { return null } }).filter(Boolean)
    : []
  const inLedger = (list, co) => list.some(e => sameCompany(e, co))
  let added = 0, addedElim = 0
  const details = readJsonl(detailsPath)
  for (const d of details) {
    if (d.decision === 'ELIMINATED' && d.co && d.reason && d.toLedger !== false && !inLedger(ledger.eliminated, d.co)) {
      ledger.eliminated.push({ co: d.co, reason: d.reason })
      addedElim++
    }
  }
  const appliedRows = [
    ...readJsonl(checkpointPath).filter(r => r.status === 'OK' && r.verify && r.verify.ok).map(r => ({ co: r.co, date: dateStr, title: r.title, url: r.url })),
    ...details.filter(d => d.decision === 'SKIPPED' && d.co).map(d => ({ co: d.co, date: dateStr, title: d.title, url: d.url, via: 'skipped' })),
  ]
  for (const row of appliedRows) {
    if (inLedger(ledger.applied, row.co)) continue
    ledger.applied.push(row)
    added++
  }
  if (added || addedElim) {
    fs.mkdirSync(pathMod.dirname(ledgerPathArg), { recursive: true })
    fs.writeFileSync(ledgerPathArg, JSON.stringify(ledger, null, 2))
  }
  return { added, addedElim, total: ledger.applied.length, totalElim: ledger.eliminated.length }
}

// ---------------- 浏览器流程（heredoc 内使用） ----------------

function makePipeline(h, profileArg) {
  const profile = normalizeProfile(profileArg)
  const rules = profile.rules
  const lib = makeApplyLib(h, profile)

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
  // 不发任何消息；唯一会开的详情页是 1 个用来校验薪资字体映射的（opts.verifySalaryFont=false 关掉）。
  // 列表 URL 带服务端筛选（薪资码由 rules.minSalaryK 派生 + search.experienceCodes），在列表页就把低薪和初级岗砍掉，
  //   实测 6 轮 45 卡里 80% Max≥30K（无过滤时细筛 37% 白开详情页）。
  // queries 缺省 profile.search.queries；maxRounds 缺省 profile.search.maxRounds。
  async function discover(runDir, page, queries, opts = {}) {
    queries = queries && queries.length ? queries : profile.search.queries
    const maxRounds = opts.maxRounds || profile.search.maxRounds
    const stableRounds = opts.stableRounds || 6
    const results = []
    for (const q of queries) {
      const url = listUrl(q, profile.search)
      await page.goto(url)
      await page.waitForLoadState()
      await h.wait(2)
      // 登录预检：有头像节点 且 顶栏没有「登录/注册」入口（游客态页面也可能有 avatar 类名，不能只看类名）
      const loginOk = await h.js(String.raw`(() => {
        const hasUser = !!document.querySelector('.nav-figure, .user-info')
        const nav = document.querySelector('.user-nav, .nav-header, header')
        const guest = nav ? /登录|注册/.test(nav.innerText || '') : false
        return hasUser && !guest
      })()`)
      if (!loginOk) return { ok: false, phase: 'login', error: '登录态失效/游客态：停止粗筛，交 handOff' }
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
    const font = opts.verifySalaryFont === false ? { verified: false, reason: 'skipped' } : await verifySalaryFont(uniq)
    log(runDir, 'discover.log', 'salary-font ' + JSON.stringify(font))
    const f = filterCards(uniq, { rules, appliedCos: ledger.applied, eliminatedCos: ledger.eliminated, decodeSalary: font.verified })
    fs.writeFileSync(pathMod.join(runDir, 'shortlist.json'), JSON.stringify({ at: new Date().toISOString(), search: profile.search, salaryFont: font, kept: f.keep.length, rejected: f.reject.length, keep: f.keep }, null, 1))
    fs.writeFileSync(pathMod.join(runDir, 'coarse-reject.json'), JSON.stringify(f.reject, null, 1))
    return { ok: true, phase: 'discover', results, poolUnique: uniq.length, salaryFont: font, kept: f.keep.length, rejected: f.reject.length }
  }

  // 开 1 个打码卡的详情页，比对「卡片解码薪资」和「详情页真实薪资」。相同 → 本批可用卡级解码。
  async function verifySalaryFont(cards) {
    const sample = cards.find(c => c.url && SALARY_FONT_RE.test(c.salary) && parseSalaryRange(decodeSalaryFont(c.salary)))
    if (!sample) return { verified: false, reason: '无打码样本' }
    const decoded = parseSalaryRange(decodeSalaryFont(sample.salary))
    await h.gotoAndWait(sample.url, { timeout: 20, settle: 2 })
    const banner = await h.js(String.raw`(() => { const b = document.querySelector('.job-banner, .job-title'); return b ? b.innerText.trim() : '' })()`)
    const real = parseSalaryRange(banner)
    if (!real) return { verified: false, reason: '详情页薪资未读到', sample: sample.co }
    const verified = real.min === decoded.min && real.max === decoded.max
    return { verified, sample: sample.co, decoded: decoded.min + '-' + decoded.max + 'K', real: real.min + '-' + real.max + 'K', reason: verified ? 'ok' : '字体映射变了，本批退回留细筛' }
  }

  // ---------- 细筛：单岗闭环 ----------
  // 打开详情 → 规则判定 → 通过则【立即发送】（applyOne+verifyCurrent）→ 当场 append details.jsonl + checkpoint.jsonl。
  // opts.dryRun=true：只判定落盘（decision: DRY_PASS / ELIMINATED），绝不点击、绝不发送——用于上线前只读验证。
  // opts.allowOutsourcing=true：agent 判断过的外包岗放行（跳过 review），用于对 NEEDS_REVIEW 的岗位点名补发。
  async function screenAndSendOne(runDir, job, ctx, opts = {}) {
    await h.gotoAndWait(job.url, { timeout: 20, settle: 2 })
    await h.wait(1.5)
    // 详情页没渲染出来（验证码/慢网）→ 不判定，记 FAILED 留待重试；拿 body 兜底判定会把公司误写进台账淘汰。
    const banner = await h.js(String.raw`(() => { const b = document.querySelector('.job-banner, .job-title'); return b ? b.innerText.trim() : null })()`)
    if (banner === null || banner === undefined) {
      appendJsonl(pathMod.join(runDir, 'details.jsonl'), { co: job.co, title: job.title, url: job.url, decision: 'FAILED', reason: '详情页未加载' })
      return { co: job.co, decision: 'FAILED', reason: '详情页未加载' }
    }
    const jd = await h.js(String.raw`(() => { const s = document.querySelector('.job-sec-text'); return s ? s.innerText.trim().slice(0, 4000) : '' })()`)
    let verdict = evalDetail(job, banner, jd, rules)
    if (verdict.review && opts.allowOutsourcing) verdict = { pass: true, reason: verdict.reason + '(agent放行)', salary: verdict.salary }
    if (verdict.review) {
      appendJsonl(pathMod.join(runDir, 'details.jsonl'), { co: job.co, title: job.title, url: job.url, salary: verdict.salary, decision: 'NEEDS_REVIEW', reason: verdict.reason, jd: jd.slice(0, 600) })
      return { co: job.co, decision: 'NEEDS_REVIEW', reason: verdict.reason }
    }
    if (!verdict.pass) {
      appendJsonl(pathMod.join(runDir, 'details.jsonl'), { co: job.co, title: job.title, url: job.url, salary: verdict.salary || null, decision: 'ELIMINATED', reason: verdict.reason, toLedger: verdict.toLedger !== false })
      return { co: job.co, decision: 'ELIMINATED', reason: verdict.reason }
    }
    // 通过 → 定 hook
    let hook, own
    if (ctx.hooks && ctx.hooks[job.co]) { hook = ctx.hooks[job.co]; own = ownOf(hook) }
    else { const m = makeHook(job, jd, profile); hook = m.hook; own = m.own }
    if (opts.dryRun) {
      appendJsonl(pathMod.join(runDir, 'details.jsonl'), { co: job.co, title: job.title, url: job.url, salary: verdict.salary, decision: 'DRY_PASS', hook })
      return { co: job.co, decision: 'DRY_PASS', salary: verdict.salary, hook }
    }
    // 立即发送
    // 会话定位 key：用完整公司名（去掉卡片截断的「...」），前 4 字会撞同前缀公司发错人。
    const full = { co: job.co, key: job.key || job.convKey || String(job.co).replace(/(\.\.\.|…)$/, ''), title: job.title, hook, own, url: job.url }
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
    // OK→SENT；已投过→SKIPPED（终态不重试）；其余（会话未找到/发送失败/按钮异常）→FAILED（下轮重试，不占 maxSend）
    const decision = sent.status === 'OK' ? 'SENT' : /已投过/.test(sent.status) ? 'SKIPPED' : 'FAILED'
    appendJsonl(pathMod.join(runDir, 'checkpoint.jsonl'), { co: job.co, title: job.title, url: job.url, status: sent.status, secs: sent.secs || null, verify })
    appendJsonl(pathMod.join(runDir, 'details.jsonl'), { co: job.co, title: job.title, url: job.url, salary: verdict.salary, decision, status: sent.status, verifyOk: !!(verify && verify.ok), hook })
    return { co: job.co, decision, status: sent.status, verifyOk: !!(verify && verify.ok) }
  }

  // 断点语义：details.jsonl 里终态 decision 的公司跳过；FAILED/EXCEPTION 下轮重试（applyOne 会用「继续沟通」按钮兜住已发过的）。
  const TERMINAL_DECISIONS = new Set(['SENT', 'SKIPPED', 'ELIMINATED', 'DRY_PASS', 'NEEDS_REVIEW'])
  function readDetails(runDir) {
    try {
      return fs.readFileSync(pathMod.join(runDir, 'details.jsonl'), 'utf8').split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l) } catch (e) { return null } }).filter(Boolean)
    } catch (e) { return [] }
  }

  // ---------- 细筛串行主循环（每轮一个 heredoc，控时 550s 内） ----------
  // order：ctx.hooks 里点名的公司优先；其余按 shortlist 顺序。opts.dryRun 透传给 screenAndSendOne。
  async function screenLoop(runDir, page, opts = {}) {
    const maxSend = opts.maxSend || profile.pacing.maxSendPerRound
    const budgetS = opts.budgetS || profile.pacing.budgetS
    const [ivMin, ivMax] = profile.pacing.sendIntervalS
    const gap = () => Math.max(15, ivMin) + Math.floor(Math.random() * Math.max(0, ivMax - ivMin + 1))   // 下限 15s 写死：防风控不交给配置
    const t0 = Date.now()
    const shortlist = readJson(pathMod.join(runDir, 'shortlist.json'), { keep: [] }).keep
    const details = readDetails(runDir)
    const doneCos = new Set(details.filter(d => TERMINAL_DECISIONS.has(d.decision)).map(d => d.co))
    const hooks = opts.hooks || {}
    const ranked = [
      ...shortlist.filter(j => hooks[j.co]),
      ...shortlist.filter(j => !hooks[j.co]),
    ]
    const ctx = { hooks }
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
          await h.wait(gap()) // 发送间隔，防风控
        } else if (r.decision !== 'FAILED') {
          await h.wait(1.2)
        }
      } catch (e) {
        appendJsonl(pathMod.join(runDir, 'details.jsonl'), { co: job.co, title: job.title, url: job.url, decision: 'FAILED', reason: String(e && e.message || e).slice(0, 200) })
        out.push({ co: job.co, decision: 'EXCEPTION', error: String(e && e.message || e).slice(0, 120) })
      }
    }
    return { sent, elapsedS: Math.round((Date.now() - t0) / 1000), out }
  }

  // agent 判断后对某家外包岗补发：从 details.jsonl 取 NEEDS_REVIEW 记录，放行重跑单岗闭环。
  async function sendReviewed(runDir, co, opts = {}) {
    const rec = readDetails(runDir).filter(d => d.decision === 'NEEDS_REVIEW' && d.co === co).pop()
    if (!rec) return { co, decision: 'FAILED', reason: '无 NEEDS_REVIEW 记录' }
    return screenAndSendOne(runDir, { co: rec.co, title: rec.title, url: rec.url }, { hooks: opts.hooks || {} }, { ...opts, allowOutsourcing: true })
  }

  return { waitFor, log, discover, screenAndSendOne, screenLoop, sendReviewed, lib }
}

module.exports = { makePipeline, filterCards, cardSalaryVerdict, evalDetail, langRedLine, hardEduRequired, sameCompany, normCo, kwHit, makeHook, ownOf, decodeSalaryFont, parseSalaryRange, listUrl, updateLedgerFromCheckpoint, isHeadhunterPost, dataDir, ledgerPath, runDir, DEFAULT_RULES }
