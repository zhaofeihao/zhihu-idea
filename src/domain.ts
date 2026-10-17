import { createHash } from "node:crypto";
import { z } from "zod";

export const schemaVersion = "v2";
export const scoringVersion = "v3";
// 内置的五个默认话题；话题本身是自由字符串，用户可在配置里只保留部分、也可新增自定义话题。
export const categories = [
  "business",
  "creative",
  "insight",
  "story",
  "trading",
] as const;
// 话题键（category）现在是任意字符串，由配置的 discovery.queries 决定有哪些话题生效。
export type Category = string;
export const builtinLabels: Record<string, string> = {
  business: "商业灵感",
  creative: "脑洞创意",
  insight: "认知突破",
  story: "真实故事",
  trading: "交易",
};
// 内置话题的含义，供模型分类时参考；自定义话题可在配置里给出 description。
export const builtinDescriptions: Record<string, string> = {
  business: "商业灵感：鲜为人知的需求、小众商业模式、一线赚钱门道与行业痛点。",
  creative: "脑洞创意：不寻常的产品设计、有趣假设、跨领域组合、可低成本尝试的创意。",
  insight: "认知突破：反直觉机制、冷门知识、被误解的原理、少有人知的运作逻辑。",
  story: "真实故事：特殊职业、一线经历、行业内幕、让人意外的亲历案例。",
  trading:
    "交易：股票、加密货币、套利、ETF、期货、期权、量化、对冲与市场微观结构的机制、成本、风控与复盘。",
};
// 评分维度顺序：novelty 新颖性、inspiration 启发性、business 商业价值、evidence 证据充分度、quality 内容质量。
export interface TopicWeights {
  novelty: number;
  inspiration: number;
  business: number;
  evidence: number;
  quality: number;
}
export interface TopicMeta {
  label?: string;
  description?: string;
  weights?: TopicWeights;
}
export type TopicsConfig = Record<string, TopicMeta>;
export const scoreSchema = z.object({
  novelty: z.number().min(0).max(100),
  inspiration: z.number().min(0).max(100),
  business: z.number().min(0).max(100),
  evidence: z.number().min(0).max(100),
  quality: z.number().min(0).max(100),
});
export interface Screening {
  category: string;
  decision: "keep" | "reject" | "insufficient";
  discovery: string;
  reason: string;
}
export interface Analysis {
  category: string;
  title: string;
  summary: string;
  whyRead: string;
  extension: string;
  evidenceQuotes: string[];
  claimType: "observation" | "opinion" | "personal_story" | "hypothesis";
  scores: z.infer<typeof scoreSchema>;
  topicKey: string;
  followUpQueries: string[];
  caveat: string;
}
// 结构化输出 schema 需按生效话题动态生成，让 category 只能取配置中的话题之一。
const topicEnum = (topics: readonly string[]) =>
  z.enum((topics.length ? topics : ["other"]) as [string, ...string[]]);
export const screenSchema = (topics: readonly string[]) =>
  z.object({
    category: topicEnum(topics),
    decision: z.enum(["keep", "reject", "insufficient"]),
    discovery: z.string().max(600),
    reason: z.string().max(600),
  });
export const analysisSchema = (topics: readonly string[]) =>
  z.object({
    category: topicEnum(topics),
    title: z.string().min(1).max(100),
    summary: z.string().min(1).max(1000),
    whyRead: z.string().min(1).max(600),
    extension: z.string().max(600),
    evidenceQuotes: z.array(z.string().min(1).max(600)).min(1).max(3),
    claimType: z.enum([
      "observation",
      "opinion",
      "personal_story",
      "hypothesis",
    ]),
    scores: scoreSchema,
    topicKey: z.string().min(1).max(100),
    followUpQueries: z.array(z.string().min(1).max(120)).max(3),
    caveat: z.string().max(400),
  });
