// 离线回归：不启动浏览器、不发送消息
const assert = require('assert')
const makeLib = require('../scripts/apply.js')
const { loadProfile, EXAMPLE_PATH } = require('../scripts/profile.js')
const profile = loadProfile(EXAMPLE_PATH)
const lib = makeLib({}, profile)

const good = {
  co: '测试公司', key: '测试', title: 'AI Agent 工程师',
  hook: '这里有一个唯一钩子短语', own: '唯一钩子短语',
  url: 'https://www.zhipin.com/job_detail/test.html',
}

assert.deepEqual(lib.validateJob(good), { ok: true })
assert.equal(lib.validateJob({ ...good, url: '' }).ok, false, '必须拦截漏url')
assert.equal(lib.validateJob({ ...good, own: '不存在的短语' }).ok, false, '必须拦截own不在hook')
assert.equal(lib.validateJob({ ...good, url: 'https://example.com/x' }).ok, false, '必须拦截非BOSS详情URL')
for (const field of ['co', 'key', 'title', 'hook', 'own', 'url']) {
  for (const bad of [undefined, '', '  ', 1, null]) assert.equal(lib.validateJob({ ...good, [field]: bad }).ok, false, field + ' 必填')
}

const msg = lib.makeMsg('AI Agent 工程师', '钩子')
assert(msg.startsWith('您好，看到贵司在招AI Agent 工程师，很感兴趣。' + profile.candidate.intro + '钩子，'), '模板占位符 {title}{intro}{hook} 必须填上')
assert(msg.endsWith('GitHub：https://github.com/your-name\n个人网站：https://your-site.example'), '{links} 按 profile.links 顺序逐行输出')
assert(!/\{(title|intro|hook|links)\}/.test(msg), '不能残留占位符')
// 自定义模板
const lib2 = makeLib({}, { ...profile, message: { ...profile.message, template: '{hook}|{links}' } })
assert.equal(lib2.makeMsg('T', 'H'), 'H|GitHub：https://github.com/your-name\n个人网站：https://your-site.example')
console.log('PASS: apply offline regressions')
