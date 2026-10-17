import "dotenv/config";
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { loadConfig, requireEnv, validateModels, safeError } from "./config.js";
import { markdown } from "./domain.js";
import { connect } from "./storage.js";
import { MemoryStore } from "./memory-store.js";
import { Pipeline, withLease } from "./pipeline.js";
import { AiModel } from "./models.js";
import { ZhihuSource } from "./sources/zhihu.js";
import { FeishuSender, deliver, cards } from "./delivery.js";
import { service } from "./service.js";

const help = `灵感雷达 · 本地手动执行 / Supabase / 飞书

  npm run demo                          离线样本，无外部调用
  npm run doctor                        检查配置和数据库；--zhihu 验证真实知乎接口
  npm run db:migrate                    在已配置云数据库创建 radar schema
  npm run run -- --limit=20              真实采集与分析，默认仅预览
  npm run run -- --send                  生成并推送专用飞书群
  npm run run -- --stage=discover        仅采集
  npm run run -- --resume=<run-id>        恢复同一次任务
  npm run run -- --revision=<name>        创建同日新的运行版本
  npm run preview -- --id=<run-id>        读取已有简报；--cards 看飞书 JSON
  npm run send -- --id=<run-id>           发送已有简报，已发送分片跳过
  npm run send -- --id=<id> --allow-unknown 确认群内状态后重试未知分片
  npm run feedback -- --id=<短编号> --rating=interesting --reason=喜欢的原因
  npm run maintenance                   查看容量和清理候选；--apply 执行保留策略
  npm run service                       常驻定时；仅此入口启动调度

所有真实模式使用 Supabase。模型 ID 在 .env 设置；--send 才发送。
--stage=analyze 必须配合 --resume；--category 取配置 discovery.queries 中的某个话题。
rating 可为 interesting / neutral / skip。Ctrl+C 停止，已完成结果保留。`;
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      send: { type: "boolean" },
      cards: { type: "boolean" },
      zhihu: { type: "boolean" },
      apply: { type: "boolean" },
      "allow-unknown": { type: "boolean" },
      id: { type: "string" },
      resume: { type: "string" },
      revision: { type: "string" },
      stage: { type: "string" },
      limit: { type: "string" },
      category: { type: "string" },
      rating: { type: "string" },
      reason: { type: "string" },
      config: { type: "string" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(help);
    return;
  }
  if (
    ![
      "demo",
      "doctor",
      "migrate",
      "run",
      "preview",
      "send",
      "feedback",
      "maintenance",
      "service",
    ].includes(command)
  )
    throw new Error("未知命令，请执行 npm run dev 查看帮助");
  const c = await loadConfig(values.config);
  if (values.limit) {
    const n = Number(values.limit);
    if (!Number.isInteger(n) || n < 1 || n > 300)
      throw new Error("--limit 必须为 1–300");
    c.limits.candidates = n;
  }
  if (values.category) {
    if (!(values.category in c.discovery.queries))
      throw new Error("--category 必须是 discovery.queries 中配置的话题");
    c.category = values.category;
  }
  if (command === "demo") {
    const { DemoSource, DemoModel } = await import("./demo.js");
    const store = new MemoryStore();
    const model = new DemoModel();
    c.limits.queries = Object.keys(c.discovery.queries).length;
    c.limits.candidates = 20;
    const result = await new Pipeline(store, new DemoSource(), model).run(c, {
      signal: controller.signal,
    });
    console.log(
      "\n【离线演示：所有内容虚构，未访问知乎/模型/数据库，未发送飞书】\n" +
        markdown(result.brief!),
    );
    console.log(
      `\n飞书预览：${cards(result.brief!).length} 个分片；样本模型调用 ${model.calls} 次`,
    );
    return;
  }
  if (command === "doctor") {
    for (const name of [
      "DATABASE_URL",
      "ZHIHU_ACCESS_SECRET",
      "DEEPSEEK_API_KEY",
      "OPENAI_API_KEY",
      "SCREEN_MODEL",
      "ANALYZE_MODEL",
      "FEISHU_WEBHOOK_URL",
    ])
      console.log(`${name}: ${process.env[name] ? "已配置" : "未配置"}`);
    if (process.env.DATABASE_URL) {
      const db = await connect();
      try {
        const row = (
          await db.store.db.query(
            "SELECT to_regclass('radar.runs') AS table_name",
          )
        ).rows[0];
        console.log(
          row.table_name
            ? "数据库连接成功，表已存在"
            : "数据库连接成功，请执行 npm run db:migrate",
        );
      } finally {
        await db.close();
      }
    }
    if (values.zhihu) {
      const source = new ZhihuSource(requireEnv("ZHIHU_ACCESS_SECRET"));
      console.log(
        "知乎额度：" + JSON.stringify(await source.quota(controller.signal)),
      );
      const [probeTopic] = Object.keys(c.discovery.queries);
      const page = await source.fetch(
        {
          id: "doctor",
          kind: "search",
          text: c.discovery.queries[probeTopic][0],
          category: probeTopic,
        },
        2,
        controller.signal,
      );
      console.log(
        `搜索连通：${page.items.length} 条，范围 ${[...new Set(page.items.map((x) => x.scope))].join(",")}，作者字段 ${page.items.filter((x) => x.author).length} 条。未调用模型或推送。`,
      );
    }
    return;
  }
  if (
    command === "run" &&
    values.stage &&
    !["discover", "analyze", "all"].includes(values.stage)
  )
    throw new Error("--stage 无效");
  if (command === "run" && values.stage === "analyze" && !values.resume)
    throw new Error("单独分析请使用 --resume=<采集 run ID>");
  if (
    command === "run" &&
    values.resume &&
    (values.limit || values.category || values.revision)
  )
    throw new Error("恢复使用原运行配置，不能同时指定 limit/category/revision");
  if (command === "run" || command === "service") {
    requireEnv("ZHIHU_ACCESS_SECRET");
    if (values.stage !== "discover" && !values.resume) validateModels(c);
  }
  if (
    command === "service" &&
    (values.stage ||
      values.resume ||
      values.revision ||
      values.limit ||
      values.category ||
      values.send)
  )
    throw new Error("定时服务请通过配置文件设置，不支持单次 run 专用参数");
  if (command === "run" && values.send && values.stage === "discover")
    throw new Error("仅采集不生成简报，不能与 --send 同时使用");
  const sender =
    values.send || command === "send" || command === "service"
      ? new FeishuSender(
          requireEnv("FEISHU_WEBHOOK_URL"),
          process.env.FEISHU_SIGNING_SECRET,
        )
      : null;
  const db = await connect();
  try {
    const { store } = db;
    if (command === "run" && values.resume) {
      const saved = await store.run(values.resume);
      if (!saved || saved.namespace !== c.namespace)
        throw new Error("当前运行空间内找不到要恢复的 run ID");
      if (values.stage !== "discover") validateModels(saved.config);
    }
    if (command === "migrate") {
      await db.migration();
      console.log("Supabase radar schema 迁移完成");
      return;
    }
    if (command === "preview" || command === "send") {
      const b = await store.brief(values.id, c.namespace);
      if (!b) throw new Error("没有已生成简报");
      if (b.namespace !== c.namespace)
        throw new Error("该简报不属于当前运行空间");
      if (command === "preview")
        console.log(
          values.cards ? JSON.stringify(cards(b), null, 2) : markdown(b),
        );
      else {
        await deliver(store, b, sender!, {
          allowUnknown: values["allow-unknown"],
          resend: values.revision,
          signal: controller.signal,
        });
        console.log("简报发送完成（已发送分片跳过）");
      }
      return;
    }
    if (command === "feedback") {
      if (
        !values.id ||
        !/^\w{8,64}$/.test(values.id) ||
        !["interesting", "neutral", "skip"].includes(values.rating || "")
      )
        throw new Error(
          "需要 --id=<短编号> 和 --rating=interesting|neutral|skip",
        );
      await store.feedback(
        c.namespace,
        values.id,
        values.rating!,
        values.reason?.slice(0, 600) || "",
      );
      console.log("反馈已保存，之后新运行会参考近期反馈");
      return;
    }
    if (command === "maintenance") {
      const report = (
        await store.db.query(
          "SELECT pg_size_pretty(pg_database_size(current_database())) AS database_size,(SELECT count(*) FROM radar.contents WHERE updated_at<now()-interval '30 days' AND body->>'text'<>'') AS old_texts",
        )
      ).rows[0];
      console.log(JSON.stringify(report));
      if (values.apply)
        await withLease(
          store,
          "__maintenance__",
          async () => {
            const sql = await readFile(
              new URL("../migrations/maintenance.sql", import.meta.url),
              "utf8",
            );
            await store.db.query(sql);
            console.log(
              "已对本项目所有运行空间执行保留策略；清空旧文本和删除旧失败用量明细，精选快照、反馈、指纹及待恢复文本保留",
            );
          },
          controller.signal,
        );
      return;
    }
    const pipeline = new Pipeline(
      store,
      new ZhihuSource(requireEnv("ZHIHU_ACCESS_SECRET")),
      new AiModel(),
    );
    const execute = (deadline?: number) =>
      pipeline.run(c, {
        resume: values.resume,
        revision: values.revision,
        stage: values.stage as "discover" | "analyze" | "all" | undefined,
        signal: controller.signal,
        deadline,
      });
    if (command === "run") {
      const result = await execute();
      if (result.brief) {
        console.log("\n" + markdown(result.brief));
        if (sender)
          await deliver(store, result.brief, sender, {
            signal: controller.signal,
          });
      }
      return;
    }
    await service(
      c,
      async (deadline) => (await execute(deadline)).brief,
      async (b) => {
        await deliver(store, b, sender!, { signal: controller.signal });
      },
      controller.signal,
    );
  } finally {
    await db.close();
  }
}
main().catch((error) => {
  console.error(
    controller.signal.aborted
      ? "任务已停止，可使用 run ID 恢复"
      : safeError(error),
  );
  process.exitCode = 1;
});
