// BOSS直聘批量投递 runner：统一预检、断点、发送、当前会话验证。
// 只在 ego-browser heredoc 内 require；h 为 {js,click,wait,gotoAndWait,pageInfo}。
const fs = require('fs')
const makeApplyLib = require('./batch_apply_lib.js')

function makeRunner(h) {
  const lib = makeApplyLib(h)

  function readJsonLines(path) {
    if (!fs.existsSync(path)) return []
    return fs.readFileSync(path, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  }

  function completedCompanies(checkpointPath) {
    return new Set(readJsonLines(checkpointPath)
      .filter(r => r.status === 'OK' && r.verify && r.verify.ok)
      .map(r => r.co))
  }

  function appendCheckpoint(path, record) {
    fs.mkdirSync(require('path').dirname(path), { recursive: true })
    fs.appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n')
  }

  // 一个批次只做两类状态：OK（可安全跳过）/非OK（下次明确重试）。
  async function runBatch(jobs, checkpointPath, options = {}) {
    const max = options.max || jobs.length
    const preflight = lib.validateBatch(jobs)
    if (!preflight.ok) return { ok: false, phase: 'preflight', errors: preflight.errors, results: [] }

    const done = completedCompanies(checkpointPath)
    const todo = jobs.filter(j => !done.has(j.co)).slice(0, max)
    const results = []
    for (const job of todo) {
      let record
      try {
        const sent = await lib.applyOne(job, lib.makeMsg(job.title, job.hook))
        let verify = { ok: false, skipped: true }
        if (sent.status === 'OK') {
          verify = await lib.verifyCurrent(job)
          // DOM 瞬态渲染时仅重验一次；不重新发送，避免重复消息。
          if (!verify.ok) {
            await h.wait(1.2)
            verify = await lib.verifyCurrent(job)
          }
        }
        record = { co: job.co, title: job.title, url: job.url, status: sent.status, secs: sent.secs || null, verify }
      } catch (e) {
        record = { co: job.co, title: job.title, url: job.url, status: 'EXCEPTION', error: String(e && e.message || e).slice(0, 300), verify: { ok: false } }
      }
      appendCheckpoint(checkpointPath, record)
      results.push(record)
    }
    return {
      ok: true,
      phase: 'complete',
      requested: jobs.length,
      attempted: todo.length,
      skippedCompleted: jobs.length - todo.length,
      success: results.filter(r => r.status === 'OK' && r.verify.ok).length,
      failed: results.filter(r => !(r.status === 'OK' && r.verify.ok)).length,
      results,
    }
  }

  return { readJsonLines, completedCompanies, appendCheckpoint, runBatch }
}
module.exports = makeRunner
