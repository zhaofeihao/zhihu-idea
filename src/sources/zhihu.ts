import { z } from "zod";
import {
  content,
  hash,
  type Content,
  type Page,
  type Query,
  type Source,
} from "../domain.js";

const envelope = z.object({ Code: z.number(), Data: z.unknown().optional() });
const searchItem = z.object({
  Title: z.string(),
  ContentType: z.string(),
  ContentID: z.string(),
  ContentText: z.string(),
  Url: z.string().url(),
  AuthorName: z.string().optional(),
  VoteUpCount: z.number().optional(),
  EditTime: z.number().optional(),
});
const simpleItem = z.object({
  Title: z.string(),
  Url: z.string().url(),
  Summary: z.string().optional(),
});
const answerItem = z.object({
  ContentToken: z.string(),
  Url: z.string().url(),
  Summary: z.string(),
  ContentType: z.string(),
});
export class SourceError extends Error {
  constructor(public code: number) {
    super(`知乎 API 返回错误码 ${code}（鉴权、额度或参数问题请先执行 doctor）`);
  }
}
export function parsePage(
  kind: Query["kind"],
  raw: unknown,
  question = "",
): Page {
  const e = envelope.parse(raw);
  if (e.Code !== 0) throw new SourceError(e.Code);
  const items: Content[] = [];
  if (kind === "search") {
    const data = z
      .object({ Items: z.array(searchItem), HasMore: z.boolean() })
      .parse(e.Data);
    for (const r of data.Items)
      items.push(
        content({
          source: "zhihu",
          externalId: `${r.ContentType.toLowerCase()}:${r.ContentID}`,
          url: r.Url,
          title: r.Title,
          text: r.ContentText,
          author: r.AuthorName || null,
          votes: r.VoteUpCount ?? null,
          publishedAt: null,
          editedAt:
            r.EditTime && r.EditTime > 0
              ? new Date(r.EditTime * 1000).toISOString()
              : null,
          scope: "excerpt",
        }),
      );
    return { items }; // Official search HasMore currently fixed false; no invented cursor.
  }
  if (kind === "answers") {
    const data = z
      .object({
        Items: z.array(answerItem),
        Paging: z.object({
          IsEnd: z.boolean(),
          NextOffset: z.number().int().nonnegative().optional(),
        }),
      })
      .parse(e.Data);
    if (!data.Paging.IsEnd && data.Paging.NextOffset === undefined)
      throw new Error("知乎回答分页不完整：缺少 NextOffset，停止翻页");
    for (const r of data.Items)
      items.push(
        content({
          source: "zhihu",
          externalId: `answer:${r.ContentToken}`,
          url: r.Url,
          title: question || "知乎问题下的回答",
          text: r.Summary,
          author: null,
          votes: null,
          publishedAt: null,
          scope: "excerpt",
        }),
      );
    return {
      items,
      nextOffset: data.Paging.IsEnd ? undefined : data.Paging.NextOffset,
    };
  }
  for (const r of z.object({ Items: z.array(simpleItem) }).parse(e.Data)
    .Items) {
    const token = /\/question\/(\d+)/.exec(r.Url)?.[1];
    items.push(
      content({
        source: "zhihu",
        externalId: token ? `question:${token}` : hash(r.Url),
        url: r.Url,
        title: r.Title,
        text: r.Summary || "",
        author: null,
        votes: null,
        publishedAt: null,
        scope: "excerpt",
      }),
    );
  }
  return { items };
}
export class ZhihuSource implements Source {
  constructor(
    private secret: string,
    private http: typeof fetch = fetch,
    private beforeRequest: () => Promise<void> = async () => {},
  ) {}
  async request(
    path: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    await this.beforeRequest();
    const url = new URL(path, "https://developer.zhihu.com");
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    let response: Response;
    try {
      response = await this.http(url, {
        headers: {
          Authorization: `Bearer ${this.secret}`,
          "X-Request-Timestamp": String(Math.floor(Date.now() / 1000)),
          "Content-Type": "application/json",
        },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(25000)])
          : AbortSignal.timeout(25000),
      });
    } catch {
      throw new Error("知乎请求超时或网络失败，稍后可恢复任务");
    }
    if (!response.ok)
      throw new Error(`知乎 HTTP ${response.status}，请求未自动重试`);
    try {
      return await response.json();
    } catch {
      throw new Error("知乎响应不是 JSON");
    }
  }
  async fetch(q: Query, limit: number, signal?: AbortSignal): Promise<Page> {
    const paths = {
      search: "/api/v1/content/zhihu_search",
      recommend: "/api/v1/user/question_recommendations",
      answers: "/api/v1/content/question_answers",
      hot: "/api/v1/content/hot_list",
    };
    const params: Record<string, string> =
      q.kind === "search"
        ? {
            Query: q.text,
            Count: String(Math.min(10, limit)),
            ...(q.sort ? { SortBy: q.sort } : {}),
          }
        : q.kind === "recommend"
          ? { Query: q.text, Count: String(Math.min(20, limit)) }
          : q.kind === "answers"
            ? {
                QuestionUrl: q.text,
                Offset: String(q.offset || 0),
                Limit: String(Math.min(50, limit)),
              }
            : { Limit: String(Math.min(30, limit)) };
    return parsePage(
      q.kind,
      await this.request(paths[q.kind], params, signal),
      q.parent,
    );
  }
  async quota(signal?: AbortSignal) {
    const result = await this.request("/api/v1/quota", {}, signal);
    const e = envelope.parse(result);
    if (e.Code !== 0) throw new SourceError(e.Code);
    return e.Data;
  }
  expand(
    q: Query,
    page: Page,
    prior: Query[],
    options: { questionAnswers: boolean; answerPages: number },
  ): Query[] {
    const queries: Query[] = [];
    if (q.kind !== "answers" && options.questionAnswers)
      for (const item of page.items) {
        if (!/\/question\/\d+\/?(?:\?|$)/.test(item.url)) continue;
        const text = item.canonicalUrl,
          id = hash("answers:" + text + ":0");
        if (![...prior, ...queries].some((x) => x.id === id))
          queries.push({
            id,
            kind: "answers",
            text,
            category: q.category,
            offset: 0,
            parent: item.title,
          });
      }
    if (q.kind === "answers" && page.nextOffset !== undefined) {
      if (page.nextOffset <= (q.offset || 0))
        throw new Error("知乎分页偏移未前进，停止重复请求");
      const pages = prior.filter(
        (x) => x.kind === "answers" && x.text === q.text,
      ).length;
      if (pages < options.answerPages)
        queries.push({
          ...q,
          id: hash(q.text + ":" + page.nextOffset),
          offset: page.nextOffset,
        });
    }
    return queries;
  }
}
