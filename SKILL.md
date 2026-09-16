---
name: boss-auto-apply
description: Use when 自动投递 BOSS直聘岗位（用户说"帮我投简历/投 BOSS/跑今天的投递批次"）. 按用户 profile.json 里的身份和偏好：粗筛滚动记录→细筛串行单岗闭环（过审即发不攒批），防风控、断点续跑、台账去重. 首次使用先按「首次使用」一节把 profile 问出来.
---

# boss-auto-apply — BOSS直聘自动投递流水线

粗筛（只滚只记）→ 细筛（串行单岗闭环：读 JD → 规则判定 → 立即发送 → 验证 → 当场记账）。不攒批统一发送，防平台风控；全量落盘，中断随时续跑。**谁在投、投什么、怎么说**全部来自用户自己的 `profile.json`，库里只有机制。

## 首次使用：先把 profile 建起来（agent 必做）

没有 profile 库会直接拒绝跑（`loadProfile` 抛错），**不要**拿模板里的示例身份去投。流程：

1. `node scripts/profile.js init` → 从 `templates/profile.example.json` 复制到 `data/profile.json`（gitignore，不入库；跨机器设 `BOSS_APPLY_DATA` 或 `BOSS_APPLY_PROFILE`）
2. 用下面的问题把用户的答案问出来（一次问完，别挤牙膏），写进 `data/profile.json`：

| 问 | 写到 | 说明 |
|---|---|---|
| 一句话自我介绍（年限 / 方向 / 能交付什么） | `candidate.intro` | 会原样进打招呼语 |
| 想附的链接（GitHub / 作品集 / 博客） | `candidate.links[]` | ≥1 条，发送后按 url 验证；顺序即消息里顺序 |
| 3-6 条"JD 提到 X 就说 Y"的话术 | `hooks[]` | `keywords` 命中 JD 就把 `text` 拼进消息；按顺序取第一个命中；没有就用 `message.fallbackHook` |
| 城市 | `search.city` | 9 位码：北京 101010100 / 上海 101020100 / 广州 101280100 / 深圳 101280600 / 杭州 101210100 / 成都 101270100 / 南京 101190100 / 武汉 101200100 / 西安 101110100 / 苏州 101190400；其他城市：BOSS 网页选城市后看 URL 里 `city=` |
| 搜什么关键词 | `search.queries` | 3-5 个轮换；同一个词每天滚出来的是同一批人 |
| 工作年限 | `search.experienceCodes` | 101 不限 / 103 1年内 / 104 1-3年 / 105 3-5年 / 106 5-10年 / 107 10年+；服务端筛选，选自己够得着的几档 |
| 期望最低月薪 | `rules.minSalaryK` | 规则是"范围能给到" = 区间 Max ≥ 它（30 → 25-35K 过，20-28K 淘汰）；薪资服务端筛选码自动派生 |
| 不投哪些公司 | `rules.blockCompanies` | 公司名子串；默认空 |
| 不接受的主语言 | `rules.rejectLanguages` | 标题带它直接淘汰；JD 把它当"精通/要求/主要"淘汰，"加分/优先/可选"豁免；默认 Go/C++/Rust/PHP/C#，改成自己的 |
| JD 至少要提到什么 | `rules.mustHaveKeywords` | 默认 AI/Agent/LLM/大模型…；转行/换方向就改这里；`[]` = 不限 |
| 学历红线 | `rules.rejectDegrees` | 默认 硕士/博士；"硕士优先/加分"自动豁免 |
| 猎头挂单 / 外包岗 | `rules.headhunter` / `rules.outsourcing` | 猎头 `reject`\|`allow`；外包 `review`（默认，不投不淘汰，落 NEEDS_REVIEW 交你判断）\|`reject`\|`allow` |
| 每轮最多发几个、间隔 | `pacing` | 默认 7 个 / 20-35s；间隔下限 15s 写死在库里，改小无效（防风控） |
| 还想拦哪些岗位类型 | `rules.extraRejectTitles` | 追加式 `[{pattern, reason}]`；实习/校招、储备/管培、销售、客服 4 条固定生效不用写。想拦产品经理/测试/运维/讲师就加一条（模板里有示例） |

3. `node scripts/profile.js check` → 打印摘要，用户确认无误再跑。

**profile 里没有的东西就是不该改的**：反爬字体解码、页面选择器、会话定位、发送三重兜底、间隔下限——这些改了只会坏。

## 依赖

