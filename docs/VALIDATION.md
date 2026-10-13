# 接口核验与测试边界

日期：2026-10-10。文档核验、离线 HTTP 合同测试与真实账户联调是三个不同阶段。

## 已读取的官方合同

| 接口                                                                                                  | 实现依据                                                                 | 限制                                                                    |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| [知乎搜索](https://developer.zhihu.com/docs?key=zhihu_search)                                         | GET `/api/v1/content/zhihu_search`，Query/Count/SortBy；PascalCase 字段  | Count ≤10；ContentText 是摘要；HasMore 当前固定 false，不臆造分页       |
| [问题推荐](https://developer.zhihu.com/docs?key=question_recommendations)                             | GET `/api/v1/user/question_recommendations`，Query/Count                 | 默认关闭；只提供标题/链接，不据此生成事实结论                           |
| [问题回答](https://developer.zhihu.com/docs?key=question_answers)                                     | GET `/api/v1/content/question_answers`，QuestionUrl/Offset/Limit；Paging | Limit ≤50；Summary 是摘要；空页继续依据 NextOffset，缺游标/不前进即停止 |
| [热榜](https://developer.zhihu.com/docs?key=hot_list)                                                 | GET `/api/v1/content/hot_list`，Limit                                    | 默认关闭；不能代替冷门发现                                              |
| 知乎鉴权/额度                                                                                         | Bearer Access Secret + 秒级 X-Request-Timestamp；GET `/api/v1/quota`     | 本程序不拿用户关注/收藏推断任意作者更新权限                             |
| [飞书群机器人](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)                     | POST Webhook，schema 2.0 卡片，业务 code，HMAC 签名                      | 20 KB 消息上限，应用按约 18 KB 分片并串行发送；单向推送，无评价回调     |
| [GPT 结构化输出](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses) | OpenAI Responses API + AI SDK Output.object                              | 必须选支持该 API 和结构化输出的模型；不代表所有 GPT/代理兼容            |
| DeepSeek                                                                                              | 当前已安装 SDK 提供商文档：JSON 输出、schema 注入、thinking disabled     | 使用当前账号模型 ID；输出再次做本地 schema 与证据摘录校验               |

保留原文 URL 的来源追踪参数，去重 URL 单独规范化。知乎 EditTime 标为“编辑时间”，**不等同于发表时间**。作者/时间缺失明确标为未知。不声称当前已经获得回答全文。

## 已完成的离线验证

- 五类评分和选编、无商业价值脑洞不过度降权、标题不足排除、营销过滤。
- 交易类默认/单类别查询计划、独立评分、初筛结构化输出、离线完整流程、Markdown/飞书卡片展示和内存 PostgreSQL 持久化恢复。交易样本虚构，未验证真实模型判断或交易策略收益。
- 作者字段传入真实提供商请求；注入模型的高分拒绝样本可抽查保存，但不能进入简报或触发关联探索；全部不合格时生成空简报。此回归测试不验证真实模型对通稿/宣传的识别准确率。
- 实际 PostgreSQL SQL 的迁移幂等、云状态式恢复、预算原子更新、反馈空间隔离、维护保留精选。测试 PostgreSQL 是 PGlite 内存实例，不建立本地持久化库。
- 同运行重跑复用、模型缓存、中途失败恢复、租约互斥、每日额度不足/采集截止的状态区分。
- 注入 HTTP 测试真实提供商适配器请求形状：DeepSeek JSON 模式与 GPT Responses；非结构化/供应商失败不泄露原始响应。
- 飞书签名、字节分片、文本防插入通知/额外链接、业务错误码、超时结果未知、显式重试、已发送跳过。
- 服务健康接口、北京时间调度/截止、只发送指定快照和停止后关闭端口。
- TypeScript 类型检查、生产编译和编译后的离线 CLI。

这些测试证明程序边界行为，不证明 AI 判断“有意思”的质量，也不证明真实账户权限或网络可达。

## 尚未验证

1. Supabase 实际连接、证书、账号权限、真实迁移和容量。
2. 知乎账户额度、上述能力的权限和实际供应质量/低热度覆盖。
3. 用户所选 DeepSeek/GPT 的结构化输出成功率、单价、真实 token 和评审效果。
4. 专用飞书群的签名/关键词配置、卡片真实渲染与端到端发送。
5. Docker 镜像构建和真实服务器定时运行；当前本机 Docker 引擎未运行，仅验证 Compose 配置与生产 Node 入口。
6. 人工标注/两周体验评估、外部事实核验、完整语义去重、长期容量/备份恢复。

## 建议真实验收顺序

配置 `.env` → doctor → 显式迁移 → doctor --zhihu → 20 条预览 → 人工比较五类结果 → 确认后发送同一简报 → 模拟失败恢复 → 观察实际用量 → 部署服务器。

先完成 DeepSeek 小样本，再使用同一候选与另一模型单独试验；换模型/运行版本可能增加费用，不自动替你调用付费账户。飞书真实验收仅发送到已配置的专用群。
