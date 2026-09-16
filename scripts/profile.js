// 用户配置（profile.json）：「身份」和「偏好」全部在这里，代码里只有机制。任何行业、任何城市、应届/实习都能用。
//
// 三层东西分得清：
//   必填 candidate.intro / search.cities / search.queries —— 没有合理默认值，缺了直接拒绝跑（免得拿着别人的身份去投）
//   可选 links / hooks / rules / pacing            —— 缺省「不限」或中性节奏（DEFAULTS），用户按需覆盖；rules 里没有任何行业预设
//   机制（反爬解码、选择器、防风控节奏的下限）     —— 不暴露，在库里
//
// 数据目录（profile / 台账 / 每日 runs）默认 ~/.boss-auto-apply，与代码目录分离：本库以 skill 形式装在
// ~/.agents/skills 下，`npx skills update` 会整目录删掉重拷，个人数据放代码目录里会被抹掉。
// 选 ~/.<name>/ 单目录而不是 XDG 三分（config/data/state）：skills 生态里前者是多数派（~/.hyperframes、~/.baoyu-skills…），
// 且 profile/台账/runs 用户要一起看，拆开反而难找。要换位置用 BOSS_APPLY_DATA。
// 路径：环境变量 BOSS_APPLY_PROFILE > <BOSS_APPLY_DATA 或 ~/.boss-auto-apply>/profile.json。模板见 assets/profile.example.json。
// CLI：node scripts/profile.js init|check|show
const fs = require('fs')
const os = require('os')
const pathMod = require('path')

const REPO_ROOT = pathMod.resolve(__dirname, '..')
const dataDir = () => process.env.BOSS_APPLY_DATA || pathMod.join(os.homedir(), '.boss-auto-apply')
const profilePath = () => process.env.BOSS_APPLY_PROFILE || pathMod.join(dataDir(), 'profile.json')
const EXAMPLE_PATH = pathMod.join(REPO_ROOT, 'assets', 'profile.example.json')

// ---- BOSS 平台编码（外部事实，不是偏好；采集日期 2026-09-16）----
// 列表页服务端筛选码，从页面筛选器 ka=sel-job-rec-* 读出
const SALARY_BANDS = { 402: [0, 3], 403: [3, 5], 404: [5, 10], 405: [10, 20], 406: [20, 50], 407: [50, Infinity] }
const EXPERIENCE_CODES = { 101: '经验不限', 102: '应届生', 108: '在校生', 103: '1年以内', 104: '1-3年', 105: '3-5年', 106: '5-10年', 107: '10年以上' }
// 全部 374 个城市 名→码，来自 BOSS 公开接口 /wapi/zpCommon/data/city.json（assets/boss-cities.json）。
// 用户填城市名或 9 位码都行；表里没有的城市直接填码（BOSS 网页选城市后看 URL 里 city=）。
const CITY_CODES = JSON.parse(fs.readFileSync(pathMod.join(REPO_ROOT, 'assets', 'boss-cities.json'), 'utf8'))
const CITY_NAMES = Object.fromEntries(Object.entries(CITY_CODES).map(([n, c]) => [c, n]))

const DEFAULTS = {
  message: {
    template: '您好，看到贵司在招{title}，很感兴趣。{intro}{hook}，相信可以快速胜任该岗位。\n\n{links}',
    fallbackHook: '仔细读过贵司 JD，与我的经验高度匹配（{co}岗）',
  },
  search: {
    cities: [],                           // 必填：城市名或 9 位码，可多个
    queries: [],                          // 必填：搜索关键词，可多个（不同岗位方向）
    experienceCodes: [],                  // 服务端经验筛选码，空 = 不限；应届 102、在校/实习 108
    maxRounds: 30,
  },
  rules: {
    minSalaryK: 0,                        // 期望最低月薪（K）：「薪资范围能给到」= 区间 Max ≥ 它；0 = 不限（面议/日薪/时薪岗也投）
    blockCompanies: [],                   // 公司名子串黑名单
    rejectDegrees: [],                    // 硬性学历要求红线，如 ['硕士','博士']；「硕士优先/加分」自动豁免
    rejectTitles: [],                     // 标题/标签红线 [{pattern, reason}]，如 [{pattern:'销售|电销', reason:'销售岗'}]；没有行业预设
    rejectLanguages: [],                  // 不接受的主语言（开发岗用），如 ['Go','C++']；标题含它淘汰，JD 当主语言要求淘汰，「加分/优先」豁免
    mustHaveKeywords: [],                 // JD 至少命中一个；空 = 不限
    headhunter: 'reject',                 // reject | allow   猎头挂单（masked 公司名 / 人力机构）；机制原因见 references/rules.md
    outsourcing: 'review',                // review | reject | allow   外包/驻场岗：review = 不投不淘汰，落 NEEDS_REVIEW 交 agent 判断
  },
  pacing: {
    maxSendPerRound: 7,
    sendIntervalS: [20, 35],              // 两次发送之间随机等待（秒），防风控；下限 15 写死在库里
    budgetS: 480,
  },
}

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x)
function merge(base, over) {
  const out = { ...base }
  for (const [k, v] of Object.entries(over || {})) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v
  return out
}

