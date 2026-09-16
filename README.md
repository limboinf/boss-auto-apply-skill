# boss-auto-apply

BOSS直聘自动投递流水线：粗筛（滚动记录）→ 细筛（串行单岗闭环，过审即发不攒批）→ 台账自动回填。防风控、断点续跑、猎头挂单过滤。

## 工作原理

1. **粗筛 DISCOVER**：按关键词（Agent/AI）真实滚轮加载列表到平台期，全量落盘；卡级规则过滤（大厂黑名单/学历/实习/薪资/公司去重/台账排除/猎头挂单）
2. **细筛 SCREEN**：逐岗打开详情页，读真实薪资 + JD 做规则判定；通过**立即发送**定制打招呼语（不等攒批，防平台风控），发完当场记账，随机间隔 20-35s 后下一岗
3. **收尾 LEDGER**：从 checkpoint 派生更新总台账（applied/eliminated，幂等去重），跨批次不重复投

## 快速开始

```bash
git clone https://github.com/limboinf/boss-auto-apply.git
cd boss-auto-apply

# 离线测试（无需浏览器）
node tests/test_pipeline_v2.js
```

在浏览器自动化环境（如 ego-browser）中使用：

```js
const makeV2 = require('./scripts/pipeline_v2_lib.js')
const pipe = makeV2.makePipelineV2(h)  // h = {js, click, wait, gotoAndWait, pageInfo}

// 1. 粗筛
await pipe.discover(runDir, page, ['Agent', 'AI'], { maxRounds: 30 })

// 2. 细筛（过审即发）
await pipe.screenLoop(runDir, page, { maxSend: 7, budgetS: 480 })

// 3. 台账
require('./scripts/pipeline_v2_lib.js').updateLedgerFromCheckpoint(
  'data/applied-ledger.json', runDir + '/checkpoint.jsonl', '2026-09-16', runDir + '/details.jsonl')
```

## 数据目录

默认 `<repo>/data/`；设 `BOSS_APPLY_DATA` 环境变量可外置（台账、每日 runs 全在里面）。

## 规则内置于库

- 大厂/模型公司黑名单、硕士+、实习/校招、销售/客服/测试/运维/产品岗排除
- 详情页薪资 Max ≥ 30K
- Go/C++/Rust/PHP/C# 主语言红线（加分项豁免）
- 猎头挂单默认过滤（masked 公司名识别，`excludeHeadhunter:false` 放行）

改规则直接改 `scripts/pipeline_v2_lib.js` 里的 `DEFAULT_BLOCK_COS` / `filterCards` / `evalDetail`，跑 `node tests/test_pipeline_v2.js` 验证。

## 作为 Agent Skill 使用

本仓库本身就是一份 Agent Skill（SKILL.md 为入口）：

```bash
# Claude Code / 其他支持 skills 的 agent：
ln -s $(pwd) ~/.claude/skills/boss-auto-apply
# Hermes：
ln -s $(pwd) ~/.hermes/skills/career/boss-auto-apply
```

clone / 软链两种接法都可以；软链后改仓库即改 skill。

## 保留所有权利

本项目保留所有权利（All Rights Reserved），未获授权勿商用。
