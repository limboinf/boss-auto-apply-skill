---
name: boss-auto-apply
description: Use when 自动投递 BOSS直聘岗位. 粗筛滚动记录→细筛串行单岗闭环（过审即发不攒批），防风控、断点续跑、台账去重.
---

# boss-auto-apply — BOSS直聘自动投递流水线

**仓库即 skill**（本机软链 ~/.hermes/skills/career/boss-auto-apply，单源，改仓库=改 skill）。旧目录已归档：~/.hermes/skills/career/.boss-zhipin-apply-old、~/.hermes/scripts/.boss-apply-old，稳定后可删。cron job（早班5798557b3c23/午班a72abffc0a07）prompt 已指向本仓库路径。

粗筛（只滚只记）→ 细筛（串行单岗闭环：读 JD → 规则判定 → 立即发送 → 验证 → 当场记账）。不攒批统一发送，防平台风控；全量落盘，中断随时续跑。

## 依赖

- **ego-browser**（或任何提供 `page`/CDP 能力的浏览器自动化）：粗筛滚轮、细筛开详情页、发送消息
- Node.js（纯逻辑函数可离线跑，无需浏览器）
- BOSS直聘已登录态（粗筛内置登录预检，失效即停）

## 目录结构

```
boss-auto-apply/
├── SKILL.md                  # 本文件
├── scripts/                  # 执行层
│   ├── pipeline_v2_lib.js    # v2 主库：filterCards/evalDetail/makeHook/updateLedgerFromCheckpoint + discover/screenLoop
│   ├── batch_apply_lib.js    # 单岗投递库：applyOne/verifyCurrent/fillDraft/realClickSend（v2 内部依赖）
│   ├── batch_apply_runner_lib.js  # v1 runner（备用）
│   └── state_store.js        # v1 事件状态机（备用）
├── tests/                    # 离线测试（无浏览器/无网络）
├── templates/cron-prompt.txt # 定时批次 prompt 模板
└── data/                     # 运行数据（台账 + 每日 runs）
    ├── applied-ledger.json   # 总台账：applied[]（已投）+ eliminated[]（已淘汰）
    └── runs/YYYY-MM-DD-*/    # 每批次：pool-*.json / shortlist.json / details.jsonl / checkpoint.jsonl
```

数据目录解析：环境变量 `BOSS_APPLY_DATA` 优先；缺省用仓库内 `data/`（脚本相对自身路径定位，无机器特有路径）。要跨机器/外置数据就设 `BOSS_APPLY_DATA=/path/to/data`。

## 硬规则（内置于库，改规则改库并跑测试）

- 排除大厂/模型公司（DEFAULT_BLOCK_COS，含中文名如深度求索）
- 排除硕士/博士、实习/校招/应届、销售/客服/电销/测试/运维/产品经理/讲师岗
- 详情页薪资区间 Max ≥ 30K（上限不封顶）；面议/无法解析淘汰
- 语言红线：JD 明确要求 Go/C++/Rust/PHP/C# 作为主语言 → 跳过；「加分/优先/可选」措辞豁免
- JD 必含 AI/Agent/大模型要素
- **猎头挂单默认过滤**（`excludeHeadhunter`，默认 true）：masked 公司名（含「某」+ 公司/企业/央企/集团/独角兽、获融资括注等模式）是猎头挂单，岗位信息被包装、会话挂在猎头名下。放行传 `{excludeHeadhunter:false}`
- 外包岗位默认排除；外企外包技术栈高度匹配才投且须标注

## 流程（两个独立 heredoc 轮次，串行走完）

### 1. 粗筛 DISCOVER（只滚只记，不开详情不发消息）

```js
const makeV2 = require('<repo>/scripts/pipeline_v2_lib.js')
const pipe = makeV2.makePipelineV2(h)   // h = {js, click, wait, gotoAndWait, pageInfo}
const r = await pipe.discover(runDir, page, ['Agent', 'AI'], { maxRounds: 30 })
// → pool-<q>.json（全量）+ shortlist.json（粗筛通过）+ coarse-reject.json（拒因）
```

- 真实滚轮（CDP `Input.dispatchMouseEvent` mouseWheel dy900，1.2s/轮），滚到平台期（连续 6 轮卡数不增）或轮上限
- **反爬坑**：列表页薪资数字是 PUA 不可见字符，「-K·薪」= 打码不是无薪资；含 K/薪/元 且无 ASCII 数字 → 保留给细筛读详情页真实薪资

### 2. 细筛 SCREEN（串行单岗闭环，过审即发）

```js
const r = await pipe.screenLoop(runDir, page, { maxSend: 7, budgetS: 480 })
// 可选 hooks: { '公司名': '定制hook文案' } 点名公司优先投
```

逐岗：开详情页 → 读 `.job-banner` 薪资 + `.job-sec-text` JD → `evalDetail` 判定 → 通过**立即发送**（applyOne → verifyCurrent，含一次重验）→ 当场 append details.jsonl + checkpoint.jsonl → SENT 后随机等 20-35s（防风控）→ 下一岗。中断恢复自动跳过 details.jsonl 已处理公司。

`dryRun: true`：只判定落盘（DRY_PASS/ELIMINATED），不点不发——上线前只读验证用。

### 3. 收尾 LEDGER

```js
const v2 = require('<repo>/scripts/pipeline_v2_lib.js')
v2.updateLedgerFromCheckpoint(ledgerPath, ckPath, 'YYYY-MM-DD', detailsPath)
// applied 来自 VERIFIED checkpoint 行；eliminated 来自 ELIMINATED details 行；均幂等
```

## 定制打招呼语

模板在 `batch_apply_lib.js` 的 `makeMsg(title, hook)`；hook 按 JD 关键词从 `HOOK_TABLE`（pipeline_v2_lib.js）匹配（MCP/LangGraph/RAG/多模态/工作流/Claude Code/开源/微调/评估/全栈/Python/Java 优先级），`own` 取 hook 内独一短语用于发送验证。

## 测试（改库后必跑）

```bash
node tests/test_pipeline_v2.js          # v2 纯逻辑：粗筛规则/细筛规则/hook/台账幂等
node tests/test_batch_apply_lib.js      # 投递库回归
node tests/test_runner_checkpoint.js    # 断点语义
node tests/test_pipeline_logic.js       # v1 流水线回归
```

## 已知坑（实战踩过）

- **猎头挂单**：点沟通后会话挂在猎头公司名下，按原公司名找会话必失败——默认过滤已根治；若放行需走补救通道（详情页点继续沟通→跳聊天页直接填发）
- **btn-send 用 js click 不触发**：必须真实坐标点击（realClickSend 已内置三重兜底）
- **发送验证不能查 body.innerText**：左侧会话列表预览会污染；限定右侧消息面板（x>320）
- **BOSS 改版频繁**：选择器变了优先按文本内容定位，类名不可靠
- 会话定位 key 必须用聊天页实际显示的中文公司名子串，不能用自造拉丁 key