// 由 minSalaryK 推服务端薪资筛选码：某档的上限 ≥ 期望最低才可能有「范围能给到」的岗；0 = 不筛
function salaryCodesFor(minSalaryK) {
  if (!minSalaryK) return []
  return Object.entries(SALARY_BANDS).filter(([, [, hi]]) => hi >= minSalaryK).map(([code]) => Number(code))
}

// 城市：名 → 码；9 位码原样；认不出返回 null
function resolveCity(x) {
  const s = String(x || '').trim()
  if (/^\d{9}$/.test(s)) return s
  return CITY_CODES[s] || null
}
const cityLabel = (code) => (CITY_NAMES[code] ? CITY_NAMES[code] + '(' + code + ')' : code)

function validateProfile(p) {
  const errors = []
  const c = p.candidate || {}
  if (!c.intro || !String(c.intro).trim()) errors.push('candidate.intro 必填：一句自我介绍（年限/方向/能交付什么）')
  for (const l of c.links || []) if (!l || !l.label || !/^https?:\/\//.test(l.url || '')) errors.push('candidate.links 每项要有 label 和 http(s) url：' + JSON.stringify(l))
  if (!Array.isArray(p.hooks)) errors.push('hooks 必须是数组（可为空，空则全部用 message.fallbackHook）')
  for (const h of p.hooks || []) if (!h || !Array.isArray(h.keywords) || !h.keywords.length || !h.text) errors.push('hooks 每项要有 keywords[] 和 text：' + JSON.stringify(h))
  if (!/\{hook\}/.test(p.message.template)) errors.push('message.template 必须含 {hook}')
  if ((c.links || []).length && !/\{links\}/.test(p.message.template)) errors.push('message.template 必须含 {links}（有链接时发送验证靠它）')
  if (!/\{co\}/.test(p.message.fallbackHook)) errors.push('message.fallbackHook 必须含 {co}（保证 own 独一）')
  if (p.search.city) errors.push('search.city 已改为 search.cities（数组，可多城市，填城市名或 9 位码）')
  if (!Array.isArray(p.search.cities) || !p.search.cities.length) errors.push('search.cities 至少一个城市（城市名如「北京」或 9 位码）')
  for (const x of p.search.cities || []) if (!resolveCity(x)) errors.push('search.cities 认不出「' + x + '」：填 assets/boss-cities.json 里的城市名，或 BOSS 网页选城市后 URL 里的 city= 9 位码')
  if (!Array.isArray(p.search.queries) || !p.search.queries.length) errors.push('search.queries 至少一个关键词（想投的岗位名/方向）')
  for (const x of p.search.experienceCodes || []) if (!EXPERIENCE_CODES[x]) errors.push('search.experienceCodes 未知码 ' + x + '，可选：' + JSON.stringify(EXPERIENCE_CODES))
  if (typeof p.rules.minSalaryK !== 'number' || p.rules.minSalaryK < 0) errors.push('rules.minSalaryK 应是数字（K/月），0 = 不限')
  if (p.rules.extraRejectTitles) errors.push('rules.extraRejectTitles 已改为 rules.rejectTitles（不再有固定红线，全部由你决定）')
  if (!Array.isArray(p.rules.rejectTitles)) errors.push('rules.rejectTitles 应是数组 [{pattern, reason}]')
  for (const t of p.rules.rejectTitles || []) {
    if (!t || !t.pattern || !t.reason) { errors.push('rules.rejectTitles 每项要有 pattern 和 reason：' + JSON.stringify(t)); continue }
    try { new RegExp(t.pattern) } catch (e) { errors.push('rules.rejectTitles 正则非法：' + t.pattern) }
  }
  if (!['reject', 'allow'].includes(p.rules.headhunter)) errors.push('rules.headhunter 只能是 reject | allow')
  if (!['review', 'reject', 'allow'].includes(p.rules.outsourcing)) errors.push('rules.outsourcing 只能是 review | reject | allow')
  const iv = p.pacing.sendIntervalS
  if (!Array.isArray(iv) || iv.length !== 2 || iv[0] > iv[1]) errors.push('pacing.sendIntervalS 应是 [min, max] 秒')
  return { ok: errors.length === 0, errors }
}

// 合并默认值 + 派生字段。不做校验，给测试/内嵌用；生产走 loadProfile。
function normalizeProfile(raw) {
  const p = merge(DEFAULTS, raw || {})
  p.candidate = p.candidate || {}
  p.candidate.links = p.candidate.links || []
  p.hooks = p.hooks || []
  p.search.salaryCodes = p.search.salaryCodes || salaryCodesFor(p.rules.minSalaryK)
  p.search.cityCodes = (p.search.cities || []).map(resolveCity).filter(Boolean)   // 派生：库用这个
  return p
}

function loadProfile(file) {
  const f = file || profilePath()
  if (!fs.existsSync(f)) {
    throw new Error('找不到 profile：' + f + '\n按 SKILL.md「首次使用」引导用户建好再跑；或设 BOSS_APPLY_PROFILE 指向你的文件。')
  }
  const p = normalizeProfile(JSON.parse(fs.readFileSync(f, 'utf8')))
  const v = validateProfile(p)
  if (!v.ok) throw new Error('profile 不合法（' + f + '）：\n - ' + v.errors.join('\n - '))
  return p
}

function summarize(p) {
  const r = p.rules
  const list = (a, empty) => (a && a.length ? a.join('/') : empty)
  return [
    '自我介绍：' + p.candidate.intro,
    '链接：' + (p.candidate.links.length ? p.candidate.links.map(l => l.label + ' ' + l.url).join('，') : '无'),
    'hook 条数：' + p.hooks.length + '（兜底：' + p.message.fallbackHook + '）',
    '城市：' + p.search.cityCodes.map(cityLabel).join('、') + '  关键词：' + p.search.queries.join(' / ') + '  经验：' + list((p.search.experienceCodes || []).map(c => EXPERIENCE_CODES[c]), '不限'),
    '薪资线：' + (r.minSalaryK ? 'Max ≥ ' + r.minSalaryK + 'K（服务端筛选码 ' + p.search.salaryCodes.join(',') + '）' : '不限（面议/日薪岗也投）'),
    '黑名单：' + list(r.blockCompanies, '无'),
    '语言红线：' + list(r.rejectLanguages, '无') + '  学历红线：' + list(r.rejectDegrees, '无'),
    '岗位红线：' + list(r.rejectTitles.map(t => t.reason), '无'),
    'JD 必含：' + list(r.mustHaveKeywords, '不限'),
    '猎头：' + r.headhunter + '  外包：' + r.outsourcing,
    '节奏：每轮最多 ' + p.pacing.maxSendPerRound + ' 发，间隔 ' + p.pacing.sendIntervalS.join('-') + 's，预算 ' + p.pacing.budgetS + 's',
  ].join('\n')
}

module.exports = { DEFAULTS, CITY_CODES, EXPERIENCE_CODES, SALARY_BANDS, EXAMPLE_PATH, dataDir, profilePath, salaryCodesFor, resolveCity, cityLabel, normalizeProfile, validateProfile, loadProfile, summarize }

if (require.main === module) {
  const cmd = process.argv[2]
  const target = profilePath()
  if (cmd === 'init') {
    if (fs.existsSync(target)) { console.error('已存在，不覆盖：' + target); process.exit(1) }
    fs.mkdirSync(pathMod.dirname(target), { recursive: true })
    fs.copyFileSync(EXAMPLE_PATH, target)
    console.log('已生成 ' + target + '\n把里面的示例身份换成你自己的，然后 node scripts/profile.js check')
  } else if (cmd === 'check' || cmd === 'show') {
    try {
      const p = loadProfile()
      console.log('OK ' + target + '\n' + summarize(p))
    } catch (e) { console.error(e.message); process.exit(1) }
  } else {
    console.log('用法：node scripts/profile.js init | check | show')
  }
}
