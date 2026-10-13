import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  categories,
  content,
  type Query,
  type Source,
  type Content,
} from "./domain.js";
import type { Model, Phase } from "./models.js";
const fixtureSchema = z.array(
  z.object({
    category: z.enum(categories),
    title: z.string(),
    text: z.string(),
    discovery: z.string(),
    topic: z.string(),
  }),
);
export const fixtures = fixtureSchema.parse(
  JSON.parse(
    await readFile(new URL("../fixtures/demo.json", import.meta.url), "utf8"),
  ),
);
export class DemoSource implements Source {
  async fetch(_q: Query, limit: number) {
    return {
      items: fixtures.slice(0, limit).map((f, i) =>
        content({
          source: "demo",
          externalId: String(i),
          title: f.title,
          text: f.text,
          url: `https://example.com/demo/${i}`,
          author: "虚构演示样本",
          publishedAt: null,
          votes: null,
          scope: "excerpt",
        }),
      ),
    };
  }
}
export class DemoModel implements Model {
  calls = 0;
  async generate(phase: Phase, item: Content) {
    this.calls++;
    const f = fixtures[Number(item.externalId)];
    if (!f) throw new Error("演示内容不存在");
    return {
      input: 100,
      output: 100,
      value:
        phase === "screen"
          ? {
              category: f.category,
              decision: f.discovery ? ("keep" as const) : ("reject" as const),
              discovery: f.discovery,
              reason: f.discovery
                ? "有具体观察（仅演示）"
                : "无具体信息的营销承诺",
            }
          : {
              category: f.category,
              title: f.title,
              summary: f.discovery || "没有事实依据的营销承诺。",
              whyRead:
                "展示一个与惯常想法不同的观察角度；这是示例，不是真实检索。",
              extension: "可设计一个小实验检验这个想法。",
              evidenceQuotes: [
                item.text.slice(0, Math.min(55, item.text.length)),
              ],
              claimType: "hypothesis" as const,
              scores: {
                novelty: f.discovery ? 85 : 10,
                inspiration: f.discovery ? 80 : 10,
                business: f.category === "business" ? 85 : 10,
                evidence: f.discovery ? 60 : 10,
                quality: f.discovery ? 80 : 10,
              },
              topicKey: f.topic,
              followUpQueries: [],
              caveat: "虚构的样本内容，仅用于检验程序与格式。",
            },
    };
  }
}
