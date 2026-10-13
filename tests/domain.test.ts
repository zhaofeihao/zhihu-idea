import test from "node:test";
import assert from "node:assert/strict";
import {
  content,
  score,
  selectBrief,
  canonicalize,
  day,
  categories,
  type Analysis,
} from "../src/domain.js";
import { loadConfig } from "../src/config.js";
import { validateAnalysis } from "../src/models.js";
import { schedulePhase } from "../src/service.js";

const base: Analysis = {
  category: "creative",
  title: "脑洞",
  summary: "一种新的组合",
  whyRead: "启发",
  extension: "",
  evidenceQuotes: ["具体观察"],
  claimType: "hypothesis",
  scores: {
    novelty: 95,
    inspiration: 95,
    business: 0,
    evidence: 70,
    quality: 90,
  },
  topicKey: "独特组合",
  followUpQueries: [],
  caveat: "",
};
test("没有商业价值的优质脑洞仍能被推荐；同一主题去重并保留五类", () => {
  assert.ok(score(base) > 80);
  const candidates = categories.map((category, i) => {
    const c = content({
      source: "test",
      externalId: String(i),
      url: `https://example.com/${i}`,
      title: "标题",
      text: `具体观察 ${i}`,
      author: null,
      publishedAt: null,
      votes: 1,
      scope: "excerpt",
    });
    const analysis = {
      ...base,
      category: category as Analysis["category"],
      topicKey: `主题${i}`,
    };
    return { content: c, analysis, score: score(analysis) };
  });
  candidates.push({
    ...candidates[0],
    content: { ...candidates[0].content, id: "another" },
    score: 100,
  });
  const selected = selectBrief(candidates, new Set(), 8, 60, 40);
  assert.equal(selected.length, 5);
  assert.equal(new Set(selected.map((x) => x.analysis.category)).size, 5);
  assert.equal(
    selectBrief(
      candidates,
      new Set(candidates.map((x) => x.content.id)),
      8,
      60,
      40,
    ).length,
    0,
  );
});
test("交易评分侧重启发、证据与质量，不依赖宣称收益或商业价值", () => {
  const trading: Analysis = {
    ...base,
    category: "trading",
    scores: {
      novelty: 10,
      inspiration: 80,
      business: 0,
      evidence: 90,
      quality: 90,
    },
  };
  assert.equal(score(trading), 67);
  assert.ok(
    score(trading) >
      score({ ...trading, scores: { ...trading.scores, evidence: 20 } }),
  );
});
test("保留来源溯源链接，去重 URL 去除 UTM；北京时间跨日正确", () => {
  assert.equal(
    canonicalize("https://www.zhihu.com/question/1/?utm_source=test#foo"),
    "https://www.zhihu.com/question/1",
  );
  assert.equal(day(new Date("2026-10-10T17:00:00Z")), "2026-10-11");
  assert.throws(() => canonicalize("javascript:alert(1)"));
});
test("AI 不得伪造逐字证据；调度按北京时间而非电脑时区", async () => {
  const c = await loadConfig();
  const item = content({
    source: "test",
    externalId: "1",
    url: "https://example.com/1",
    title: "观察",
    text: "这里有具体观察",
    scope: "excerpt",
    author: null,
    votes: null,
    publishedAt: null,
  });
  assert.equal(validateAnalysis(base, item, c).title, "脑洞");
  assert.throws(() =>
    validateAnalysis({ ...base, evidenceQuotes: ["编造的一句话"] }, item, c),
  );
  assert.equal(schedulePhase(new Date("2026-10-09T22:59:00Z"), c), "idle");
  assert.equal(schedulePhase(new Date("2026-10-09T23:01:00Z"), c), "collect");
  assert.equal(schedulePhase(new Date("2026-10-10T01:00:00Z"), c), "deliver");
});
