import { createHash } from "node:crypto";
import { z } from "zod";

export const schemaVersion = "v2";
export const scoringVersion = "v2";
export const categories = [
  "business",
  "creative",
  "insight",
  "story",
  "trading",
] as const;
export type Category = (typeof categories)[number];
export const labels: Record<Category, string> = {
  business: "商业灵感",
  creative: "脑洞创意",
  insight: "认知突破",
  story: "真实故事",
  trading: "交易",
};
export const scoreSchema = z.object({
  novelty: z.number().min(0).max(100),
  inspiration: z.number().min(0).max(100),
  business: z.number().min(0).max(100),
  evidence: z.number().min(0).max(100),
  quality: z.number().min(0).max(100),
});
export const screenSchema = z.object({
  category: z.enum(categories),
  decision: z.enum(["keep", "reject", "insufficient"]),
  discovery: z.string().max(600),
  reason: z.string().max(600),
});
export const analysisSchema = z.object({
  category: z.enum(categories),
  title: z.string().min(1).max(100),
  summary: z.string().min(1).max(1000),
  whyRead: z.string().min(1).max(600),
  extension: z.string().max(600),
  evidenceQuotes: z.array(z.string().min(1).max(600)).min(1).max(3),
  claimType: z.enum(["observation", "opinion", "personal_story", "hypothesis"]),
  scores: scoreSchema,
  topicKey: z.string().min(1).max(100),
  followUpQueries: z.array(z.string().min(1).max(120)).max(3),
  caveat: z.string().max(400),
});
export type Screening = z.infer<typeof screenSchema>;
export type Analysis = z.infer<typeof analysisSchema>;
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
}
export const weights: Record<Category, number[]> = {
  business: [0.2, 0.2, 0.25, 0.2, 0.15],
  creative: [0.3, 0.3, 0.05, 0.15, 0.2],
  insight: [0.25, 0.3, 0, 0.3, 0.15],
  story: [0.2, 0.25, 0.05, 0.3, 0.2],
  trading: [0.15, 0.25, 0.1, 0.3, 0.2],
};
export function score(analysis: Analysis): number {
  const s = analysis.scores;
  return Math.round(
    [s.novelty, s.inspiration, s.business, s.evidence, s.quality].reduce(
      (total, value, i) => total + value * weights[analysis.category][i],
      0,
    ),
  );
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
  for (const category of categories) {
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
    `精选 ${brief.items.length} 条 · ${[...new Set(brief.items.map((x) => labels[x.analysis.category]))].join(" / ") || "暂无合格内容"}`,
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
      `## ${index + 1}. [${labels[a.category]}] ${a.title} (${c.id.slice(0, 12)})`,
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
