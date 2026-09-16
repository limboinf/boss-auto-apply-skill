// 用户配置（profile.json）：把「身份」和「偏好」从代码里拿出来，别人 clone 即可按自己的情况投。
//
// 三层东西分得清：
//   身份 candidate/message/hooks —— 没有合理默认值，必须由用户提供，缺了直接拒绝跑（免得拿着别人的自我介绍去投）
//   偏好 search/rules/pacing     —— 有中性默认值（DEFAULTS），用户按需覆盖
//   机制（反爬解码、选择器、防风控节奏的下限）—— 不暴露，在库里
//
// 路径：环境变量 BOSS_APPLY_PROFILE > <BOSS_APPLY_DATA 或 repo/data>/profile.json。模板见 templates/profile.example.json。
// CLI：node scripts/profile.js init|check|show
const fs = require('fs')
const pathMod = require('path')

const REPO_ROOT = pathMod.resolve(__dirname, '..')
const dataDir = () => process.env.BOSS_APPLY_DATA || pathMod.join(REPO_ROOT, 'data')
const profilePath = () => process.env.BOSS_APPLY_PROFILE || pathMod.join(dataDir(), 'profile.json')
const EXAMPLE_PATH = pathMod.join(REPO_ROOT, 'templates', 'profile.example.json')

// BOSS 列表页服务端筛选码（从页面筛选器 ka=sel-job-rec-* 读出，2026-09-16）
const SALARY_BANDS = { 402: [0, 3], 403: [3, 5], 404: [5, 10], 405: [10, 20], 406: [20, 50], 407: [50, Infinity] }
const EXPERIENCE_CODES = { 101: '经验不限', 103: '1年以内', 104: '1-3年', 105: '3-5年', 106: '5-10年', 107: '10年以上' }
const CITY_CODES = { 北京: '101010100', 上海: '101020100', 广州: '101280100', 深圳: '101280600', 杭州: '101210100', 成都: '101270100', 南京: '101190100', 武汉: '101200100', 西安: '101110100', 苏州: '101190400' }

// 找开发岗的人没人想要的 4 条，固定生效、不可配。岗位类型（产品/测试/运维/讲师…）因人而异，放 extraRejectTitles 让用户自己加。
const BASE_REJECT_TITLES = [
  { pattern: '实习|校招|应届|2[5-9]届', reason: '实习/校招/应届' },
  { pattern: '储备|管培', reason: '储备/管培岗' },
  { pattern: '销售|电销', reason: '销售岗' },
  { pattern: '客服', reason: '客服岗' },
]

