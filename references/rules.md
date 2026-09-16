# 规则怎么生效（都在 profile.rules，库只负责执行；默认全部「不限」）

库里**没有任何行业预设**：不填规则 = 什么都不拦（除猎头挂单，那是机制原因）。每条规则只在用户填了才生效。

- **卡级（不开详情页就拦）**：黑名单公司 `blockCompanies`、台账已投/已淘汰、本批重复公司、猎头挂单（`headhunter: reject`）、`rejectTitles` 正则命中标题/标签、标题含 `rejectLanguages`、标签硬性 `rejectDegrees`、薪资（`minSalaryK > 0` 时：可解析则 Max ≥ 它；时薪/日薪/面议淘汰；打码留细筛。`minSalaryK = 0` 一律保留）
- **详情级**：职位已关闭（不进台账，下轮重试）、薪资（`minSalaryK > 0` 时：面议淘汰、解析不出不进台账下轮重试、Max < 线淘汰；`= 0` 全放行）、banner 硬性 `rejectDegrees`、JD 主语言命中 `rejectLanguages`（本句有"加分/优先/可选/了解"豁免）、`rejectTitles`、JD 未命中 `mustHaveKeywords`（空 = 不限）、外包特征按 `outsourcing` 策略
- **多城市**：`search.cities` 逐城市 × 逐关键词搜，池子按 url 去重后统一过卡级规则；同一公司在两个城市都有岗只投一次（本批重复公司）
- **服务端筛选**：`minSalaryK` 派生薪资码、`experienceCodes` 直接带上列表 URL，让 BOSS 那边先砍一刀；两者都空就不带参数
- **猎头挂单识别**（机制，不可配）：含「某」的 masked 公司名、「知名公司」「头部XX公司」、人力/猎头机构名。这类岗点沟通后会话挂在猎头名下，按原公司名找会话必失败——所以默认过滤不是偏好，是发送验证做不了
- **外包 `review`**：其余规则全过但命中外包/驻场/外派/派遣 → `NEEDS_REVIEW` 落 details.jsonl（带 JD 摘要），agent 读完判断，要投 `pipe.sendReviewed(runDir, '公司名')`，不投不用动。做销售/客服/人力行业的用户，「人力资源服务」类公司是正常雇主，可设 `outsourcing: allow`
