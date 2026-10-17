import { readFile } from "node:fs/promises";
import { z } from "zod";

const model = z.object({
  provider: z.enum(["deepseek", "openai"]),
  model: z.string(),
  inputPerMillion: z.number().nonnegative().nullable(),
  outputPerMillion: z.number().nonnegative().nullable(),
});
// 话题键：字母数字下划线短横，含中文；用于内置五类与自定义话题。
const topicKey = z.string().regex(/^[\w\u4e00-\u9fa5-]{1,40}$/);
const topicWeights = z
  .object({
    novelty: z.number().int().min(0).max(100),
    inspiration: z.number().int().min(0).max(100),
    business: z.number().int().min(0).max(100),
    evidence: z.number().int().min(0).max(100),
    quality: z.number().int().min(0).max(100),
  })
  .refine(
    (w) =>
      w.novelty + w.inspiration + w.business + w.evidence + w.quality === 100,
    { message: "话题权重五个维度之和必须为 100" },
  );
const topicMeta = z.object({
  label: z.string().min(1).max(20).optional(),
  description: z.string().max(400).optional(),
  weights: topicWeights.optional(),
});
export const configSchema = z.object({
  namespace: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
  timezone: z.literal("Asia/Shanghai"),
  category: topicKey.nullable().default(null),
  schedule: z.object({
    collect: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    deliver: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  }),
  limits: z.object({
    candidates: z.number().int().min(1).max(300),
    screenKeep: z.number().int().min(1).max(100),
    deep: z.number().int().min(1).max(50),
    brief: z.number().int().min(1).max(10),
    queries: z.number().int().min(1).max(100),
    exploration: z.number().int().min(0).max(10),
    answerPages: z.number().int().min(1).max(5),
    textChars: z.number().int().min(200).max(12000),
    outputTokens: z.number().int().min(500).max(6000),
    dailyTokens: z.number().int().min(1000),
    dailyModelCalls: z.number().int().min(1),
    dailySourceCalls: z.number().int().min(1),
    dailyCost: z.number().positive().nullable(),
  }),
  selection: z.object({
    minScore: z.number().min(0).max(100),
    minEvidence: z.number().min(0).max(100),
    auditRejected: z.number().int().min(0).max(5),
  }),
  models: z.object({ screen: model, analyze: model }),
  discovery: z.object({
    recommendations: z.boolean(),
    hot: z.boolean(),
    lowVoteMax: z.number().int().nonnegative(),
    // 话题自由定义：可只保留关心的话题（含内置五类）、也可新增自定义话题，每个话题至少 1 条查询、数量不限。
    queries: z
      .record(topicKey, z.array(z.string().min(1).max(120)).min(1))
      .refine((q) => Object.keys(q).length >= 1, {
        message: "discovery.queries 至少配置一个话题",
      }),
  }),
  // 话题元数据：展示名、给模型的含义说明、评分权重；未配置则用内置默认或通用默认。
  topics: z.record(topicKey, topicMeta).optional(),
});
export type Config = z.infer<typeof configSchema>;
export async function loadConfig(
  path = "config/radar.json",
  env = process.env,
): Promise<Config> {
  const c = configSchema.parse(JSON.parse(await readFile(path, "utf8")));
  if (c.schedule.deliver <= c.schedule.collect)
    throw new Error("推送时刻必须晚于同日采集时刻");
  if (c.category && !(c.category in c.discovery.queries))
    throw new Error(
      `category=${c.category} 不在 discovery.queries 配置的话题中`,
    );
  if (env.RADAR_NAMESPACE)
    c.namespace = configSchema.shape.namespace.parse(env.RADAR_NAMESPACE);
  for (const stage of ["screen", "analyze"] as const) {
    const prefix = stage.toUpperCase();
    if (env[`${prefix}_PROVIDER`])
      c.models[stage].provider = model.shape.provider.parse(
        env[`${prefix}_PROVIDER`],
      );
    if (env[`${prefix}_MODEL`]) c.models[stage].model = env[`${prefix}_MODEL`]!;
  }
  if (
    c.limits.dailyCost !== null &&
    Object.values(c.models).some(
      (m) => m.inputPerMillion === null || m.outputPerMillion === null,
    )
  )
    throw new Error(
      "启用金额预算前，请为两个阶段配置同币种模型单价；也可先用 token/调用上限",
    );
  return c;
}
export function requireEnv(name: string, env = process.env): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`缺少 ${name}，请配置 .env（参考 .env.example）`);
  return value;
}
export function validateModels(c: Config, env = process.env) {
  for (const m of Object.values(c.models)) {
    if (!m.model)
      throw new Error(
        "请设置 SCREEN_MODEL 和 ANALYZE_MODEL，使用账号当前可用模型 ID",
      );
    requireEnv(
      m.provider === "openai" ? "OPENAI_API_KEY" : "DEEPSEEK_API_KEY",
      env,
    );
  }
}
export function safeError(error: unknown): string {
  let message = error instanceof Error ? error.message : "未知错误";
  for (const name of [
    "DATABASE_URL",
    "ZHIHU_ACCESS_SECRET",
    "DEEPSEEK_API_KEY",
    "OPENAI_API_KEY",
    "FEISHU_WEBHOOK_URL",
    "FEISHU_SIGNING_SECRET",
  ]) {
    const secret = process.env[name];
    if (secret && secret.length >= 8)
      message = message.split(secret).join("[密钥已隐藏]");
  }
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[数据库连接已隐藏]")
    .replace(/https?:\/\/[^\s)]+/gi, "[URL 已隐藏]")
    .replace(/(?:sk-|Bearer\s+)[a-zA-Z0-9_.-]+/g, "[密钥已隐藏]")
    .slice(0, 500);
}
