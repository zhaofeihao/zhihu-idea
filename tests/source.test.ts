import test from "node:test";
import assert from "node:assert/strict";
import { ZhihuSource, parsePage, SourceError } from "../src/sources/zhihu.js";

test("知乎搜索使用官方 PascalCase 字段，摘要不冒充全文", async () => {
  const response = {
    Code: 0,
    Data: {
      HasMore: false,
      Items: [
        {
          Title: "低热度观察",
          ContentType: "Answer",
          ContentID: "123",
          ContentText: "<p>一段摘要</p>",
          Url: "https://www.zhihu.com/question/1/answer/123?utm_source=official",
          AuthorName: "作者",
          VoteUpCount: 3,
          EditTime: 1710000000,
        },
      ],
    },
  };
  let url: URL | undefined, headers: Headers | undefined;
  const http: typeof fetch = async (input, init) => {
    url = new URL(String(input));
    headers = new Headers(init?.headers);
    return new Response(JSON.stringify(response));
  };
  const page = await new ZhihuSource("test-secret", http).fetch(
    {
      id: "q",
      kind: "search",
      text: "奇思妙想",
      category: "creative",
      sort: "VoteUpCount:desc:(,100)",
    },
    100,
  );
  assert.equal(url!.searchParams.get("Count"), "10");
  assert.equal(url!.searchParams.get("SortBy"), "VoteUpCount:desc:(,100)");
  assert.equal(headers!.get("Authorization"), "Bearer test-secret");
  assert.match(headers!.get("X-Request-Timestamp")!, /^\d{10}$/);
  assert.equal(page.items[0].scope, "excerpt");
  assert.equal(page.items[0].text, "一段摘要");
  assert.equal(page.items[0].votes, 3);
  assert.equal(page.items[0].publishedAt, null);
  assert.ok(page.items[0].editedAt);
  assert.ok(page.items[0].url.includes("utm_source"));
  assert.ok(!page.items[0].canonicalUrl.includes("?"));
});
test("空回答页按官方 NextOffset 继续；缺失/回退游标不猜测", () => {
  const page = parsePage("answers", {
    Code: 0,
    Data: { Items: [], Paging: { IsEnd: false, NextOffset: 50 } },
  });
  assert.equal(page.nextOffset, 50);
  assert.throws(
    () =>
      parsePage("answers", {
        Code: 0,
        Data: { Items: [], Paging: { IsEnd: false } },
      }),
    /NextOffset/,
  );
  assert.throws(
    () =>
      parsePage("search", {
        Code: 20001,
        Message: "secret should never print",
      }),
    SourceError,
  );
});
test("推荐标题不自动成为可深度分析的正文", () => {
  const page = parsePage("recommend", {
    Code: 0,
    Data: {
      Items: [{ Title: "问题", Url: "https://www.zhihu.com/question/42" }],
    },
  });
  assert.equal(page.items[0].scope, "title_only");
  assert.equal(page.items[0].externalId, "question:42");
  const q = {
    id: "q",
    kind: "recommend" as const,
    text: "问题",
    category: "creative" as const,
  };
  const source = new ZhihuSource("mock");
  const expanded = source.expand(q, page, [q], {
    questionAnswers: true,
    answerPages: 2,
  });
  assert.equal(expanded[0].text, "https://www.zhihu.com/question/42");
  assert.equal(expanded[0].parent, "问题");
  assert.throws(
    () =>
      source.expand(
        { ...expanded[0], offset: 50 },
        { items: [], nextOffset: 50 },
        expanded,
        { questionAnswers: true, answerPages: 2 },
      ),
    /未前进/,
  );
});
