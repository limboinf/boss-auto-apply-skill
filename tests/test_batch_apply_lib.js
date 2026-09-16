// 离线回归：不启动浏览器、不发送消息
const assert = require('assert')
const makeLib = require('../scripts/batch_apply_lib.js')
const lib = makeLib({})

const good = {
  co: '测试公司', key: '测试', title: 'AI Agent 工程师',
  hook: '这里有一个唯一钩子短语', own: '唯一钩子短语',
  url: 'https://www.zhipin.com/job_detail/test.html',
}

assert.deepEqual(lib.validateJob(good), { ok: true })
assert.equal(lib.validateJob({ ...good, url: '' }).ok, false, '必须拦截漏url')
assert.equal(lib.validateJob({ ...good, own: '不存在的短语' }).ok, false, '必须拦截own不在hook')
assert.equal(lib.validateJob({ ...good, url: 'https://example.com/x' }).ok, false, '必须拦截非BOSS详情URL')
assert.equal(lib.validateBatch([good, { ...good, co: '测试公司2', key: '测试2' }]).ok, false, '必须拦截own重复')
assert.equal(lib.validateBatch([good, { ...good, co: '测试公司2', key: '测试2', own: '另一唯一短语', hook: '另一唯一短语' }]).ok, true)

const msg = lib.makeMsg('AI Agent 工程师', '钩子')
assert(msg.includes('个人网站：https://limbo101.win\nGitHub：https://github.com/limboinf'), '完整GitHub必须紧邻个人网站')
assert(!msg.includes('GitHub：https://limboinf\n'), '残缺GitHub不得出现')
console.log('PASS: 7 offline regressions')
