# 本地到服务器：部署与运维

应用执行在电脑或服务器，持久状态只在 Supabase；两端使用同一代码、云数据库、运行空间和配置即可接续，无需迁移本地数据库。

## 本地开发

Node.js 24，安装 `npm ci`，环境配置参照 README。`npm run run` 单次执行并退出，只预览；`--send` 是发送授权入口。`npm run dev` 只显示帮助，不是网页服务器。测试、demo 使用内存状态，不会因数据库失败退回本地数据库。

Ctrl+C / SIGTERM 停止新增工作，已完成内容和分析留在 Supabase。持久化前被强制终止的那一次 API 请求仍可能收费；不能承诺外部 API 与数据库间跨系统 exactly-once。租约约 90 秒，正常每 20 秒续期；强制退出后等待到期，再按终端 run ID 恢复。

## Supabase 初始化与安全

1. 建议建立专用项目。从 Connect 面板复制 Session pooler（IPv4）或 Direct（IPv6）连接串。不要使用 REST API 的 URL/anon key 代替 PostgreSQL 连接串。
2. 数据库密码内特殊字符使用面板合适格式或 URL 编码，不能在日志中打印。
3. 始终校验 TLS 证书。如果报证书链错误，从 Supabase 控制台获取官方 CA，配置 `DATABASE_CA_FILE`；不要用 `rejectUnauthorized=false` 或 `NODE_TLS_REJECT_UNAUTHORIZED=0` 绕过。
4. `npm run doctor` 验证连接；`npm run db:migrate` 明确创建私有 `radar` schema。迁移由专用连接持有事务，检查校验和；已应用 SQL 不要再改，下一版本需增加迁移。
5. `radar` 不配置成 Data API exposed schema，不直接给浏览器数据库密码。生产建议单独配置运行角色，仅授予 schema USAGE 与业务表所需 SELECT/INSERT/UPDATE/DELETE，迁移由管理角色执行。当前程序不自动建立角色或处理密码轮换。

Free 项目可能闲置暂停，先在控制台恢复。云存储不等于备份：需要另外建立私有远端备份和恢复演练，不能把当前程序当成已有自动备份。

## Docker

服务器安装 Docker Engine 与 Compose。复制代码和 lockfile，创建服务器自己的 `.env`，不要把密钥烘进镜像。构建上下文排除了 `.env*`、证书、`agent/` 和本地依赖。

```bash
docker compose build
docker compose run --rm radar node dist/cli.js doctor
docker compose run --rm radar node dist/cli.js migrate
docker compose run --rm radar node dist/cli.js run --limit=20
docker compose run --rm radar node dist/cli.js send --id=<已检查的-run-id>
docker compose up -d
docker compose logs --tail=100 -f radar
curl --fail http://127.0.0.1:8080/health
```

Compose 不包含 PostgreSQL 容器或本地数据库卷。镜像以非 root 运行、只读根文件系统、日志轮换、默认 512 MB 内存和小数据库连接池；按实际负载调整。

需要专用 CA 时，创建 `certs/supabase-ca.crt`，取消 Compose 的证书只读挂载注释，并把服务器 `.env` 中 `DATABASE_CA_FILE` 设为容器内 `/app/certs/supabase-ca.crt`。宿主机路径不能直接作为容器内路径。Supabase CA 是信任材料，不应从不明站点下载。

无 Docker 也可 `npm ci && npm run build`，由 systemd/你已有的进程管理器启动 `node dist/cli.js service`，工作目录设为项目根目录，注入同样环境。保持 Node 24、出站 HTTPS/PostgreSQL 可达、时间同步和进程重启策略。

## 定时与失败行为

- 配置时区固定为 Asia/Shanghai，不随服务器系统时区变化。
- 默认 07:00 收集、09:00 停止未完成调用并冻结可用结果；没分析完则发明确的有限覆盖状态，不伪装成“当天没有好内容”。每 30 秒检查调度，09:00 后的数据库操作/发送可能带来延迟。
- 09:00 后启动只补当前日期，最多采集 10 分钟再发送，不连续补历史日期。截止丢下的候选未保证会进入下一天队列，之后可以再发现，或手动新版本分析。
- 服务器只发送自身运行返回的快照，不误读同日手动试验的最新简报。重启生成相同 run ID，已发送分片跳过；改变模型或配置会生成新 run ID，可能在同一天产生另一份简报。
- 失败后约 5 分钟检查恢复，真实调用受每日预算限制。付费模型 SDK 隐式重试关闭，不自动切换高价提供商。
- 飞书确定失败可再次尝试；未知结果保持 unknown，不自动重发。确认群内未收到后，显式 `send --id=<id> --allow-unknown`。无法保证 Webhook 严格只投递一次。
- `GET /health` 只反映进程调度状态，不暴露密钥或内容。正在执行的长任务仍健康；最近一次任务失败返回 503。Docker 的 unhealthy 状态本身不会触发 restart，需监控日志/配置你自己的告警。
- 不要同时以相同 namespace 在电脑和服务器做开发试验。共用租约能防止同时工作，但不同时间的配置变更仍可能形成多个运行。开发建议单独 namespace；其预算与正式空间独立。

## 升级、回退与维护

1. 先跑离线验证：`npm run typecheck`、`npm test`、`npm run build`、`npm run demo`。
2. 确认远端备份可恢复；先停止旧服务，等待/确认租约释放。
3. 备份当前配置，构建新镜像，显式执行有版本号的新迁移，再 `docker compose up -d`。
4. 用 doctor、健康检查和日志确认，不以“容器启动”代替真实接口验证。
5. 回退代码/镜像时保留云端状态；涉及不兼容 schema 的迁移要单独制定恢复计划。不要盲删表、发送台账或运行记录。

`node dist/cli.js maintenance` 只读容量报告；`maintenance --apply` 才修改云端数据，清空所有 radar 运行空间符合保留期限的大文本、删除旧失败用量记录。大文本一旦清空不能靠本程序还原，仅可重新获取或从备份恢复。精选的提炼、关键证据、来源链接及历史去重字段仍保留；等待分析和失败任务的文本暂不清理。清理后空间未必立即下降，关注 PostgreSQL vacuum 和 Supabase 实际容量报告。

目前维护没有自动调度、350/400 MB 自动阈值、全量日志压缩或自动备份。成功缓存/成功明细会增长；成熟前先观察真实样本大小，再加入可测试的保留策略。不要对 500 MB 免费库做无限容量承诺。