- **ego-browser**（或任何提供 `page`/CDP 能力的浏览器自动化）：粗筛滚轮、细筛开详情页、发送消息。`scripts/ego_browser_adapter.js` 的 `makeH(page)` 把 ego 的 Page 映射成库要的 `h`；换别的浏览器自动化只需另写一个 `makeH`
- **h 接口契约**：`js(exprString)→Promise<any>` 在页面求值表达式；`click(selector | [x,y], {label})`；`wait(seconds)`；`gotoAndWait(url, {timeout, settle})` 秒；`pageInfo()→{url}`。粗筛另外直接用 `page.goto / waitForLoadState / cdp('Input.dispatchMouseEvent')`
- Node.js（纯逻辑函数可离线跑，无需浏览器）
- BOSS直聘已登录态（粗筛内置登录预检，失效即停）

## 目录结构

```
boss-auto-apply/
├── SKILL.md                  # 本文件
├── scripts/
│   ├── profile.js            # profile 加载/校验/默认值 + CLI（init|check）
│   ├── pipeline_v2_lib.js    # 主库：filterCards/evalDetail/makeHook/updateLedgerFromCheckpoint + discover/screenLoop
│   ├── batch_apply_lib.js    # 单岗投递库：applyOne/verifyCurrent/fillDraft/realClickSend（内部依赖）
│   ├── ego_browser_adapter.js     # ego-browser Page → h 适配器（makeH）
│   ├── batch_apply_runner_lib.js  # v1 runner（备用）
│   └── state_store.js        # v1 事件状态机（备用）
├── tests/                    # 离线测试（无浏览器/无网络）
├── templates/
│   ├── profile.example.json  # profile 模板（示例身份，别拿它去投）
│   └── cron-prompt.txt       # 定时批次 prompt 模板
└── data/                     # 全部 gitignore：个人数据不入库
    ├── profile.json          # 你的身份 + 偏好
    ├── applied-ledger.json   # 总台账：applied[]（已投）+ eliminated[]（已淘汰），缺失自动建
    └── runs/YYYY-MM-DD-*/    # 每批次：pool-*.json / shortlist.json / details.jsonl / checkpoint.jsonl
```

数据目录：环境变量 `BOSS_APPLY_DATA` 优先；缺省用仓库内 `data/`。profile 单独可用 `BOSS_APPLY_PROFILE` 指定。

## 规则怎么生效（都在 profile.rules，库只负责执行）

- **卡级（不开详情页就拦）**：黑名单公司、台账已投/已淘汰、本批重复公司、猎头挂单、固定 4 条 + `extraRejectTitles`、标题含 `rejectLanguages`、标签硬性 `rejectDegrees`、薪资（可解析时 Max ≥ `minSalaryK`；时薪/日薪/面议淘汰；打码留细筛）
- **详情级**：职位已关闭 / 薪资无法解析（不进台账，下轮重试）、面议、Max < `minSalaryK`、banner 硬性 `rejectDegrees`、JD 主语言命中 `rejectLanguages`（本句有"加分/优先/可选/了解"豁免）、固定 4 条 + `extraRejectTitles`、JD 未命中 `mustHaveKeywords`、外包特征按 `outsourcing` 策略
- **猎头挂单识别**（机制，不可配）：含「某」的 masked 公司名、「知名公司」「头部XX公司」、人力/猎头机构名。这类岗点沟通后会话挂在猎头名下，按原公司名找会话必失败
- **外包 `review`**：其余规则全过但命中外包/驻场/外派/派遣 → `NEEDS_REVIEW` 落 details.jsonl（带 JD 摘要），agent 读完判断，要投 `pipe.sendReviewed(runDir, '公司名')`，不投不用动

## 流程（两个独立 heredoc 轮次，串行走完）

ego-browser 的 `nodejs` 是 **ESM，没有 `require`**，加载库用 `(await import(path)).default`。每轮 heredoc 开头固定这段：

```js
const REPO = '<repo 绝对路径>'
const { makeH } = (await import(REPO + '/scripts/ego_browser_adapter.js')).default
const v2 = (await import(REPO + '/scripts/pipeline_v2_lib.js')).default
const { loadProfile } = (await import(REPO + '/scripts/profile.js')).default
const profile = loadProfile()                              // 没有 / 不合法直接抛，先去「首次使用」
const task = await taskSpace('boss-agent-YYYYMMDD-AM')   // 首轮建；后续轮 taskSpace(<spaceId>) 复用同一个
const page = task.page('p1')
const pipe = v2.makePipelineV2(makeH(page), profile)
const runDir = REPO + '/data/runs/YYYY-MM-DD-AM'
```

### 1. 粗筛 DISCOVER（只滚只记，不发消息）

```js
const r = await pipe.discover(runDir, page)     // queries / maxRounds 缺省取 profile.search
// → pool-<q>.json（全量）+ shortlist.json（粗筛通过，含 salaryFont 校验结果）+ coarse-reject.json（拒因）+ discover.log
// 实测：5 词 × 30 轮 195s，717 卡去重 → 171 候选
```

