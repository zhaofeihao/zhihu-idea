import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { DemoModel, DemoSource } from "../src/demo.js";
import { MemoryStore } from "../src/memory-store.js";
import { Pipeline, queryPlan, withLease } from "../src/pipeline.js";
import { setTimeout as delay } from "node:timers/promises";
import type { Source } from "../src/domain.js";
import type { Model, ModelResult } from "../src/models.js";
import { cacheKey } from "../src/models.js";
import type { Analysis } from "../src/domain.js";
import { categories, markdown } from "../src/domain.js";
import { cards } from "../src/delivery.js";

async function setup() {
  const config = await loadConfig();
  config.limits.queries = categories.length;
  config.limits.candidates = 20;
  return { config, store: new MemoryStore(), model: new DemoModel() };
}
test("完整离线流程覆盖五类、过滤营销、重跑不重复分析", async () => {
  const { config, store, model } = await setup();
  const pipeline = new Pipeline(store, new DemoSource(), model, () => {});
  const first = await pipeline.run(config);
  assert.equal(first.brief!.items.length, 5);
  assert.equal(store.deliveries.size, 0);
  assert.equal(
    new Set(first.brief!.items.map((x) => x.analysis.category)).size,
    5,
  );
  const calls = model.calls;
  const again = await pipeline.run(config);
  assert.equal(again.brief!.id, first.brief!.id);
  assert.equal(model.calls, calls);
});
test("交易查询参与默认轮换，单独运行可完成筛选、评分与简报渲染", async () => {
  const { config, store, model } = await setup();
  const date = "2026-10-13";
  assert.deepEqual(
    queryPlan(config, date).map((q) => q.category),
    categories,
  );
  config.category = "trading";
  config.limits.queries = config.discovery.queries.trading.length;
  const queries = queryPlan(config, date);
  assert.ok(queries.every((q) => q.category === "trading"));
  assert.equal(new Set(queries.map((q) => q.text)).size, 8);
  assert.ok(queries.some((q) => q.text.includes("股票")));
  assert.ok(queries.some((q) => q.text.includes("加密货币")));
  assert.ok(queries.some((q) => q.text.includes("套利")));
  const fetched: string[] = [];
  const source: Source = {
    fetch: async (q) => {
      assert.equal(q.category, "trading");
      fetched.push(q.text);
      const page = await new DemoSource().fetch(q, 10);
      return { items: page.items.filter((item) => item.externalId === "6") };
    },
  };
  const result = await new Pipeline(store, source, model, () => {}).run(config);
  assert.equal(fetched.length, 8);
  assert.equal(result.brief!.items.length, 1);
  assert.equal(result.brief!.items[0].analysis.category, "trading");
  assert.ok(result.brief!.items[0].score >= config.selection.minScore);
  assert.ok(markdown(result.brief!).includes("[交易]"));
  assert.ok(JSON.stringify(cards(result.brief!)).includes("交易"));
  assert.equal(store.deliveries.size, 0);
});
for (const includeKept of [true, false]) {
  test(`初筛拒绝的高分抽查不进入简报或探索（${includeKept ? "有合格内容" : "全不合格"}）`, async () => {
    const { config, store, model } = await setup();
    config.limits.queries = 1;
    config.limits.exploration = 1;
    config.selection.auditRejected = 2;
    const page = await new DemoSource().fetch(
      { id: "q", kind: "search", text: "", category: "business" },
      4,
    );
    page.items[0].author = "维修研究所"; // An institution with concrete details may pass.
    page.items[1].author = "品牌官方号";
    page.items[2].author = "个人作者";
    page.items[3].author = null;
    const items = includeKept ? page.items : page.items.slice(1);
    const queries: string[] = [];
    const analyzed: string[] = [];
    const source: Source = {
      fetch: async (q) => {
        queries.push(q.text);
        return { items: q.parent ? [] : items };
      },
    };
    const injected: Model = {
      generate: async (phase, item) => {
        if (phase === "screen")
          return {
            input: 100,
            output: 100,
            value: {
              category: "business",
              decision:
                item.externalId === "0"
                  ? "keep"
                  : item.externalId === "3"
                    ? "insufficient"
                    : "reject",
              discovery: item.externalId === "0" ? "具体操作细节" : "",
              reason:
                item.externalId === "0"
                  ? "有实质细节"
                  : item.externalId === "1"
                    ? "仅有宣传表态"
                    : "缺少实质信息",
            },
          };
        analyzed.push(item.id);
        const result: ModelResult = await model.generate(phase, item);
        if ("followUpQueries" in result.value)
          result.value.followUpQueries =
            item.externalId === "0" ? [] : ["被拒绝内容的关联查询"];
        return result;
      },
    };
    const result = await new Pipeline(store, source, injected, () => {}).run(
      config,
    );
    assert.deepEqual(
      result.brief!.items.map((x) => x.content.id),
      includeKept ? [page.items[0].id] : [],
    );
    assert.equal(result.brief!.status, includeKept ? "ready" : "empty");
    assert.equal(queries.length, 1);
    assert.equal(result.run.queue.filter((q) => q.parent).length, 0);
    assert.ok(!analyzed.includes(page.items[3].id));
    for (const item of page.items.slice(1, 3)) {
      assert.ok(analyzed.includes(item.id));
      const audit = await store.cached<Analysis>(
        cacheKey("analyze", item, result.run.preferences, config),
      );
      assert.ok(audit && audit.scores.quality >= 50);
    }
    assert.equal(store.deliveries.size, 0);
  });
}
test("预算未产生有效分析时保留失败任务，不能冒充质量不足简报", async () => {
  const { config, store, model } = await setup();
  config.limits.dailyModelCalls = 1;
  await assert.rejects(
    new Pipeline(store, new DemoSource(), model, () => {}).run(config),
    /预算/,
  );
  assert.equal(store.briefs.size, 0);
  assert.equal([...store.runs.values()][0].status, "failed");
});
test("截止时只冻结已完成结果；明确停止任务不能被截止逻辑吞掉", async () => {
  const { config, store, model } = await setup();
  const demo = new DemoSource();
  const slow = {
    fetch: async (...args: Parameters<Source["fetch"]>) => {
      await delay(1000, undefined, { signal: args[2] });
      return demo.fetch(args[0], args[1]);
    },
  };
  const result = await new Pipeline(store, slow, model, () => {}).run(config, {
    deadline: Date.now() + 30,
  });
  assert.equal(model.calls, 0);
  assert.ok(result.brief!.warnings!.some((x) => x.includes("截止")));
  const control = new AbortController();
  control.abort();
  await assert.rejects(
    new Pipeline(new MemoryStore(), slow, model, () => {}).run(config, {
      signal: control.signal,
      deadline: Date.now() + 30,
    }),
  );
});
test("运行 ID 恢复不得跨运行空间", async () => {
  const { config, store, model } = await setup();
  const p = new Pipeline(store, new DemoSource(), model, () => {});
  const r = await p.run(config);
  await assert.rejects(
    p.run({ ...config, namespace: "other" }, { resume: r.run.id }),
    /不属于/,
  );
});
test("中断后云端检查点恢复；成功的模型调用从缓存复用", async () => {
  const { config, store, model } = await setup();
  let crashed = false;
  const flaky = {
    generate: async (...args: Parameters<DemoModel["generate"]>) => {
      if (!crashed && model.calls === 6) {
        crashed = true;
        throw new Error("模拟中断");
      }
      return model.generate(...args);
    },
  };
  await assert.rejects(
    new Pipeline(store, new DemoSource(), flaky, () => {}).run(config),
    /模拟中断/,
  );
  const run = [...store.runs.values()][0];
  assert.equal(run.status, "failed");
  const oldCaches = store.results.size;
  const result = await new Pipeline(
    store,
    new DemoSource(),
    model,
    () => {},
  ).run(config, { resume: run.id });
  assert.equal(result.brief!.items.length, 5);
  assert.ok(store.results.size > oldCaches);
  assert.equal(model.calls, 12);
});
test("预算预留阻止超额模型调用，使用现有分析生成有限覆盖简报", async () => {
  const { config, store, model } = await setup();
  config.limits.dailyModelCalls = 6;
  const result = await new Pipeline(
    store,
    new DemoSource(),
    model,
    () => {},
  ).run(config);
  assert.equal(model.calls, 6);
  assert.ok(result.brief!.items.length > 0);
  assert.ok(result.brief!.warnings!.some((x) => x.includes("预算")));
  assert.equal([...store.budgets.values()][0].calls, 6);
});
test("同运行空间互斥，不同空间可执行；单类别计划与探索调用受限", async () => {
  const { config, store } = await setup();
  assert.ok(await store.lease("personal", "a"));
  assert.equal(await store.lease("personal", "b"), false);
  await assert.rejects(
    withLease(store, "personal", async () => true),
    /已有任务/,
  );
  assert.equal(await withLease(store, "other", async () => 42), 42);
  await store.release("personal", "a");
  config.category = "creative";
  const queries = queryPlan(config, "2026-10-10");
  assert.ok(queries.every((q) => q.category === "creative"));
  assert.ok(queries.some((q) => q.sort?.includes("VoteUpCount")));
});
test("关联探索的新候选可以用到预留深度分析名额，而不被原候选占完", async () => {
  const { config, store, model } = await setup();
  config.limits.deep = 5;
  config.limits.exploration = 1;
  config.selection.auditRejected = 0;
  const source: Source = {
    fetch: async (q, limit) => {
      const page = await new DemoSource().fetch(q, limit);
      return q.parent
        ? {
            items: [
              {
                ...page.items[0],
                id: "exploration-new",
                fingerprint: "exploration-fingerprint",
                title: "探索的新视角",
              },
            ],
          }
        : page;
    },
  };
  const explorer: Model = {
    generate: async (phase, item) => {
      const result: ModelResult = await model.generate(phase, item);
      if ("followUpQueries" in result.value) {
        result.value.followUpQueries = ["这个发现的相邻领域有哪些"];
        if (item.id === "exploration-new") result.value.topicKey = "探索新主题";
      }
      return result;
    },
  };
  const result = await new Pipeline(store, source, explorer, () => {}).run(
    config,
  );
  assert.ok(result.run.explorationIds?.includes("exploration-new"));
  assert.ok(result.run.deepIds.includes("exploration-new"));
  assert.equal(result.run.deepIds.length, 5);
  assert.equal(result.run.queue.filter((q) => q.parent).length, 1);
});
test("初筛不能耗尽全部调用额度，给深度分析留出结果", async () => {
  const { config, store, model } = await setup();
  config.limits.dailyModelCalls = 12;
  config.limits.deep = 2;
  config.selection.auditRejected = 0;
  const source: Source = {
    fetch: async (q, limit) => {
      const page = await new DemoSource().fetch(q, limit);
      return {
        items: [
          page.items[0],
          ...Array.from({ length: Math.max(0, limit - 1) }, (_, i) => ({
            ...page.items[4],
            id: q.id + "-reject-" + i,
            fingerprint: q.id + "-fp-" + i,
          })),
        ],
      };
    },
  };
  const result = await new Pipeline(store, source, model, () => {}).run(config);
  assert.equal(result.brief!.items.length, 1);
  assert.ok(result.brief!.warnings?.some((x) => x.includes("初筛预算")));
  assert.ok(model.calls <= 12);
});
