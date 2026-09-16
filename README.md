# boss-auto-apply-skill

<p align="center">
  <img src="assets/banner.webp" alt="帮我投BOSS —— AI Agent 自动投递 · 多城市多岗位" width="100%">
</p>

> [!WARNING]
> **免责声明**
> - 本项目仅供学习交流与个人求职辅助，使用时请遵守 BOSS直聘用户协议及相关法律法规。
> - 自动投递有可能存在**账号风控风险**，轻则限流、重则封号。默认节奏参数已按实测保守设置，如果你擅自调快频率、加大投递量，**后果自负**。
> - 请克制使用：**不做频繁操作**（多开并发、全天连投），**不做恶意操作**（刷投递量、骚扰 HR、尝试绕过平台风控）。
> - 本项目按「现状」提供，作者不对因使用本项目导致的任何账号损失或纠纷承担责任。

BOSS直聘自动投递 **Agent Skill**，任何行业、任何城市、应届和实习生都能用。装进 Claude Code / Codex / Cursor 等任意支持 skills 的 agent，对它说一句「帮我投 BOSS」，它先引导你把身份和想投的城市 / 岗位问清楚，再按**你自己的** `profile.json` 跑完：多城市多岗位粗筛（滚动记录）→ 细筛（串行单岗闭环，过审即发不攒批）→ 台账回填。防风控、断点续跑、猎头挂单过滤、列表页反爬薪资字体解码。

代码里没有任何个人信息，也**没有任何行业预设**（默认不限薪资、不限经验、不拦任何岗位类型）——谁在投、投哪、投什么、拦什么，全部来自你的 profile；信息不全，agent 不会开始投。

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

**不用敲命令。** 装完直接对 agent 说「帮我投 BOSS」，它会按 [SKILL.md](SKILL.md)「首次使用」分两轮问你：

1. **必填三项**：一句话自我介绍、想投哪些城市（可多个，填城市名即可）、想投哪些岗位（可多个方向）
2. **可选项**（都有默认值，可以直接跳过）：工作年限档、期望最低月薪、作品链接、话术、不投的公司 / 岗位类型 / 学历要求 / 主语言……

agent 自己写到 `~/.boss-auto-apply/profile.json`，校验后把摘要念给你确认，你说 OK 才开始投。之后想换城市、加岗位、改薪资线，直接跟它说。

想自己手填也行：照 [assets/profile.example.json](assets/profile.example.json) 写到 `~/.boss-auto-apply/profile.json`，然后让 agent「检查一下 profile」。

## 日常使用

对 agent 说「跑今天的投递批次」即可。它会走三步（每步都在 [SKILL.md](SKILL.md) 里有可直接执行的代码）：

1. **粗筛 DISCOVER**：按 `search.cities × search.queries` 逐城市逐关键词搜索，URL 带服务端筛选（薪资档由 `minSalaryK` 派生 + 工作年限，没填就不筛），真实滚轮到平台期，全量落盘；卡级规则过滤（黑名单 / 学历 / 岗位类型 / 主语言 / 薪资 / 公司去重 / 台账排除 / 猎头挂单——除猎头外全是你 profile 里填了才生效）。列表页薪资反爬字体每批开 1 个详情页校验映射后直接解码
2. **细筛 SCREEN**：逐岗开详情页读真实薪资 + JD 判定；通过**立即发送**定制打招呼语并验证、当场记账，随机间隔后下一岗。外包岗默认落 `NEEDS_REVIEW` 交 agent 读 JD 判断
3. **收尾 LEDGER**：从 checkpoint 幂等回填总台账（applied / eliminated），跨批次不重复投

想定时跑：[assets/cron-prompt.txt](assets/cron-prompt.txt) 是给 agent 定时任务用的 prompt 模板，填上目标数量和通知渠道即可。

## 配置（profile.json）

模板 [assets/profile.example.json](assets/profile.example.json)（一个开发岗的示例画像，规则条目都是示例），字段逐条说明在 [SKILL.md](SKILL.md)「首次使用」。四块：

| 块 | 内容 | 默认 |
|---|---|---|
| `candidate.intro` / `search.cities` / `search.queries` | 自我介绍、城市（名或码，可多个）、岗位关键词（可多个） | **必填** |
| `candidate.links` / `hooks` / `message` | 作品链接、「JD 提到 X 就说 Y」话术、消息模板 | 无链接 / 无话术（走兜底句）/ 通用模板 |
| `rules` | 期望最低月薪、公司黑名单、岗位类型红线、学历红线、主语言红线、JD 必含词、猎头 / 外包策略 | **全部不限**（猎头 reject、外包 review 除外） |
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

- `scripts/pipeline.js` 主库：纯逻辑（`filterCards` / `evalDetail` / `makeHook` / `updateLedgerFromCheckpoint`）+ 浏览器流程（`discover` / `screenLoop`）
- `scripts/apply.js` 单岗投递与发送验证；`scripts/ego_browser_adapter.js` ego-browser 适配
- `scripts/profile.js` profile 加载 / 校验 / 默认值 + CLI
- 实战踩过的坑（猎头挂单、真实坐标点击、验证面板范围、BOSS 改版）见 [references/pitfalls.md](references/pitfalls.md)

## 注意

- 自动投递有账号风控风险，节奏参数已按实测保守设置，加快了后果自负
- BOSS 改版频繁，选择器失效时优先按文本定位，类名不可靠
- BOSS 账号的「自动打招呼语」会在点「立即沟通」时先发一条，要单条就去 BOSS 设置里关掉

## 许可

All Rights Reserved，未获授权勿商用。
