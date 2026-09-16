# boss-auto-apply-skill

BOSS直聘自动投递 **Agent Skill**。装进 Claude Code / Codex / Cursor 等任意支持 skills 的 agent，对它说一句「帮我投 BOSS」，它就按**你自己的** `profile.json` 跑完：粗筛（滚动记录）→ 细筛（串行单岗闭环，过审即发不攒批）→ 台账回填。防风控、断点续跑、猎头挂单过滤、列表页反爬薪资字体解码。

代码里没有任何个人信息——谁在投、投什么、怎么说，全部来自你的 profile；没有 profile 库拒绝运行。

## 安装

用 [skills CLI](https://skills.sh)（`npx skills`）一条命令装到任意 agent：

```bash
npx skills add limboinf/boss-auto-apply-skill
```

- 更新 / 卸载：`npx skills update boss-auto-apply-skill` / `npx skills remove boss-auto-apply-skill`

不想用 CLI，clone 再软链也一样（软链后改仓库即改 skill，开发时用这种）：

```bash
git clone https://github.com/limboinf/boss-auto-apply-skill.git
ln -s "$(pwd)/boss-auto-apply-skill" ~/.claude/skills/boss-auto-apply-skill     # Claude Code
ln -s "$(pwd)/boss-auto-apply-skill" ~/.agents/skills/boss-auto-apply-skill     # Codex 
ln -s "$(pwd)/boss-auto-apply-skill" ~/.hermes/skills/career/boss-auto-apply-skill   # Hermes
```

### 依赖

| 依赖 | 作用 | 怎么装 / 检查 |
|---|---|---|
| **[ego lite](https://lite.ego.app/)**（macOS） | 提供 `ego-browser` 命令：滚列表、开详情页、发消息全靠它，且直接用你已登录的 BOSS 会话；自带 Node 运行时，**不用另装 Node** | 官网下载安装，完成首次 onboarding；`command -v ego-browser` 能找到即可（找不到先 `export PATH="$HOME/.local/bin:$PATH"`） |
| **ego-browser skill** | 教 agent 怎么用 ego lite（`taskSpace` / `page` / heredoc） | `npx skills add citrolabs/ego-lite --skill ego-browser -g -a claude-code -y` |
| **BOSS直聘登录态** | 在 ego lite 里登录一次 | 粗筛内置登录预检，失效即停交你扫码 |

库零第三方依赖，不用 `npm install`。换别的浏览器自动化（Playwright 等）只需另写一个 `makeH(page)` 适配器，接口契约见 [SKILL.md](SKILL.md)「依赖」。

## 首次使用：建 profile

**不用敲命令。** 装完直接对 agent 说「帮我投 BOSS」，它会按 [SKILL.md](SKILL.md)「首次使用」一次性把自我介绍、链接、话术、城市、关键词、薪资线、黑名单等问齐，自己写到 `~/.boss-auto-apply/profile.json`，校验后把摘要念给你确认。

想自己手填也行：照 [assets/profile.example.json](assets/profile.example.json) 写到 `~/.boss-auto-apply/profile.json`，然后让 agent「检查一下 profile」。

## 日常使用

对 agent 说「跑今天的投递批次」即可。它会走三步（每步都在 [SKILL.md](SKILL.md) 里有可直接执行的代码）：

1. **粗筛 DISCOVER**：按 `search.queries` 轮换搜索，URL 带服务端筛选（薪资档由 `minSalaryK` 派生 + 工作年限），真实滚轮到平台期，全量落盘；卡级规则过滤（黑名单 / 学历 / 岗位类型 / 主语言 / 薪资 / 公司去重 / 台账排除 / 猎头挂单）。列表页薪资反爬字体每批开 1 个详情页校验映射后直接解码
2. **细筛 SCREEN**：逐岗开详情页读真实薪资 + JD 判定；通过**立即发送**定制打招呼语并验证、当场记账，随机间隔后下一岗。外包岗默认落 `NEEDS_REVIEW` 交 agent 读 JD 判断
3. **收尾 LEDGER**：从 checkpoint 幂等回填总台账（applied / eliminated），跨批次不重复投

想定时跑：[assets/cron-prompt.txt](assets/cron-prompt.txt) 是给 agent 定时任务用的 prompt 模板，填上目标数量和通知渠道即可。

手动在 ego-browser 的 `nodejs` 里跑也行（ESM，用 `import` 不用 `require`）：

```js
const SKILL = '/Users/you/.agents/skills/boss-auto-apply-skill'
const { makeH } = (await import(SKILL + '/scripts/ego_browser_adapter.js')).default
const v2 = (await import(SKILL + '/scripts/pipeline_v2_lib.js')).default
const { loadProfile } = (await import(SKILL + '/scripts/profile.js')).default
const pipe = v2.makePipelineV2(makeH(page), loadProfile())
const runDir = v2.runDir('2026-09-16-AM')

await pipe.discover(runDir, page)      // 1. 粗筛
await pipe.screenLoop(runDir, page)    // 2. 细筛，过审即发
v2.updateLedgerFromCheckpoint(v2.ledgerPath(), runDir + '/checkpoint.jsonl', '2026-09-16', runDir + '/details.jsonl')  // 3. 台账
```

## 配置（profile.json）

模板 [assets/profile.example.json](assets/profile.example.json)，字段逐条说明在 [SKILL.md](SKILL.md)「首次使用」。四块：

| 块 | 内容 | 默认 |
|---|---|---|
| `candidate` / `message` / `hooks` | 自我介绍、链接、消息模板、「JD 提到 X 就说 Y」话术 | **无默认，必填** |
| `search` | 城市码、关键词、工作年限档、滚动轮数 | 北京 / Agent 系列词 / 3 年+ / 30 轮 |
| `rules` | 期望最低月薪、公司黑名单、学历红线、追加岗位类型红线、主语言红线、JD 必含词、猎头 / 外包策略 | 30K / 空 / 硕博 / 实习·储备·销售·客服 4 条固定 + 追加 / Go C++ Rust PHP C# / AI 系列词 / reject / review |
| `pacing` | 每轮最多发几个、发送间隔、时间预算 | 7 / 20-35s / 480s |

不在 profile 里的（反爬解码、选择器、会话定位、发送兜底、间隔下限 15s）是机制，改了只会坏。

## 数据目录

| 路径 | 内容 |
|---|---|
| `~/.boss-auto-apply/profile.json` | 你的身份 + 偏好 |
| `~/.boss-auto-apply/applied-ledger.json` | 总台账（已投 / 已淘汰），首跑自动创建 |
| `~/.boss-auto-apply/runs/YYYY-MM-DD-*/` | 每批次的 pool / shortlist / details.jsonl / checkpoint.jsonl |

数据与代码分开放，是因为 `npx skills update` 会把 skill 目录整个删掉重拷——个人数据放里面会被抹掉。位置沿用 skills 生态的主流做法 `~/.<工具名>/`（同类如 `~/.hyperframes`、`~/.baoyu-skills`），profile / 台账 / runs 放一起方便翻。换位置：`BOSS_APPLY_DATA=/path` 整体外置，`BOSS_APPLY_PROFILE=/path/profile.json` 单独指定 profile。

## 开发

```bash
git clone https://github.com/limboinf/boss-auto-apply-skill.git && cd boss-auto-apply-skill
for t in tests/*.js; do node "$t"; done     # 离线测试，无需浏览器 / 网络（开发者跑测试才需要系统 Node ≥ 18）
```

- `scripts/pipeline_v2_lib.js` 主库：纯逻辑（`filterCards` / `evalDetail` / `makeHook` / `updateLedgerFromCheckpoint`）+ 浏览器流程（`discover` / `screenLoop`）
- `scripts/batch_apply_lib.js` 单岗投递与发送验证；`scripts/ego_browser_adapter.js` ego-browser 适配
- `scripts/profile.js` profile 加载 / 校验 / 默认值 + CLI
- 实战踩过的坑（猎头挂单、真实坐标点击、验证面板范围、BOSS 改版）见 [references/pitfalls.md](references/pitfalls.md)

## 注意

- 自动投递有账号风控风险，节奏参数已按实测保守设置，加快了后果自负
- BOSS 改版频繁，选择器失效时优先按文本定位，类名不可靠
- BOSS 账号的「自动打招呼语」会在点「立即沟通」时先发一条，要单条就去 BOSS 设置里关掉

## 许可

All Rights Reserved，未获授权勿商用。
