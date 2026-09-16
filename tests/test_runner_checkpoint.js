// runner 离线回归：模拟 browser helpers，不触发真实 BOSS。
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const makeRunner = require('../scripts/batch_apply_runner_lib.js')
const cp = '/tmp/boss-apply-runner-test.jsonl'
try { fs.unlinkSync(cp) } catch (_) {}
const jobs = [
  { co: '甲公司', key: '甲', title: 'Agent', hook: '甲钩子', own: '甲钩子', url: 'https://www.zhipin.com/job_detail/a.html' },
  { co: '乙公司', key: '乙', title: 'Agent', hook: '乙钩子', own: '乙钩子', url: 'https://www.zhipin.com/job_detail/b.html' },
]
let sent = 0
const h = {
  wait: async () => {},
  gotoAndWait: async () => {}, pageInfo: async () => ({ url: '' }), click: async () => {},
  js: async () => '',
}
const runner = makeRunner(h)
// 覆盖真实浏览器库方法，仅验证runner checkpoint语义
const original = require('../scripts/batch_apply_lib.js')
assert.equal(runner.completedCompanies(cp).size, 0)
runner.appendCheckpoint(cp, { co: '甲公司', status: 'OK', verify: { ok: true } })
assert(runner.completedCompanies(cp).has('甲公司'))
assert.equal(runner.completedCompanies(cp).size, 1)
assert.equal(runner.completedCompanies(cp).has('乙公司'), false)
console.log('PASS: runner checkpoint resume semantics')
