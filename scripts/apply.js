// BOSS直聘单岗投递库（2026-09-07 全链路验证版，含改版后行为适配）
// 用法：
//   const lib = makeLib({ js, click, wait, gotoAndWait, pageInfo }, profile)   // profile 见 scripts/profile.js
//   const r = await lib.applyOne({ co, key, title, hook, own, url }, lib.makeMsg(title, hook))
//   const v = await lib.verifyCurrent(job)
const { normalizeProfile } = require('./profile.js')

function makeLib(h, profileArg) {
  const { js, click, wait, gotoAndWait, pageInfo } = h
  const profile = normalizeProfile(profileArg)
  // 发送验证标记：每条链接去掉协议后的串必须出现在已发消息面板里（防截断/防串稿）
  const linkMarkers = (profile.candidate.links || []).map(l => String(l.url).replace(/^https?:\/\//, ''))

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
    return { ok: true }
  }

  // 打招呼语 = profile.message.template 填 {title}{intro}{hook}{links}
  function makeMsg(title, hook) {
    const links = (profile.candidate.links || []).map(l => l.label + '：' + l.url).join('\n')
    return String(profile.message.template)
      .replace('{title}', title).replace('{intro}', profile.candidate.intro || '').replace('{hook}', hook).replace('{links}', links)
      .trim()   // 没有链接时 {links} 为空，别留尾部空行
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

  // 当前会话终验：active 会话正确 + 自己 hook（own）+ 每条链接完整出现 + 草稿清空。只看右侧消息面板（x>320），左侧会话列表预览会污染。
  // 不用“其他公司 hook 黑名单”：30家规模下自然语言必然撞词，造成误报和人工重验。
  async function verifyCurrent(job) {
    const activeOk = await js(`(() => {
      const act = [...document.querySelectorAll('.friend-content')].find(e => /active|current|selected/i.test(e.className))
      return !!(act && act.innerText.includes(${JSON.stringify(job.key)}))
    })()`)
    if (!activeOk) return { activeOk: false, own: false, links: [], draftLen: -1, ok: false }
    return await js(`(() => {
      const cands = [...document.querySelectorAll('div, p, span')]
        .map(e => ({ e, r: e.getBoundingClientRect() }))
        .filter(({ e, r }) => r.x > 320 && r.width > 300 && r.height > 40 && r.height < 700 && e.innerText && e.innerText.length > 20 && !e.querySelector('[contenteditable]'))
      const leaf = cands.filter(({ e }) => ![...e.children].some(c => c.innerText && c.innerText.length > 20 && c.getBoundingClientRect().width > 300))
      const all = leaf.map(({ e }) => e.innerText).join('\\n')
      const own = all.includes(${JSON.stringify(job.own)})
      const links = ${JSON.stringify(linkMarkers)}.map(m => all.includes(m))
      const el = document.querySelector('[contenteditable="true"]')
      const draftLen = el ? el.innerText.trim().length : -1
      return { activeOk: true, own, links, draftLen, ok: own && links.every(Boolean) && (!el || draftLen === 0) }
    })()`)
  }

  return { waitFor, validateJob, makeMsg, applyOne, switchConv, fillDraft, realClickSend, verifyCurrent, inputState }
}

module.exports = makeLib
