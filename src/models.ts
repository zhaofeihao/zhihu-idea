import { readFile } from "node:fs/promises";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output, NoObjectGeneratedError } from "ai";
import { z } from "zod";
import { requireEnv, type Config } from "./config.js";
import {
  analysisSchema,
  schemaVersion,
  scoringVersion,
  screenSchema,
  hash,
  builtinLabels,
  builtinDescriptions,
  type Content,
  type Screening,
  type Analysis,
} from "./domain.js";

// 生效话题 = 配置里 discovery.queries 的键；category 只能取其中之一。
export function activeTopics(c: Config): string[] {
  return Object.keys(c.discovery.queries);
}
// 给模型用于分类的话题清单（键 + 展示名 + 含义）。
function topicGuide(c: Config) {
  return activeTopics(c).map((key) => ({
    key,
    label: c.topics?.[key]?.label ?? builtinLabels[key] ?? key,
    description: c.topics?.[key]?.description ?? builtinDescriptions[key] ?? "",
  }));
}

export type Phase = "screen" | "analyze";
export interface ModelResult {
  value: Screening | Analysis;
  input: number | null;
  output: number | null;
}
export interface Model {
  generate(
    phase: Phase,
    item: Content,
    preferences: string,
    c: Config,
    signal?: AbortSignal,
  ): Promise<ModelResult>;
}
export class ModelError extends Error {
  constructor(
    public input: number | null,
    public output: number | null,
    cause?: unknown,
  ) {
    super(
      "模型未返回可用结构化结果，请检查模型支持、输出上限、账户或网络；已保留可能的用量",
      { cause },
    );
  }
}
// A single result that parsed structurally but failed content validation
// (e.g. fabricated evidence quotes). It must be skipped per item rather than
// aborting the whole run and discarding already-spent work.
export class InvalidResultError extends Error {
  constructor(
    public phase: Phase,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}
const promptTexts: Record<Phase, string> = {
  screen: await readFile(
    new URL("../prompts/screen.md", import.meta.url),
    "utf8",
  ),
  analyze: await readFile(
    new URL("../prompts/analyze.md", import.meta.url),
    "utf8",
  ),
};
const promptVersions: Record<Phase, string> = {
  screen: "screen-v4",
  analyze: "analyze-v4",
};
export function prompt(
  phase: Phase,
  item: Content,
  preferences: string,
  c: Config,
) {
  return {
    instructions: promptTexts[phase],
    prompt: JSON.stringify({
      title: item.title,
      author: item.author,
      text: item.text.slice(0, c.limits.textChars),
      scope: item.scope,
      publishedAt: item.publishedAt,
      editedAt: item.editedAt ?? null,
      userFeedback: preferences,
      // category 必须从本清单中选择其一；label/description 说明每个话题的含义。
      topics: topicGuide(c),
    }),
  };
}
export function cacheKey(
  phase: Phase,
  item: Content,
  preferences: string,
  c: Config,
) {
  return hash(
    JSON.stringify({
      phase,
      id: item.id,
      input: prompt(phase, item, preferences, c),
      model: c.models[phase],
      version: promptVersions[phase],
      schemaVersion,
      scoringVersion,
      preferences,
      chars: c.limits.textChars,
    }),
  );
}
export function reservation(
  phase: Phase,
  item: Content,
  preferences: string,
  c: Config,
) {
  const p = prompt(phase, item, preferences, c);
  // UTF-8 bytes + schema + protocol margin is a conservative reservation, not exact tokenization.
  const topics = activeTopics(c);
  const input =
    Buffer.byteLength(
      JSON.stringify(p) +
        JSON.stringify(
          z.toJSONSchema(
            phase === "screen"
              ? screenSchema(topics)
              : analysisSchema(topics),
          ),
        ),
    ) + 1500;
  const output = c.limits.outputTokens;
  const m = c.models[phase];
  return {
    source: 0,
    calls: 1,
    tokens: input + output,
    cost:
      m.inputPerMillion === null || m.outputPerMillion === null
        ? 0
        : (input * m.inputPerMillion + output * m.outputPerMillion) / 1e6,
  };
}
export function estimatedCost(
  phase: Phase,
  input: number | null,
  output: number | null,
  c: Config,
): number | null {
  const m = c.models[phase];
  return input === null ||
    output === null ||
    m.inputPerMillion === null ||
    m.outputPerMillion === null
    ? null
    : (input * m.inputPerMillion + output * m.outputPerMillion) / 1e6;
}
export class AiModel implements Model {
  constructor(private http: typeof fetch = fetch) {}
  async generate(
    phase: Phase,
    item: Content,
    preferences: string,
    c: Config,
    signal?: AbortSignal,
  ): Promise<ModelResult> {
    const m = c.models[phase];
    if (!m.model) throw new Error(`缺少 ${phase.toUpperCase()}_MODEL`);
    const model =
      m.provider === "deepseek"
        ? createDeepSeek({
            apiKey: requireEnv("DEEPSEEK_API_KEY"),
            baseURL: process.env.DEEPSEEK_BASE_URL || undefined,
            fetch: this.http,
          })(m.model)
        : createOpenAI({
            apiKey: requireEnv("OPENAI_API_KEY"),
            baseURL: process.env.OPENAI_BASE_URL || undefined,
            fetch: this.http,
          }).responses(m.model);
    let input: number | null = null,
      output: number | null = null;
    try {
      const result = await generateText({
        model,
        ...prompt(phase, item, preferences, c),
        output: Output.object<Screening | Analysis>({
          schema:
            phase === "screen"
              ? screenSchema(activeTopics(c))
              : analysisSchema(activeTopics(c)),
        }),
        maxOutputTokens: c.limits.outputTokens,
        maxRetries: 0,
        abortSignal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(90000)])
          : AbortSignal.timeout(90000),
        ...(m.provider === "deepseek"
          ? {
              providerOptions: {
                deepseek: { thinking: { type: "disabled" as const } },
              },
            }
          : { providerOptions: { openai: { store: false } } }),
      });
      input = result.totalUsage.inputTokens ?? null;
      output = result.totalUsage.outputTokens ?? null;
      return { value: result.output, input, output };
    } catch (error) {
      if (NoObjectGeneratedError.isInstance(error)) {
        input = error.usage?.inputTokens ?? null;
        output = error.usage?.outputTokens ?? null;
      }
      throw new ModelError(input, output, error);
    }
  }
}
export function validateAnalysis(
  value: unknown,
  item: Content,
  c: Config,
): Analysis {
  const a = analysisSchema(activeTopics(c)).parse(value);
  const text = item.text.slice(0, c.limits.textChars);
  if (a.evidenceQuotes.some((quote) => !text.includes(quote)))
    throw new Error("模型证据摘录不在输入原文中，该结果未缓存或推荐");
  return a;
}
