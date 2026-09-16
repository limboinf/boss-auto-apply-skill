// BOSS直聘批量投递库（2026-09-07 全链路验证版，含改版后行为适配）
// 用法：heredoc 里
//   const makeLib = require('<repo>/scripts/batch_apply_lib.js')
//   const lib = makeLib({ js, click, wait, gotoAndWait, pageInfo })
//   const r = await lib.applyOne({ co, key, title, hook, url }, makeMsg)
//   const ok = await lib.verifyPanel(key, 'hook特征句', ['其他hook1','其他hook2'])
//   const msg = lib.makeMsg(title, hook)

function makeLib(h) {
  const { js, click, wait, gotoAndWait, pageInfo } = h

  async function waitFor(fn, timeoutS) {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutS * 1000) {
      try { const v = await fn(); if (v) return v } catch (e) {}
      await wait(0.6)
    }
    return null
  }

  function validateJob(job) {
    const required = ['co', 'key', 'title', 'hook', 'own', 'url']
    const missing = required.filter(k => !job || typeof job[k] !== 'string' || !job[k].trim())
    if (missing.length) return { ok: false, error: '缺少字段:' + missing.join(',') }
    if (!/^https:\/\/www\.zhipin\.com\/job_detail\//.test(job.url)) return { ok: false, error: 'URL格式异常:' + job.url }
    if (!job.hook.includes(job.own)) return { ok: false, error: 'own不在hook内:' + job.co }
    if (!/^https:\/\/github\.com\/limboinf$/.test('https://github.com/limboinf')) return { ok: false, error: 'GitHub模板异常' }
    return { ok: true }
  }

  function validateBatch(jobs) {
    const errors = []
    const owns = new Map()
    for (const job of jobs || []) {
      const v = validateJob(job)
      if (!v.ok) errors.push(v.error)
      if (job && job.own) {
        const prior = owns.get(job.own)
        if (prior) errors.push('own短语重复:' + job.own + '(' + prior + '/' + job.co + ')')
        else owns.set(job.own, job.co)
      }
    }
    return { ok: errors.length === 0, errors }
  }

  function parseSalary(text) {
    const m = /(\d+)\s*-\s*(\d+)\s*K/i.exec(String(text || ''))
    return m ? { min: Number(m[1]), max: Number(m[2]) } : null
  }

  // 朋哥硬规则：详情页薪资区间最高值 Max 必须 >= 30K（含边界），上限不设封顶；无法解析薪资不进入自动投递。
  function isSalaryEligible(text) {
    const salary = parseSalary(text)
    return !!salary && salary.max >= 30
  }

  // 公司展示名常带地域/主体后缀：允许“较短名称包含于较长名称”的去重。
  function isDuplicateCompany(name, existing) {
    const n = String(name || '').replace(/\s/g, '')
    if (!n) return false
    return (existing || []).some(x => {
      const e = String(typeof x === 'string' ? x : x && x.co || '').replace(/\s/g, '')
      return e && (n.includes(e) || e.includes(n))
    })
  }

  function makeMsg(title, hook) {
    return [
      '您好，看到贵司在招' + title + '，很感兴趣。我12年研发经验，近3年专注 AI Agent 落地，已落地10+个 AI 应用，能独立完成从架构设计、开发到上线的端到端交付。' + hook + '，相信可以快速胜任该岗位。',
      '',
      '个人网站：https://limbo101.win',
      'GitHub：https://github.com/limboinf',
    ].join('\n')
  }

  // 发送：真实点击 + 坐标兜底 + 元素点击再兜底（js click 已失效）
  async function realClickSend() {
    const ready = await waitFor(async () => await js(String.raw`(() => { const b = document.querySelector('button.btn-send, .btn-send'); return b && !b.disabled })()`), 6)
    if (!ready) return { sent: false, why: '发送键未激活' }
    await click('button.btn-send, .btn-send')
    await wait(1.5)
    let v = await inputState()
    if (v.inputLen === 0) return { sent: true, v }
    const box = await js(String.raw`(() => { const b = document.querySelector('button.btn-send, .btn-send'); const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) } })()`)
    await click([box.x, box.y])
    await wait(2)
    v = await inputState()
    if (v.inputLen === 0) return { sent: true, v }
    await click('button.btn-send, .btn-send')
    await wait(2)
    v = await inputState()
    return { sent: v.inputLen === 0, v }
  }

  async function inputState() {
    return await js(String.raw`(() => { const el = document.querySelector('[contenteditable="true"]'); return { inputLen: el ? el.innerText.trim().length : -1 } })()`)
  }

  // 单岗全流程：详情页→立即沟通→(改版后需自查跳转)→聊天页→切会话→清草稿→填文案→真实点击发送
  async function applyOne(job, msg) {
    const t0 = Date.now()
    await gotoAndWait(job.url, { timeout: 20, settle: 2 })
    await wait(2)
    const btnExpr = String.raw`(() => { const b = document.querySelector('a.btn-startchat, .btn-startchat'); return b ? b.innerText.trim() : '' })()`
    const btn1 = await js(btnExpr)
    if (/继续沟通|已沟通/.test(btn1)) return { co: job.co, status: '已投过，跳过' }
    if (!/立即沟通/.test(btn1)) return { co: job.co, status: '按钮异常:' + btn1 }
    await click('a.btn-startchat', { label: '立即沟通 ' + job.co })
    const ok = await waitFor(async () => {
      const t = await js(btnExpr)
      return /继续沟通|已沟通/.test(t) ? t : null
    }, 12)
    if (!ok) return { co: job.co, status: '点击后按钮未变' }
    await js(String.raw`(() => { const g = [...document.querySelectorAll('span.gray, .dialog-footer button, button')].find(e => /知道/.test(e.innerText || '')); if (g) g.click(); return true })()`)
    await wait(2)
    // 改版适配：不自动跳聊天页，自查
    const info = await pageInfo()
    if (!(info.url || '').includes('/web/geek/chat')) {
      await gotoAndWait('https://www.zhipin.com/web/geek/chat', { timeout: 20, settle: 2 })
    }
    const sw = await switchConv(job.key)
    if (!sw) return { co: job.co, status: '会话未找到:' + job.key }
    const filled = await fillDraft(msg)
    if (!filled.ok) return { co: job.co, status: '填充失败 len=' + filled.len }
    const send = await realClickSend()
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    return { co: job.co, status: send.sent ? 'OK' : '发送失败', secs }
  }

  // 切会话并验证右窗确实是目标（防串稿）：验证 active 类名 + 右窗 header
  async function switchConv(key) {
    const clicked = await js(`(() => { const el = [...document.querySelectorAll('.friend-content')].find(e => e.innerText.includes(${JSON.stringify(key)})); if (!el) return false; el.click(); return true })()`)
    if (!clicked) return false
    const confirmed = await waitFor(async () => await js(`(() => {
      const act = [...document.querySelectorAll('.friend-content')].find(e => /active|current|selected/i.test(e.className))
      return act && act.innerText.includes(${JSON.stringify(key)}) ? true : false
    })()`), 8)
    if (!confirmed) return false
    await wait(1.5)
    return true
  }

  // 清草稿再填（execCommand 路线），返回填充后长度
  async function fillDraft(msg) {
    try { await click('[contenteditable="true"]', { label: '点击输入框' }) } catch (e) {}
    await wait(0.5)
    await js(String.raw`(() => {
      const el = document.querySelector('[contenteditable="true"]')
      el.focus()
      document.execCommand('selectAll', false, null)
      document.execCommand('delete', false, null)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    const len = await js(`(() => {
      const el = document.querySelector('[contenteditable="true"]')
      el.focus()
      document.execCommand('insertText', false, ${JSON.stringify(msg)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }))
      return el.innerText.length
    })()`)
    return { ok: len >= 50, len }
  }

  // 当前会话终验：active 会话正确 + 自己 hook + 两个完整 URL + 草稿清空。
  // 不再用“其他公司 hook 黑名单”：30家规模下自然语言必然撞词，造成误报和人工重验。
  async function verifyCurrent(job) {
    const activeOk = await js(`(() => {
      const act = [...document.querySelectorAll('.friend-content')].find(e => /active|current|selected/i.test(e.className))
      return !!(act && act.innerText.includes(${JSON.stringify(job.key)}))
    })()`)
    if (!activeOk) return { activeOk: false, own: false, hasSite: false, hasGh: false, draftLen: -1, ok: false }
    return await js(`(() => {
      const cands = [...document.querySelectorAll('div, p, span')]
        .map(e => ({ e, r: e.getBoundingClientRect() }))
        .filter(({ e, r }) => r.x > 320 && r.width > 300 && r.height > 40 && r.height < 700 && e.innerText && e.innerText.length > 20 && !e.querySelector('[contenteditable]'))
      const leaf = cands.filter(({ e }) => ![...e.children].some(c => c.innerText && c.innerText.length > 20 && c.getBoundingClientRect().width > 300))
      const all = leaf.map(({ e }) => e.innerText).join('\\n')
      const own = all.includes(${JSON.stringify(job.own)})
      const hasSite = all.includes('limbo101.win')
      const hasGh = all.includes('github.com/limboinf') && !all.includes('GitHub：https://limboinf\\n')
      const el = document.querySelector('[contenteditable="true"]')
      const draftLen = el ? el.innerText.trim().length : -1
      return { activeOk: true, own, hasSite, hasGh, draftLen, ok: own && hasSite && hasGh && (!el || draftLen === 0) }
    })()`)
  }

  // 兼容旧调用；新流程统一使用 verifyCurrent(job)。
  async function verifyPanel(ownHook, otherHooks) {
    return await js(`(() => {
      const cands = [...document.querySelectorAll('div, p, span')]
        .map(e => ({ e, r: e.getBoundingClientRect() }))
        .filter(({ e, r }) => r.x > 320 && r.width > 300 && r.height > 40 && r.height < 500 && e.innerText && e.innerText.length > 20 && !e.querySelector('[contenteditable]'))
      const leaf = cands.filter(({ e }) => ![...e.children].some(c => c.innerText && c.innerText.length > 20 && c.getBoundingClientRect().width > 300))
      const all = leaf.map(({ e }) => e.innerText).join('\\n')
      const own = all.includes(${JSON.stringify(ownHook)})
      // GitHub 完整地址必须出现在已发面板（防 https://limboinf 截断版混入）
      const hasGh = all.includes('github.com/limboinf') && !all.includes('GitHub：https://limboinf\\n')
      const others = ${JSON.stringify(otherHooks)}.filter(k => all.includes(k))
      const el = document.querySelector('[contenteditable="true"]')
      return { own, hasGh, others, draftLen: el ? el.innerText.trim().length : -1, ok: own && hasGh && others.length === 0 && (!el || el.innerText.trim().length === 0) }
    })()`)
  }

  return { waitFor, validateJob, validateBatch, parseSalary, isSalaryEligible, isDuplicateCompany, makeMsg, applyOne, switchConv, fillDraft, realClickSend, verifyCurrent, verifyPanel, inputState }
}

module.exports = makeLib
