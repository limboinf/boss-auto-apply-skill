# boss-auto-apply

BOSS直聘自动投递流水线，也是一份 Agent Skill：粗筛（滚动记录）→ 细筛（串行单岗闭环，过审即发不攒批）→ 台账自动回填。防风控、断点续跑、猎头挂单过滤、反爬薪资字体解码。**谁在投、投什么、怎么说，全部来自你自己的 `profile.json`**，代码里没有任何个人信息。

## 工作原理

1. **粗筛 DISCOVER**：按你的关键词轮换搜索，列表 URL 带服务端筛选（薪资档由期望薪资派生 + 工作年限），真实滚轮加载到平台期，全量落盘；列表页反爬薪资字体解码（每批开 1 个详情页校验）；卡级规则过滤（黑名单 / 学历 / 岗位类型 / 标题语言 / 薪资 / 公司去重 / 台账排除 / 猎头挂单）
2. **细筛 SCREEN**：逐岗打开详情页，读真实薪资 + JD 做规则判定；通过**立即发送**定制打招呼语（不攒批，防风控），发完当场记账，随机间隔后下一岗；外包岗默认落 `NEEDS_REVIEW` 交 agent 判断
3. **收尾 LEDGER**：从 checkpoint 派生更新总台账（applied / eliminated，幂等去重），跨批次不重复投

## 快速开始

```bash
git clone https://github.com/limboinf/boss-auto-apply.git
cd boss-auto-apply

# 1. 生成你的 profile（data/profile.json，gitignore）
node scripts/profile.js init
#    编辑 data/profile.json：自我介绍、链接、hook 话术、城市、关键词、薪资线、黑名单…（字段说明见 SKILL.md「首次使用」）
node scripts/profile.js check      # 校验 + 打印摘要

# 2. 离线测试（无需浏览器）
node tests/test_pipeline_v2.js
```

在浏览器自动化环境（如 ego-browser）中使用：

```js
// ego-browser nodejs 是 ESM：用 import 不用 require
const { makeH } = (await import('<repo>/scripts/ego_browser_adapter.js')).default
const v2 = (await import('<repo>/scripts/pipeline_v2_lib.js')).default
const { loadProfile } = (await import('<repo>/scripts/profile.js')).default
const pipe = v2.makePipelineV2(makeH(page), loadProfile())  // 其他浏览器自动化：自己实现 h = {js, click, wait, gotoAndWait, pageInfo}

await pipe.discover(runDir, page)                  // 1. 粗筛（关键词/轮数取 profile.search）
await pipe.screenLoop(runDir, page)                // 2. 细筛（过审即发；每轮上限/间隔取 profile.pacing）
v2.updateLedgerFromCheckpoint(v2.ledgerPath(), runDir + '/checkpoint.jsonl', '2026-09-16', runDir + '/details.jsonl')  // 3. 台账
```

## 配置（profile.json）

模板 [templates/profile.example.json](templates/profile.example.json)。三块：

| 块 | 内容 | 默认 |
|---|---|---|
| `candidate` / `message` / `hooks` | 自我介绍、链接、消息模板、JD 关键词 → 话术 | **无默认，必填**（不填库拒绝跑，免得拿示例身份去投） |
| `search` | 城市码、关键词、工作年限档、滚动轮数 | 北京 / Agent 系列词 / 3 年+ / 30 轮 |
| `rules` | 期望最低月薪、公司黑名单、学历红线、追加岗位类型红线、主语言红线、JD 必含词、猎头/外包策略 | 30K / 空 / 硕博 / （实习·储备·销售·客服 4 条固定，其余追加）/ Go C++ Rust PHP C# / AI 系列词 / reject / review |
| `pacing` | 每轮最多发几个、间隔、时间预算 | 7 / 20-35s / 480s |

不在 profile 里的（反爬解码、选择器、会话定位、发送兜底、间隔下限 15s）是机制，改了只会坏。

## 数据目录

默认 `<repo>/data/`；`BOSS_APPLY_DATA` 可外置，`BOSS_APPLY_PROFILE` 可单独指定 profile。`data/` 整个在 `.gitignore`（profile、台账、每日 runs 都是个人数据）；台账缺失时首跑自动创建。

## 作为 Agent Skill 使用

本仓库本身就是一份 Agent Skill（SKILL.md 为入口），agent 首次使用会按 SKILL.md「首次使用」把你的 profile 问出来：

```bash
# Claude Code / 其他支持 skills 的 agent：
ln -s $(pwd) ~/.claude/skills/boss-auto-apply
# Hermes：
ln -s $(pwd) ~/.hermes/skills/career/boss-auto-apply
```

clone / 软链两种接法都可以；软链后改仓库即改 skill。

## 保留所有权利

本项目保留所有权利（All Rights Reserved），未获授权勿商用。