const DEFAULTS = {
  message: {
    template: '您好，看到贵司在招{title}，很感兴趣。{intro}{hook}，相信可以快速胜任该岗位。\n\n{links}',
    fallbackHook: '仔细读过贵司 JD，与我的经验高度匹配（{co}岗）',
  },
  search: {
    city: CITY_CODES.北京,
    queries: ['Agent', 'AI Agent', '智能体', '大模型应用开发', 'LLM'],
    experienceCodes: [105, 106, 107],
    maxRounds: 30,
  },
  rules: {
    minSalaryK: 30,                       // 「薪资范围能给到这个数」= 区间 Max ≥ 它
    blockCompanies: [],                   // 公司名子串黑名单（大厂/不想投的）
    rejectDegrees: ['硕士', '博士'],       // 硬性学历要求；「硕士优先/加分」自动豁免
    extraRejectTitles: [],                // 追加的标题/标签红线 [{pattern, reason}]；BASE_REJECT_TITLES 那 4 条永远生效，这里只加不减
    rejectLanguages: ['Go', 'C++', 'Rust', 'PHP', 'C#'],   // 标题含它 / JD 把它当主语言要求 → 淘汰；「加分/优先/可选」豁免
    mustHaveKeywords: ['AI', 'Agent', 'Agentic', 'LLM', 'AIGC', 'RAG', '智能体', '大模型', '多模态', '机器学习', '深度学习'],  // JD 至少命中一个；空数组 = 不限
    headhunter: 'reject',                 // reject | allow   猎头挂单（masked 公司名 / 人力机构）
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

// 由 minSalaryK 推服务端薪资筛选码：某档的上限 ≥ 期望最低才可能有「范围能给到」的岗
function salaryCodesFor(minSalaryK) {
  if (!minSalaryK) return []
  return Object.entries(SALARY_BANDS).filter(([, [, hi]]) => hi >= minSalaryK).map(([code]) => Number(code))
}

function validateProfile(p) {
  const errors = []
  const c = p.candidate || {}
  if (!c.intro || !String(c.intro).trim()) errors.push('candidate.intro 必填：一句自我介绍（年限/方向/能交付什么）')
  if (!Array.isArray(c.links) || !c.links.length) errors.push('candidate.links 至少一条：{label, url}，发送后按 url 做验证')
  for (const l of c.links || []) if (!l || !l.label || !/^https?:\/\//.test(l.url || '')) errors.push('candidate.links 每项要有 label 和 http(s) url：' + JSON.stringify(l))
  if (!Array.isArray(p.hooks)) errors.push('hooks 必须是数组（可为空，空则全部用 message.fallbackHook）')
  for (const h of p.hooks || []) if (!h || !Array.isArray(h.keywords) || !h.keywords.length || !h.text) errors.push('hooks 每项要有 keywords[] 和 text：' + JSON.stringify(h))
  if (!/\{hook\}/.test(p.message.template)) errors.push('message.template 必须含 {hook}')
  if (!/\{links\}/.test(p.message.template)) errors.push('message.template 必须含 {links}（发送验证靠它）')
  if (!/\{co\}/.test(p.message.fallbackHook)) errors.push('message.fallbackHook 必须含 {co}（保证 own 独一）')
  if (!/^\d{9}$/.test(String(p.search.city))) errors.push('search.city 应是 9 位 BOSS 城市码，如北京 101010100（打开 BOSS 选城市后看 URL 里的 city=）')
  if (!Array.isArray(p.search.queries) || !p.search.queries.length) errors.push('search.queries 至少一个关键词')
  for (const x of p.search.experienceCodes || []) if (!EXPERIENCE_CODES[x]) errors.push('search.experienceCodes 未知码 ' + x + '，可选：' + JSON.stringify(EXPERIENCE_CODES))
  if (typeof p.rules.minSalaryK !== 'number' || p.rules.minSalaryK < 0) errors.push('rules.minSalaryK 应是数字（K/月），0 = 不限')
  if (p.rules.rejectTitles) errors.push('rules.rejectTitles 已改名：基础 4 条固定生效，追加的写到 rules.extraRejectTitles')
  for (const t of p.rules.extraRejectTitles) {
    if (!t || !t.pattern || !t.reason) { errors.push('rules.extraRejectTitles 每项要有 pattern 和 reason：' + JSON.stringify(t)); continue }
    try { new RegExp(t.pattern) } catch (e) { errors.push('rules.extraRejectTitles 正则非法：' + t.pattern) }
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
  p.hooks = p.hooks || []
  p.search.salaryCodes = p.search.salaryCodes || salaryCodesFor(p.rules.minSalaryK)
  p.rules.allRejectTitles = [...BASE_REJECT_TITLES, ...(p.rules.extraRejectTitles || [])]   // 派生：库用这个
  return p
}

function loadProfile(file) {
  const f = file || profilePath()
  if (!fs.existsSync(f)) {
    throw new Error('找不到 profile：' + f + '\n先跑 `node scripts/profile.js init` 从模板生成，再按 SKILL.md「首次使用」填好；或设 BOSS_APPLY_PROFILE 指向你的文件。')
  }
  const p = normalizeProfile(JSON.parse(fs.readFileSync(f, 'utf8')))
  const v = validateProfile(p)
  if (!v.ok) throw new Error('profile 不合法（' + f + '）：\n - ' + v.errors.join('\n - '))
  return p
}

function summarize(p) {
  return [
    '自我介绍：' + p.candidate.intro,
    '链接：' + p.candidate.links.map(l => l.label + ' ' + l.url).join('，'),
    'hook 条数：' + p.hooks.length + '（兜底：' + p.message.fallbackHook + '）',
    '城市：' + p.search.city + '  关键词：' + p.search.queries.join(' / ') + '  经验：' + (p.search.experienceCodes || []).map(c => EXPERIENCE_CODES[c]).join('/'),
    '薪资线：Max ≥ ' + p.rules.minSalaryK + 'K（服务端筛选码 ' + p.search.salaryCodes.join(',') + '）',
    '黑名单：' + (p.rules.blockCompanies.length ? p.rules.blockCompanies.join('、') : '无'),
    '语言红线：' + p.rules.rejectLanguages.join('/') + '  学历红线：' + p.rules.rejectDegrees.join('/'),
    '岗位红线：固定 ' + BASE_REJECT_TITLES.map(t => t.reason).join('/') + (p.rules.extraRejectTitles.length ? '  + 追加 ' + p.rules.extraRejectTitles.map(t => t.reason).join('/') : '  （无追加）'),
    'JD 必含：' + (p.rules.mustHaveKeywords.length ? p.rules.mustHaveKeywords.join('/') : '不限'),
    '猎头：' + p.rules.headhunter + '  外包：' + p.rules.outsourcing,
    '节奏：每轮最多 ' + p.pacing.maxSendPerRound + ' 发，间隔 ' + p.pacing.sendIntervalS.join('-') + 's，预算 ' + p.pacing.budgetS + 's',
  ].join('\n')
}

module.exports = { DEFAULTS, BASE_REJECT_TITLES, CITY_CODES, EXPERIENCE_CODES, SALARY_BANDS, EXAMPLE_PATH, dataDir, profilePath, salaryCodesFor, normalizeProfile, validateProfile, loadProfile, summarize }

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
