---
name: boss-auto-apply-skill
description: BOSS直聘自动投递流水线，任何行业/城市/应届实习都能用：按用户 profile.json 里的身份和偏好，多城市多岗位粗筛→细筛串行单岗闭环（过审即发不攒批），防风控、断点续跑、台账去重，需要 ego-browser 等浏览器自动化。Use when 用户说"帮我投简历 / 投 BOSS / 跑今天的投递批次 / 改投递规则 / 换个城市投"。首次使用先按「首次使用」一节引导用户建好 profile 再投。
license: All Rights Reserved（未获授权勿商用）
compatibility: Requires ego-browser (ego lite, https://lite.ego.app, macOS; bundles its own Node runtime) with the ego-browser skill installed; a logged-in BOSS直聘 (zhipin.com) session in that browser; network access to zhipin.com only.
metadata:
  author: limboinf
  version: "3.0"
---

# boss-auto-apply-skill — BOSS直聘自动投递流水线

粗筛（只滚只记）→ 细筛（串行单岗闭环：读 JD → 规则判定 → 立即发送 → 验证 → 当场记账）。不攒批统一发送，防平台风控；全量落盘，中断随时续跑。**谁在投、投哪些城市、投什么岗、怎么说、拦什么**全部来自用户自己的 `profile.json`，库里只有机制、**没有任何行业预设**（默认不限薪资、不限经验、不拦任何岗位类型——销售、产品、应届、实习都能用）。

## 首次使用：引导用户建 profile（agent 必做，信息不全不许投）

**全程由 agent 动手，用户不敲任何命令**（用户可能没装 Node、不会开终端）。每次被叫来投递，先走这个状态机：

```
读 ~/.boss-auto-apply/profile.json（或 BOSS_APPLY_PROFILE）
  ├─ 不存在        → 从零访谈（下表全部问一遍）
  ├─ 存在但不合法  → 只补错的/缺的字段（校验错误逐条列出了哪个字段有问题）
  └─ 合法          → 把摘要念给用户，问「按这个投，还是改点什么？」
写文件 → 校验 → 摘要给用户确认 → 用户说 OK 才进入投递
```

### 访谈怎么问

分两轮问，别一口气甩十几个问题把人问懵：

**第一轮：必填三项**（缺一不可，缺了库会拒绝跑）

| 问 | 写到 | 说明 |
|---|---|---|
| 一句话自我介绍：你是谁、几年经验/应届、能干什么 | `candidate.intro` | 原样进打招呼语，帮用户润色到 1-2 句、有具体成果 |
| 想投哪些城市（可多个） | `search.cities[]` | 填城市名（`assets/boss-cities.json` 里 374 个城市都认）或 9 位码；「全国」也行。多城市会逐个城市搜 |
| 想投哪些岗位（可多个方向） | `search.queries[]` | 每个方向 1-3 个关键词，如销售：`["销售", "大客户销售", "BD"]`；同一个词每天滚出来的是同一批人，多给几个轮换 |

**第二轮：可选项**（先说「以下都有默认值，不想改直接说跳过」，然后一次列完）

| 问 | 写到 | 默认 | 说明 |
|---|---|---|---|
| 工作年限档 | `search.experienceCodes[]` | 不限 | 101 不限 / 102 应届生 / 108 在校生 / 103 1年内 / 104 1-3年 / 105 3-5年 / 106 5-10年 / 107 10年+；服务端筛选，选自己够得着的几档 |
| 期望最低月薪 | `rules.minSalaryK` | 0 不限 | 规则是「范围能给到」= 区间 Max ≥ 它（填 30 → 25-35K 过，20-28K 淘汰）。**填了就会拦掉面议/日薪/时薪岗**，实习生/应届想投日薪岗必须留 0 |
| 想附的链接 | `candidate.links[]` | 无 | 作品集/GitHub/博客；有就填，发送后按 url 验证；没有不用硬凑 |
| 「JD 提到 X 就说 Y」的话术 | `hooks[]` | 无（全走兜底句） | 3-6 条最好；`keywords` 命中 JD 就把 `text` 拼进消息，按顺序取第一个命中 |
| 不投哪些公司 | `rules.blockCompanies[]` | 无 | 公司名子串 |
| 不投哪些岗位类型 | `rules.rejectTitles[]` | 无 | `[{pattern, reason}]` 正则；例：不想要实习 `{pattern:"实习\|校招", reason:"实习/校招"}`，不想要销售 `{pattern:"销售\|电销", reason:"销售岗"}`。**库不预设任何一条**，用户要拦什么自己说 |
| 不接受的学历硬要求 | `rules.rejectDegrees[]` | 无 | 如 `["硕士","博士"]`；「硕士优先/加分」自动豁免 |
| 不接受的主语言（开发岗才有意义） | `rules.rejectLanguages[]` | 无 | 标题带它淘汰；JD 当「精通/要求」淘汰，「加分/可选」豁免 |
| JD 至少要提到什么 | `rules.mustHaveKeywords[]` | 不限 | 命中一个即可；用来过滤挂羊头卖狗肉的岗 |
| 猎头挂单 / 外包岗 | `rules.headhunter` / `rules.outsourcing` | reject / review | 猎头默认过滤是机制原因（会话找不到，见 references/rules.md）；外包 review = 不投不淘汰，落 NEEDS_REVIEW 交 agent 判断 |
| 每轮最多发几个、间隔 | `pacing` | 7 个 / 20-35s | 间隔下限 15s 写死在库里，改小无效（防风控） |

### 写文件与校验

1. 读 `assets/profile.example.json` 当字段模板（只看结构，示例身份不能用；它是开发岗画像，规则条目都是示例）
2. agent 自己把 JSON 写到 `~/.boss-auto-apply/profile.json`（目录不存在就建；用户没提的字段直接省略，走默认值）
3. 校验并把摘要念给用户确认。系统有 `node` 就 `node <skill目录>/scripts/profile.js check`；没有就用 ego lite 自带的 Node：

   ```bash
   ego-browser nodejs <<'EOF'
   const { loadProfile, summarize } = (await import('<skill目录>/scripts/profile.js')).default
   console.log(summarize(loadProfile()))   // 不合法会抛错并逐条列出哪个字段错 → 回去补问那几项
   EOF
   ```

4. 用户说「可以」才开始投。用户中途说「换个城市 / 加个岗位 / 薪资改 20K」= 改 profile 对应字段 → 重新校验 → 再投，**不要临场改库**

**profile 里没有的东西就是不该改的**：反爬字体解码、页面选择器、会话定位、发送三重兜底、间隔下限——这些改了只会坏。

## 依赖（开工前逐项确认，缺一项先装再跑）

| 依赖 | 检查 | 缺了怎么办 |
|---|---|---|
| ego lite 浏览器（提供 `ego-browser` 命令，自带 Node 24，**用户不用另装 Node**） | `command -v ego-browser` | 按 ego-browser skill 的 `references/install.md` 装（macOS），装完用户在 GUI 完成 onboarding；找不到命令先 `export PATH="$HOME/.local/bin:$PATH"` |
| ego-browser skill（`taskSpace` / `page` / heredoc 用法都在它那） | agent 已加载 `ego-browser` skill | `npx skills add citrolabs/ego-lite --skill ego-browser -g -y` |
| BOSS直聘登录态 | 粗筛内置登录预检 | 失效即停并 handOff 交用户扫码，游客态不跑 |

- 浏览器只依赖 `h` 接口：`js(exprString)→Promise<any>` 在页面求值表达式；`click(selector | [x,y], {label})`；`wait(seconds)`；`gotoAndWait(url, {timeout, settle})` 秒；`pageInfo()→{url}`。`scripts/ego_browser_adapter.js` 的 `makeH(page)` 把 ego 的 Page 映射成 `h`；换别的浏览器自动化只需另写一个 `makeH`。粗筛另外直接用 `page.goto / waitForLoadState / cdp('Input.dispatchMouseEvent')`
- 库零第三方依赖，不用 `npm install`；整个流程都在 `ego-browser nodejs` 里跑，系统 Node 只有开发者跑 `tests/` 才需要
- 纯逻辑函数（规则判定 / hook / 台账）不碰浏览器，可离线跑测试

## 目录结构

```
boss-auto-apply-skill/
├── SKILL.md                  # 本文件
├── scripts/
│   ├── profile.js            # profile 加载/校验/默认值 + CLI（init|check）
│   ├── pipeline.js           # 主库：filterCards/evalDetail/makeHook/updateLedgerFromCheckpoint + discover/screenLoop
│   ├── apply.js              # 单岗投递库：applyOne/verifyCurrent/fillDraft/realClickSend（内部依赖）
│   └── ego_browser_adapter.js  # ego-browser Page → h 适配器（makeH）
├── references/
│   ├── rules.md              # 规则生效细节
│   └── pitfalls.md           # 已知坑
├── tests/                    # 离线测试（无浏览器/无网络）
└── assets/
    ├── profile.example.json  # profile 模板（示例身份，别拿它去投）
    ├── boss-cities.json      # 374 个城市 名→码（BOSS 公开接口导出）
    └── cron-prompt.txt       # 定时批次 prompt 模板

~/.boss-auto-apply/           # 数据目录（不在代码目录里，重装/更新 skill 不受影响）
├── profile.json              # 你的身份 + 偏好
├── applied-ledger.json       # 总台账：applied[]（已投）+ eliminated[]（已淘汰），缺失自动建
└── runs/YYYY-MM-DD-*/        # 每批次：pool-*.json / shortlist.json / details.jsonl / checkpoint.jsonl
```

数据目录：环境变量 `BOSS_APPLY_DATA` 优先；缺省 `~/.boss-auto-apply/`。profile 单独可用 `BOSS_APPLY_PROFILE` 指定。库里 `pipeline.dataDir()` / `pipeline.ledgerPath()` / `pipeline.runDir(name)` 给出路径，别手拼。

## 规则与坑（按需读，别一上来全加载）

- 规则怎么落到卡级 / 详情级、猎头识别、外包 review 语义：[references/rules.md](references/rules.md)——改 profile.rules 或解释某岗为什么被淘汰时读
- 实战踩过的坑（猎头挂单会话找不到、btn-send 要真点、验证面板范围、BOSS 改版、自动打招呼语双发）：[references/pitfalls.md](references/pitfalls.md)——发送失败 / 验证不过 / 选择器失效时读

## 流程（两个独立 heredoc 轮次，串行走完）

ego-browser 的 `nodejs` 是 **ESM，没有 `require`**，加载库用 `(await import(path)).default`。每轮 heredoc 开头固定这段：

```js
const SKILL = '<本 skill 目录绝对路径，即 SKILL.md 所在目录>'
const { makeH } = (await import(SKILL + '/scripts/ego_browser_adapter.js')).default
const pipeline = (await import(SKILL + '/scripts/pipeline.js')).default
const { loadProfile } = (await import(SKILL + '/scripts/profile.js')).default
const profile = loadProfile()                              // 没有 / 不合法直接抛，先去「首次使用」
const task = await taskSpace('boss-agent-YYYYMMDD-AM')   // 首轮建；后续轮 taskSpace(<spaceId>) 复用同一个
const page = task.page('p1')
const pipe = pipeline.makePipeline(makeH(page), profile)
const runDir = pipeline.runDir('YYYY-MM-DD-AM')                 // → ~/.boss-auto-apply/runs/YYYY-MM-DD-AM
```

### 1. 粗筛 DISCOVER（只滚只记，不发消息）

```js
const r = await pipe.discover(runDir, page)     // cities / queries / maxRounds 缺省取 profile.search；r.ok=false 时看 r.phase（login | risk-control | config）
// → pool-<城市>-<词>.json（全量）+ shortlist.json（粗筛通过，含 salaryFont 校验结果）+ coarse-reject.json（拒因）+ discover.log
// 实测：1 城 × 5 词 × 30 轮 195s，717 卡去重 → 171 候选。城市 × 关键词是乘法：3 城 × 5 词 ≈ 10 分钟，超 heredoc 550s 就按城市拆轮跑（opts.cities 传单个城市码）
```

- **服务端筛选**：列表 URL 带 `salary=<由 minSalaryK 派生>&experience=<experienceCodes>`，在 BOSS 那边就砍掉不合要求的——实测薪资线 30K 时 80% 卡达标（无过滤时细筛 37% 白开详情页）。minSalaryK=0 / experienceCodes 空 = 不带参数、不筛。不加学历筛选（会把「学历不限」岗砍掉）
- 真实滚轮（CDP `Input.dispatchMouseEvent` mouseWheel dy900，1.2s/轮），滚到平台期（连续 6 轮卡数不增）或轮上限
- **反爬字体已破解**：列表页薪资数字是私用区 U+E031–E03A，依次对应 0–9（`decodeSalaryFont`）。discover 每批**开 1 个详情页校验映射**（`salaryFont.verified`），对上就在卡级直接判薪资淘汰（省 ~40% 细筛开页）；对不上（BOSS 换字体）自动退回「打码留细筛」，shortlist 里的 `salary` 是解码后的值。minSalaryK=0 时不校验也不解码（没有薪资规则要判）

### 2. 细筛 SCREEN（串行单岗闭环，过审即发）

```js
const r = await pipe.screenLoop(runDir, page)   // maxSend / budgetS 缺省取 profile.pacing；可传 { hooks: { '公司名': '定制hook' } } 点名优先
```

逐岗：开详情页 → 读 `.job-banner` 薪资 + `.job-sec-text` JD → `evalDetail` 判定 → 通过**立即发送**（applyOne → verifyCurrent，含一次重验）→ 当场 append details.jsonl + checkpoint.jsonl → SENT 后随机等 `pacing.sendIntervalS`（防风控）→ 下一岗。中断恢复：details.jsonl 里终态（SENT/SKIPPED/ELIMINATED/DRY_PASS/NEEDS_REVIEW）的公司跳过，FAILED 下轮重试（已点过「立即沟通」的由按钮态兜住，不会重发）。

返回 `{ ok, stop, sent, tried, remaining, out }`，**先看 `stop` 再决定下一步**：

| `stop` | 含义 | 下一步 |
|---|---|---|
| `null` | 正常结束：maxSend 达标或 shortlist 耗尽 | 收尾 LEDGER |
| `time-budget` | 单轮预算用完，还有 `remaining` 家没看 | 同一 runDir 再开一轮 heredoc 续跑（断点自动接上） |
| `consecutive-failures` | 连续 3 岗 FAILED（页面结构变了 / 网络挂了） | 停，报告；不要硬续，先看 details.jsonl 的 reason |
| `login` / `risk-control` | 登录失效 / BOSS 弹安全验证 | **立即停，交 handOff 让用户处理**；风控页当天不要再跑 |

`dryRun: true`：只判定落盘（DRY_PASS/ELIMINATED），不点不发——上线前只读验证用。**注意 DRY_PASS 是终态**：同一 runDir 里 dryRun 之后再跑 `screenLoop` 会跳过这些岗；要对 dry 过的岗真发，直接 `pipe.screenAndSendOne(runDir, job, { hooks: {} }, {})`。

细筛结束后看 details.jsonl 里 `NEEDS_REVIEW`（外包岗）：逐条读 `jd` 摘要判断，值得投的 `await pipe.sendReviewed(runDir, co)`，不投的不用动（终态，不会重开）。

### 3. 收尾 LEDGER

```js
pipeline.updateLedgerFromCheckpoint(pipeline.ledgerPath(), runDir + '/checkpoint.jsonl', 'YYYY-MM-DD', runDir + '/details.jsonl')
// applied 来自 VERIFIED checkpoint 行 + SKIPPED details 行（BOSS 显示已沟通）；eliminated 来自 ELIMINATED details 行（toLedger=false 除外）；均幂等
```

### 报告

必须区分：发现卡数 / 粗筛通过数 / 细筛判定数（过 / 淘汰 + 原因分布 / NEEDS_REVIEW 数及处理）/ 实际发送数 / 验证通过数 / 台账累计 / checkpoint 路径。不把"启动/unknown"说成完成。

## 边界与异常（每条都要照做，不要自己发明处理方式）

| 情况 | 怎么识别 | 怎么办 |
|---|---|---|
| profile 不存在 / 不合法 | `loadProfile()` 抛错 | 走「首次使用」，补齐后再来；**绝不**拿示例身份或自己编的身份投 |
| `ego-browser` 命令不存在 | `command -v ego-browser` 空 | 按 ego-browser skill `references/install.md` 装，装完让用户在 GUI 完成 onboarding，再回来 |
| BOSS 未登录 / 登录失效 | `discover` 返回 `phase: 'login'`；细筛 `stop: 'login'` | 停，handOff 让用户在 ego lite 里扫码登录，登录后从当前 runDir 续跑 |
| BOSS 安全验证 / 滑块 / 访问异常 | `phase` 或 `stop` = `risk-control` | **立即停**，告诉用户手动到浏览器里过验证；当天不要再跑投递，明天减半 `maxSendPerRound` |
| 用户接管了浏览器 | ego 报 user is controlling / task space 被接管 | 立即停，报告已完成与未完成，不抢回 |
| 粗筛 0 候选 | `discover` 返回 `kept: 0` | 看 coarse-reject.json 的 reason 分布告诉用户为什么（多半是薪资线/关键词太窄/台账已投完），建议放宽哪一项；不要自作主张改规则 |
| 某城市 / 关键词搜出来 0 卡 | `results[].cards === 0` | 报告里点名；可能是关键词在该城市没岗，或 BOSS 改版选择器失效（其他词也 0 就是后者） |
| 详情页加载不出 | details `FAILED: 详情页未加载` | 单个：下轮自动重试；连续 3 个：熔断 `consecutive-failures`，停 |
| 职位已关闭 / 薪资解析不出 | `ELIMINATED` 且 `toLedger: false` | 岗位级瞬态，不进台账，下次这家公司仍可看 |
| 发送后验证不过 | checkpoint `verify.ok: false` | 不算 VERIFIED，不进台账 applied；下轮重试时按钮态若是「继续沟通」会记 SKIPPED（BOSS 已算沟通过）并进台账 |
| 外包岗 | `NEEDS_REVIEW` | agent 读 jd 摘要判断，值得投 `sendReviewed`，不投不用动 |
| 同一天要跑第二批 | 早班 runDir 的 shortlist 没消化完 | 复用早班 runDir 继续 screenLoop（checkpoint 连续），不要重滚列表 |
| 单轮 heredoc 超时 | terminal timeout | 每轮 ≤550s；粗筛按城市拆，细筛按 `budgetS` 拆，都能断点续 |
| 用户中途改需求（换城市 / 加岗位 / 改薪资） | 对话里说的 | 改 profile 对应字段 → 重新校验念摘要 → **新开 runDir** 重新粗筛（旧 shortlist 是旧条件筛的） |
| 跨机器 / 换电脑 | 台账不在 | `BOSS_APPLY_DATA` 指向同步盘目录，或接受从空台账起（可能重复投给旧公司） |

原则：**任何拿不准的情况都是停下来问用户，不是猜一个继续跑**——发错一条消息比少投十条代价大。

## 打招呼语怎么拼

`message.template` 填 `{title}`（岗位名）`{intro}`（candidate.intro）`{hook}`（hooks 命中或 fallbackHook）`{links}`（每条 `label：url` 一行）。`own` = hook 内独一短语，发送后在右侧消息面板里找它 + 每条链接 + 草稿清空，三样齐了才算 VERIFIED。

## 测试（改库后必跑）

```bash
node tests/test_pipeline.js   # 纯逻辑：粗筛/细筛规则、hook、profile 合并校验、台账幂等、discover/screenLoop mock
node tests/test_apply.js      # 投递库 + 消息模板
```
