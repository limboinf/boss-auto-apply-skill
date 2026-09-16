// ego-browser → h 适配器。pipeline_v2_lib / batch_apply_lib 只依赖 h = {js, click, wait, gotoAndWait, pageInfo}，
// 这里把它们映射到 ego-browser 的 Page API（时间单位：库用秒，ego 用毫秒）。
// 用法（ego-browser nodejs heredoc，ESM）：
//   const { makeH } = (await import('<repo>/scripts/ego_browser_adapter.js')).default
//   const v2 = (await import('<repo>/scripts/pipeline_v2_lib.js')).default
//   const pipe = v2.makePipelineV2(makeH(page))
function makeH(page) {
  return {
    // 在页面里求值一个 JS 表达式字符串（库里全是 IIFE 字符串）
    js: (expr) => page.evaluate(expr),
    // 选择器点击 或 [x, y] 坐标点击
    click: async (target, opts = {}) => {
      if (Array.isArray(target)) return page.mouse.click(target[0], target[1], { label: opts.label || 'click' })
      return page.click(target, { label: opts.label || 'click' })
    },
    wait: (seconds) => page.waitForTimeout(seconds * 1000),
    gotoAndWait: async (url, opts = {}) => {
      await page.goto(url, { timeout: (opts.timeout || 20) * 1000 })
      await page.waitForLoadState()
      if (opts.settle) await page.waitForTimeout(opts.settle * 1000)
    },
    pageInfo: async () => ({ url: await page.url() }),
  }
}
module.exports = { makeH }
