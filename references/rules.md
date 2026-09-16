# 规则怎么生效（都在 profile.rules，库只负责执行）

- **卡级（不开详情页就拦）**：黑名单公司、台账已投/已淘汰、本批重复公司、猎头挂单、固定 4 条 + `extraRejectTitles`、标题含 `rejectLanguages`、标签硬性 `rejectDegrees`、薪资（可解析时 Max ≥ `minSalaryK`；时薪/日薪/面议淘汰；打码留细筛）
- **详情级**：职位已关闭 / 薪资无法解析（不进台账，下轮重试）、面议、Max < `minSalaryK`、banner 硬性 `rejectDegrees`、JD 主语言命中 `rejectLanguages`（本句有"加分/优先/可选/了解"豁免）、固定 4 条 + `extraRejectTitles`、JD 未命中 `mustHaveKeywords`、外包特征按 `outsourcing` 策略
- **猎头挂单识别**（机制，不可配）：含「某」的 masked 公司名、「知名公司」「头部XX公司」、人力/猎头机构名。这类岗点沟通后会话挂在猎头名下，按原公司名找会话必失败
- **外包 `review`**：其余规则全过但命中外包/驻场/外派/派遣 → `NEEDS_REVIEW` 落 details.jsonl（带 JD 摘要），agent 读完判断，要投 `pipe.sendReviewed(runDir, '公司名')`，不投不用动
