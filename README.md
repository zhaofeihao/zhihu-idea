# 灵感雷达 · zhihu-idea

从知乎官方开放平台发现商业灵感、脑洞创意、认知突破、真实故事和交易，经过 AI 初筛、证据摘录与分类评分，生成飞书群简报。

当前为第一版可运行 MVP：本地手动执行，所有真实状态保存在 **Supabase 托管 PostgreSQL**；服务器使用同一程序定时运行。默认只预览，明确指定发送才调用飞书。无需本地数据库、网页前端、Redis 或复杂 Agent 框架。

**真实联调尚未完成**：没有接入你的数据库、知乎账户、模型账户或飞书群；离线样本均为虚构，测试不会产生外部费用。[验证范围](docs/VALIDATION.md)记录已测与未测内容。

## 1. 先看离线效果

使用 Node.js 24（`.nvmrc` 已指定）：

```bash
nvm use
npm ci
npm run demo
```

演示会打印五类精选和飞书分片数量，不读取真实内容、不连接数据库、不调用模型、不发送消息。`npm run dev` 显示 CLI 帮助，不会后台启动服务。

## 2. 配置真实接入

复制环境配置并用编辑器填写，不要把密钥粘贴到聊天、Git 或日志：

```bash
cp .env.example .env
```

| 变量                                 | 用途                                                        |
| ------------------------------------ | ----------------------------------------------------------- |
| `DATABASE_URL`                       | Supabase Connect 面板的 PostgreSQL 连接串，包含数据库密码   |
| `DATABASE_CA_FILE`                   | 如连接需要专用 CA，填写证书文件路径；始终验证 TLS 证书      |
| `ZHIHU_ACCESS_SECRET`                | 知乎数据开放平台 Access Secret                              |
| `DEEPSEEK_API_KEY`                   | 选择 DeepSeek 的阶段需要                                    |
| `OPENAI_API_KEY`                     | 选择 GPT 的阶段需要                                         |
| `SCREEN_PROVIDER` / `SCREEN_MODEL`   | 初筛提供商与当前账号可用模型 ID                             |
| `ANALYZE_PROVIDER` / `ANALYZE_MODEL` | 深度分析提供商与模型 ID                                     |
| `FEISHU_WEBHOOK_URL`                 | 专用飞书群自定义机器人 Webhook，发送时需要                  |
| `FEISHU_SIGNING_SECRET`              | 机器人启用签名校验时需要                                    |
| `RADAR_NAMESPACE`                    | 运行空间，默认 `personal`，服务器与电脑使用相同值可共享状态 |

两个模型阶段均可选择 `deepseek` 或 `openai`，可全部用低价模型，也可 DeepSeek 初筛、GPT 深度分析。模型 ID 不预设，避免失效型号；GPT 路径使用支持结构化输出的 Responses API，DeepSeek 使用 JSON 模式并做本地 schema 校验。可选 base URL 必须指向你信任且兼容的服务，不能把密钥发送到不明代理。

