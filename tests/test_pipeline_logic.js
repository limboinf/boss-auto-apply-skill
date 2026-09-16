const assert = require('assert')
const fs = require('fs')
const cp = '/tmp/boss-apply-state-store-test.jsonl'
try { fs.unlinkSync(cp) } catch (_) {}

const makeLib = require('../scripts/batch_apply_lib.js')
const lib = makeLib({
  js: async () => { throw new Error('pure logic test called browser') },
  click: async () => { throw new Error('pure logic test called browser') },
  wait: async () => { throw new Error('pure logic test called browser') },
  gotoAndWait: async () => { throw new Error('pure logic test called browser') },
  pageInfo: async () => { throw new Error('pure logic test called browser') },
})
const { canTransition, makeStore } = require('../scripts/state_store.js')
const valid = { co: '北京万联易达互联科技', key: '万联', title: 'Agent', hook: '独一hook短语', own: '独一hook短语', url: 'https://www.zhipin.com/job_detail/x.html' }

// schema: every required field rejects undefined/blank/non-string
for (const field of ['co', 'key', 'title', 'hook', 'own', 'url']) {
  for (const bad of [undefined, '', '  ', 1, null]) assert.equal(lib.validateJob({ ...valid, [field]: bad }).ok, false, field)
}
assert.equal(lib.parseSalary('岗位 30-60K·15薪').max, 60)
assert.equal(lib.parseSalary('薪资面议'), null)
assert.equal(lib.isSalaryEligible('20-35K'), true)
assert.equal(lib.isSalaryEligible('20-50K'), true)
assert.equal(lib.isSalaryEligible('29-60K'), true)
assert.equal(lib.isSalaryEligible('30-35K'), true)
assert.equal(lib.isSalaryEligible('35-60K'), true)
assert.equal(lib.isSalaryEligible('19-50K'), true)
assert.equal(lib.isSalaryEligible('30-30K'), true)
assert.equal(lib.isSalaryEligible('29-29K'), false)
assert.equal(lib.isSalaryEligible('薪资面议'), false)
assert.equal(lib.isDuplicateCompany('北京万联易达互联科技', ['万联易达']), true)
assert.equal(lib.isDuplicateCompany('甲公司', ['乙公司']), false)

assert.equal(canTransition(null, 'DISCOVERED'), true)
assert.equal(canTransition('DRAFT_FILLED', 'SENT'), true)
assert.equal(canTransition('VERIFIED', 'READY'), false)
const store = makeStore(cp, 'test-run')
for (const s of ['DISCOVERED', 'VALIDATED', 'READY', 'OPENED', 'CONTACT_CLICKED', 'CHAT_READY', 'CONVERSATION_CONFIRMED', 'DRAFT_FILLED', 'SENT', 'VERIFIED']) store.append(valid, s)
assert.equal(store.stateOf(valid).state, 'VERIFIED')
assert.equal(store.pending([valid]).length, 0)
assert.throws(() => store.append(valid, 'READY'), /invalid transition/)
console.log('PASS: 47 pure pipeline regressions')