export interface Content {
  id: string;
  source: string;
  externalId: string;
  url: string;
  canonicalUrl: string;
  title: string;
  text: string;
  author: string | null;
  publishedAt: string | null;
  editedAt?: string | null;
  votes: number | null;
  scope: "excerpt" | "full_text" | "title_only";
  fingerprint: string;
  discoveredAt: string;
}
export interface Query {
  id: string;
  kind: "search" | "recommend" | "answers" | "hot";
  text: string;
  category: Category;
  sort?: string;
  offset?: number;
  parent?: string;
}
export interface Page {
  items: Content[];
  nextOffset?: number;
}
export interface Source {
  fetch(query: Query, limit: number, signal?: AbortSignal): Promise<Page>;
  expand?(
    query: Query,
    page: Page,
    prior: Query[],
    options: { questionAnswers: boolean; answerPages: number },
  ): Query[];
}
export interface BriefItem {
  content: Content;
  analysis: Analysis;
  score: number;
}
export interface Brief {
  id: string;
  date: string;
  namespace: string;
  items: BriefItem[];
  status: "ready" | "empty";
  createdAt: string;
  warnings?: string[];
  // 入选话题的展示名快照，保证预览/发送即使之后改了配置也稳定显示。
  labels?: Record<string, string>;
}
// 顺序：novelty 新颖性、inspiration 启发性、business 商业价值、evidence 证据充分度、quality 内容质量
// v3（扫地僧策略）：抬高新颖性与启发性，让"意外/震撼"主导排序，弱化证据与质量对总分的垄断；
// 证据与质量仍作为 selectBrief 的硬门槛，避免放进低质内容。
export const builtinWeights: Record<string, number[]> = {
  business: [0.25, 0.3, 0.2, 0.15, 0.1],
  creative: [0.35, 0.35, 0.05, 0.1, 0.15],
  insight: [0.3, 0.35, 0, 0.2, 0.15],
  story: [0.3, 0.3, 0.05, 0.2, 0.15],
  trading: [0.25, 0.3, 0.1, 0.2, 0.15],
};
// 自定义话题、以及没有在配置里给出权重的话题，默认套用"认知突破"那套扫地僧权重。
export const defaultWeightVector = builtinWeights.insight;
// 解析某个话题的权重：配置覆盖 → 内置默认 → 通用默认（认知突破）。
export function weightsFor(topic: string, topics?: TopicsConfig): number[] {
  const custom = topics?.[topic]?.weights;
  if (custom)
    return [
      custom.novelty,
      custom.inspiration,
      custom.business,
      custom.evidence,
      custom.quality,
    ].map((v) => v / 100);
  return builtinWeights[topic] ?? defaultWeightVector;
}
export function score(analysis: Analysis, topics?: TopicsConfig): number {
  const s = analysis.scores;
  const w = weightsFor(analysis.category, topics);
  return Math.round(
    [s.novelty, s.inspiration, s.business, s.evidence, s.quality].reduce(
      (total, value, i) => total + value * w[i],
      0,
    ),
  );
}
// 解析话题的展示名：简报快照 → 内置标签 → 话题键本身。
export function labelOf(topic: string, labelMap?: Record<string, string>): string {
  return labelMap?.[topic] ?? builtinLabels[topic] ?? topic;
}
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function canonicalize(url: string): string {
  const u = new URL(url);
  if (!["http:", "https:"].includes(u.protocol))
    throw new Error("来源链接必须是 HTTP(S)");
  u.hash = "";
  u.search = "";
  u.pathname = u.pathname.replace(/\/$/, "");
  return u.toString();
}
export function plainText(value: string): string {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
export function content(
  input: Omit<Content, "id" | "canonicalUrl" | "fingerprint" | "discoveredAt">,
): Content {
  const text = plainText(input.text);
  const canonicalUrl = canonicalize(input.url);
  return {
    ...input,
    text,
    canonicalUrl,
    id: hash(`${input.source}:${input.externalId || canonicalUrl}`),
    fingerprint: hash(text || input.title),
    discoveredAt: new Date().toISOString(),
    scope: text ? input.scope : "title_only",
  };
}
export function day(now = new Date(), zone = "Asia/Shanghai"): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
export function normalizeTopic(s: string): string {
  return s.toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, "");
}
export function selectBrief(
  candidates: BriefItem[],
  excluded: Set<string>,
  limit: number,
  minScore: number,
  minEvidence: number,
): BriefItem[] {
  const sorted = candidates
    .filter(
      (x) =>
        !excluded.has(x.content.id) &&
        x.content.scope !== "title_only" &&
        x.score >= minScore &&
        x.analysis.scores.quality >= 50 &&
        x.analysis.scores.evidence >= minEvidence,
    )
    .sort((a, b) => b.score - a.score);
  const selected: BriefItem[] = [];
  const topics = new Set<string>();
  const fingerprints = new Set<string>();
  const take = (item: BriefItem) => {
    const topic = normalizeTopic(item.analysis.topicKey);
    if (
      selected.length >= limit ||
      topics.has(topic) ||
      fingerprints.has(item.content.fingerprint)
    )
      return;
    selected.push(item);
    topics.add(topic);
    fingerprints.add(item.content.fingerprint);
  };
  // 先给每个有合格内容的话题保一个名额（按分数排序出现的话题顺序），再按分数补足。
  for (const category of new Set(sorted.map((x) => x.analysis.category))) {
    const first = sorted.find((x) => x.analysis.category === category);
    if (first) take(first);
  }
  for (const item of sorted) take(item);
  return selected;
}
export function markdown(brief: Brief): string {
  const lines = [
    `# 灵感雷达 · ${brief.date}`,
    "",
    `精选 ${brief.items.length} 条 · ${[...new Set(brief.items.map((x) => labelOf(x.analysis.category, brief.labels)))].join(" / ") || "暂无合格内容"}`,
  ];
  if (!brief.items.length)
    lines.push(
      "",
      brief.warnings?.length
        ? "本次覆盖有限，已分析部分暂未选出合格内容；这不代表当天没有好内容。"
        : "本次采集完成，没有足够证据与质量的内容，今天不凑数。",
    );
  if (brief.warnings?.length)
    lines.push("", `运行提示：${brief.warnings.join("；")}`);
  brief.items.forEach((item, index) => {
    const { analysis: a, content: c } = item;
    lines.push(
      "",
      `## ${index + 1}. [${labelOf(a.category, brief.labels)}] ${a.title} (${c.id.slice(0, 12)})`,
      "",
      a.summary,
      "",
      `值得读：${a.whyRead}`,
    );
    if (a.extension) lines.push("", `AI 推演：${a.extension}`);
    if (a.claimType === "hypothesis")
      lines.push("", "内容类型：创意假设，并非已发生的事实。");
    if (a.caveat) lines.push("", `阅读提示：${a.caveat}`);
    lines.push(
      "",
      `来源：${c.author || "作者信息未提供"} · ${sourceTime(c)} · ${c.scope === "full_text" ? "正文" : "仅依据摘要/截取文本"}`,
      `[阅读原文](${c.url})`,
    );
  });
  return lines.join("\n");
}
export function sourceTime(c: Content): string {
  return c.publishedAt
    ? `发表于 ${c.publishedAt.slice(0, 10)}`
    : c.editedAt
      ? `编辑于 ${c.editedAt.slice(0, 10)}（发表时间未知）`
      : "发表时间未知";
}