Supabase 第一版**不需要 anon / service_role API key**，使用服务端数据库连接。IPv4 网络优先选 **Session pooler**，有 IPv6 可选 Direct connection；复制面板提供的地址，不自行猜测。Free 闲置项目可能暂停，需要在控制台恢复；也不包含自动数据库备份，详见[官方额度](https://supabase.com/pricing)和[连接文档](https://supabase.com/docs/guides/database/connecting-to-postgres)。

先检查连接，再显式初始化云端表：

```bash
npm run doctor
npm run db:migrate
npm run doctor -- --zhihu
```

`doctor` 不输出密钥；`--zhihu` 才会真实查询一次账户额度、一次小搜索，消耗相应知乎额度，不调用模型。迁移使用专用事务、校验和与数据库锁，可重复执行；创建私有 `radar` schema，不修改 `public` 业务表。请使用独立项目或先确认名称没有冲突。不要把 `radar` 加到 Supabase Data API exposed schemas；部署前建议将迁移账号与最小权限运行账号分开。

## 3. 本地小批量运行

```bash
# 真实采集、分析并保存到 Supabase；只打印，不发飞书
npm run run -- --limit=20

# 满意后发送已生成简报，不重新采集或调用模型
npm run preview -- --id=<终端显示的-run-id>
npm run send -- --id=<run-id>

# 也可一次生成并发送（明确的真实发送入口）
npm run run -- --limit=20 --send
```

飞书使用 schema 2.0 卡片，带原文按钮、证据范围和反馈短编号；过长时按 UTF-8 字节分片。HTTP 200 和业务 `code=0` 分别检查。群机器人是单向发送，不支持直接点击卡片完成评价。

更多操作：

```bash
# 只采集；--stage=analyze 需要恢复这次运行
npm run run -- --limit=20 --stage=discover
npm run run -- --resume=<run-id> --stage=analyze

# 中断恢复（使用这次任务保存的配置，不能同时修改 limit/category/revision）
npm run run -- --resume=<run-id>

# 当天继续试不同版本，可能新增模型费用；不是默认重跑
npm run run -- --limit=20 --revision=trial-2
npm run run -- --category=creative --limit=20

# 只搜索交易类：股票、加密货币、套利、ETF、期货、期权、量化等
npm run run -- --category=trading --limit=20

# 查看飞书 JSON，不发送
npm run preview -- --id=<run-id> --cards

# 反馈：interesting / neutral / skip；新任务参考最近 20 条反馈
npm run feedback -- --id=<简报中的短编号> --rating=interesting --reason="喜欢跨领域组合"
```

同日期、运行空间、运行版本和配置生成相同 run ID，普通重跑复用既有简报。分析缓存由内容指纹、模型、提示词、反馈及文本限制决定。改变配置会生成新运行，改变提示词后要用新的 `--revision` 才能重新编排已完成的简报。预览结果不算“已经推送”；成功或结果未知的推送会进入历史去重。

如果飞书请求超时，状态为 `unknown`，**不会自动重复发送**。先查看群：确实没收到才执行 `npm run send -- --id=<run-id> --allow-unknown`，已成功分片跳过。如果明确要把整份再发一次，`send --revision=resend-2` 会新建发送版本，必须谨慎使用。

## 4. 筛选、探索与预算

可编辑 `config/radar.json`，查询池与模型阶段独立配置；`--config=<路径>` 可指定配置文件。

**话题可自由定义。** 内置五类（`business`/`creative`/`insight`/`story`/`trading`）只是默认，不再强制配齐：`discovery.queries` 里保留你关心的话题即可，每个话题至少 1 条查询、**数量不限**。话题键是任意字符串（支持中文、字母数字、下划线、短横），所以可直接新增自定义话题，例如：

```json
"discovery": {
  "queries": {
    "insight": ["有哪些高手才懂、外行想不到的底层逻辑"],
    "养生": ["民间养生偏方里的硬核经验", "被误解的养生常识"]
  }
},
"topics": {
  "养生": {
    "label": "养生",
    "description": "一线中医/民间实践里反直觉但可检验的养生机制与经验",
    "weights": { "novelty": 35, "inspiration": 35, "business": 0, "evidence": 20, "quality": 10 }
  }
}
```

可选的 `topics` 为每个话题提供展示名 `label`、给模型分类用的含义 `description`、以及评分 `weights`（五维整数，和必须为 100）。**未配置 `weights` 的自定义话题默认套用"认知突破"那套扫地僧权重**（新颖 30 / 启发 35 / 商业 0 / 证据 20 / 质量 15）；未配置 `label` 时回退到内置标签或话题键本身。`--category=<话题键>` 只跑单个话题，必须是 `discovery.queries` 中已配置的话题。生效话题会被注入初筛/分析提示词，模型只能把 `category` 判定为其中之一。

`trading` 为内置交易话题。查询池覆盖股票复盘、流动性与滑点、加密货币资金费率/跨交易所套利、ETF 折溢价、期现/跨期套利、量化回测与实盘差异、期权对冲等，可继续追加问题。初筛侧重具体机制、成本、执行约束、风控和失败经验，过滤只有喊单、荐股荐币、收益截图、带单宣传或无依据预测的内容。分析不能把历史收益或套利价差描述为当前可复制的无风险机会。

交易评分权重为新颖性 25%、启发性 30%、商业价值 10%、证据充分度 20%、内容质量 15%；商业价值在此评价机制的实际用途，不按宣称收益打分。数据结构版本为 `v2`，评分规则版本为 `v3`，初筛/分析提示词版本为 `screen-v4` / `analyze-v4`，新分析不复用旧规则缓存。自 `v3` 起采用"扫地僧"筛选策略：抬高新颖性与启发性权重，让"意外/颠覆认知/大为震撼"主导排序，并在提示词中打压学术腔、官方腔、报告体与面面俱到的科普（即便严谨、引用充分，若无意外的一手洞见也降权或拒绝）；证据与质量仍作为选编硬门槛。`limits.brief` 配置范围为 1–10；精选条数不超过生效话题能供应的合格内容，实际仍可少发。

- 默认轮换普通、低赞数与历史编辑时间排序搜索，不只取热榜。搜索每次最多 10 条，不能按未公开的分页方式全站遍历。
- `recommendations` 默认关闭，账号验证后可开启问题推荐和受限的问题回答翻页；热榜另有 `hot` 开关。仅标题用于发现，不进入深度分析。
- 初筛走"扫地僧"策略：优先一线/民间的亲历细节、反常机制、失败经验与可验证创意，要求存在一个让人意外、颠覆直觉的"震撼点"；过滤缺少实质信息的通稿、宣传、宏观套话、泛泛趋势判断，以及正确但平淡的学术腔/官方腔/科普综述。模型会收到作者字段，但不凭机构身份加分或一律拒绝，个人号同样需要具体发现。规则在 `prompts/screen.md`，深度分析使用一致偏好。
- 抽查少量拒绝样本仅用于检查误筛，结果保存但不进入简报或关联探索；只有初筛 `keep` 的条目有推荐资格。深度分析摘录必须真实存在于输入文本。程序按每个话题的权重算分（内置默认或配置覆盖，自定义话题默认套用认知突破权重），优质脑洞无需商业价值。
- 精选先保证合格类别的多样性，再按质量排序；证据不足不凑数。AI 推演、创意假设和来源描述明确区分。证据充分度不等于外部事实核验。
- 默认最多 4 个关联查询、探索一层，并给新探索内容预留后段深度分析机会。
- 每个运行空间、北京时间自然日共用知乎调用、模型调用及 token 预算。调用前原子预留；初筛提前收手，为深度分析留额度；未知用量保留估计额度。两台机器共用数据库租约，避免同空间并行任务。

候选默认 200、深度分析最多 15、简报最多 8；这些是上限，不保证接口一定供应足够内容。token 预留按 UTF-8 字节、schema 和输出上限保守估计，实际用量可用时回填。`dailyCost` 默认 `null`，表示金额预算未开启，**不表示免费**；若启用，必须给两阶段填写同币种每百万输入/输出 token 单价。实际账单为准，不含未知知乎计费，不实现月预算。不同 namespace 的预算独立，不等于账户总额上限；`doctor --zhihu` 的联调调用不计业务预算。

## 5. 后续部署服务器

[部署与运维说明](docs/DEPLOYMENT.md)包括 Docker、调度、证书、升级和恢复。

```bash
docker compose build
docker compose run --rm radar node dist/cli.js doctor
docker compose run --rm radar node dist/cli.js migrate
docker compose up -d
```

常驻服务才启用定时器：北京时间 07:00 开始，09:00 截止新增工作，选编已完成分析并发送；健康检查和数据库/发送耗时可能造成少量延迟。晚启动只补当天，最多再采集 10 分钟，不补发多天。电脑关闭不能运行，本地测试命令不自动创建任何无人值守任务。

## 6. 存储、测试与扩展

```bash
npm run maintenance          # 只报告容量和候选
npm run maintenance -- --apply # 显式执行清理，会清空符合策略的旧文本
npm run format:check
npm run typecheck
npm test
npm run build
node dist/cli.js demo
```

清理影响 `radar` 的所有运行空间：未精选摘要 30 天、精选大文本 90 天，删除 30 天前失败用量明细；保留精选快照、证据摘录、反馈、指纹以及待恢复任务的文本。未启用自动清理/自动备份。成功分析缓存、任务与成功调用明细仍会累积，使用 Free 时需持续观察容量，不能保证无限运行不超额。

目录与扩展位置：

| 位置                                   | 职责                                                           |
| -------------------------------------- | -------------------------------------------------------------- |
| `src/domain.ts` / `config` / `prompts` | 统一数据、评分、查询配置、可版本化提示词                       |
| `src/sources/zhihu.ts`                 | 官方字段与分页隔离；新增平台实现 `Source`，再扩展查询计划/配置 |
| `src/models.ts`                        | `Model` 接口、DeepSeek / GPT 适配、用量与输出校验              |
| `src/pipeline.ts`                      | 发现→初筛→分析→受控探索→选编→检查点                            |
| `src/storage.ts` / `migrations`        | 云端 PostgreSQL、租约、缓存、预算、发送台账                    |
| `src/delivery.ts`                      | `DeliveryAdapter` 接口、飞书卡片与发送；可加入其他渠道         |
| `src/cli.ts` / `src/service.ts`        | 手动与定时入口；不重复实现业务逻辑                             |
| `fixtures` / `tests`                   | 虚构样本、注入 HTTP、内存 PostgreSQL，无真实发送/费用          |

`agent/` 是早前 Eve 模板，仅保留文件，不参与构建或运行。[原始方案与实施差异](docs/DESIGN.md)、[接口核验与测试边界](docs/VALIDATION.md)。作者追踪、全文补充、语义聚类、自动偏好调权、卡片评价、备份与更强容量守卫留到后续，不冒充已实现。