- **服务端筛选**：列表 URL 带 `salary=<由 minSalaryK 派生>&experience=<experienceCodes>`，在 BOSS 那边就砍掉低薪和初级岗——实测 80% 卡 Max≥30K（无过滤时细筛 37% 白开详情页）。不加学历筛选（会把「学历不限」岗砍掉）
- 真实滚轮（CDP `Input.dispatchMouseEvent` mouseWheel dy900，1.2s/轮），滚到平台期（连续 6 轮卡数不增）或轮上限
- **反爬字体已破解**：列表页薪资数字是私用区 U+E031–E03A，依次对应 0–9（`decodeSalaryFont`）。discover 每批**开 1 个详情页校验映射**（`salaryFont.verified`），对上就在卡级直接判薪资淘汰（省 ~40% 细筛开页）；对不上（BOSS 换字体）自动退回「打码留细筛」，shortlist 里的 `salary` 是解码后的值

### 2. 细筛 SCREEN（串行单岗闭环，过审即发）

```js
const r = await pipe.screenLoop(runDir, page)   // maxSend / budgetS 缺省取 profile.pacing；可传 { hooks: { '公司名': '定制hook' } } 点名优先
```

逐岗：开详情页 → 读 `.job-banner` 薪资 + `.job-sec-text` JD → `evalDetail` 判定 → 通过**立即发送**（applyOne → verifyCurrent，含一次重验）→ 当场 append details.jsonl + checkpoint.jsonl → SENT 后随机等 `pacing.sendIntervalS`（防风控）→ 下一岗。中断恢复：details.jsonl 里终态（SENT/SKIPPED/ELIMINATED/DRY_PASS/NEEDS_REVIEW）的公司跳过，FAILED 下轮重试（已点过「立即沟通」的由按钮态兜住，不会重发）。

`dryRun: true`：只判定落盘（DRY_PASS/ELIMINATED），不点不发——上线前只读验证用。**注意 DRY_PASS 是终态**：同一 runDir 里 dryRun 之后再跑 `screenLoop` 会跳过这些岗；要对 dry 过的岗真发，直接 `pipe.screenAndSendOne(runDir, job, { hooks: {} }, {})`。

细筛结束后看 details.jsonl 里 `NEEDS_REVIEW`（外包岗）：逐条读 `jd` 摘要判断，值得投的 `await pipe.sendReviewed(runDir, co)`，不投的不用动（终态，不会重开）。

### 3. 收尾 LEDGER

```js
v2.updateLedgerFromCheckpoint(v2.ledgerPath(), runDir + '/checkpoint.jsonl', 'YYYY-MM-DD', runDir + '/details.jsonl')
// applied 来自 VERIFIED checkpoint 行 + SKIPPED details 行（BOSS 显示已沟通）；eliminated 来自 ELIMINATED details 行（toLedger=false 除外）；均幂等
```

### 报告

必须区分：发现卡数 / 粗筛通过数 / 细筛判定数（过 / 淘汰 + 原因分布 / NEEDS_REVIEW 数及处理）/ 实际发送数 / 验证通过数 / 台账累计 / checkpoint 路径。不把"启动/unknown"说成完成。

## 打招呼语怎么拼

`message.template` 填 `{title}`（岗位名）`{intro}`（candidate.intro）`{hook}`（hooks 命中或 fallbackHook）`{links}`（每条 `label：url` 一行）。`own` = hook 内独一短语，发送后在右侧消息面板里找它 + 每条链接 + 草稿清空，三样齐了才算 VERIFIED。

## 测试（改库后必跑）

```bash
node tests/test_pipeline_v2.js          # 纯逻辑：粗筛/细筛规则、hook、profile 合并校验、台账幂等、discover/screenLoop mock
node tests/test_batch_apply_lib.js      # 投递库 + 消息模板
node tests/test_runner_checkpoint.js    # v1 断点语义
node tests/test_pipeline_logic.js       # v1 流水线回归
```

## 已知坑（实战踩过）

- **猎头挂单**：点沟通后会话挂在猎头公司名下，按原公司名找会话必失败——默认过滤已根治；`headhunter: allow` 放行的要走补救通道（详情页点继续沟通→跳聊天页直接填发）
- **btn-send 用 js click 不触发**：必须真实坐标点击（realClickSend 已内置三重兜底）
- **发送验证不能查 body.innerText**：左侧会话列表预览会污染；限定右侧消息面板（x>320）
- **BOSS 改版频繁**：选择器变了优先按文本内容定位，类名不可靠
- 会话定位 key 必须用聊天页实际显示的中文公司名子串，不能用自造拉丁 key
- **BOSS 账号的「自动打招呼语」会在点「立即沟通」时先发一条**，再发我们的定制文案，HR 会收到两条。要单条就去 BOSS 设置里关掉自动打招呼
