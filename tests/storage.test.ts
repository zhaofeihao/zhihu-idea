import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { SqlStore, type Database } from "../src/storage.js";
import { migrate } from "../src/migrate.js";
import { Pipeline } from "../src/pipeline.js";
import { loadConfig } from "../src/config.js";
import { DemoModel, DemoSource } from "../src/demo.js";

test("实际 SQL 迁移、持久化恢复、反馈隔离与原子预算（内存 PostgreSQL，无本地数据库文件）", async () => {
  const pg = new PGlite();
  const db: Database = {
    query: async (sql, values) => {
      if (!values && sql.includes(";")) {
        const results = await pg.exec(sql);
        return {
          rows: (results.at(-1)?.rows as Record<string, unknown>[]) || [],
        };
      }
      return {
        rows: (await pg.query<Record<string, unknown>>(sql, values)).rows,
      };
    },
  };
  try {
    await migrate(db);
    await migrate(db);
    const store = new SqlStore(db);
    const c = await loadConfig();
    c.limits.queries = 5;
    c.limits.candidates = 20;
    const model = new DemoModel();
    const result = await new Pipeline(
      store,
      new DemoSource(),
      model,
      () => {},
    ).run(c);
    assert.equal(result.brief!.items.length, 5);
    const count = model.calls;
    const resumed = await new Pipeline(
      new SqlStore(db),
      new DemoSource(),
      model,
      () => {},
    ).run(c, { resume: result.run.id });
    assert.equal(resumed.brief!.id, result.brief!.id);
    assert.equal(model.calls, count);
    await store.feedback(
      c.namespace,
      result.brief!.items[0].content.id.slice(0, 12),
      "interesting",
      "喜欢独特需求",
    );
    assert.ok((await store.preferences(c.namespace)).includes("喜欢独特需求"));
    await assert.rejects(
      store.feedback(
        "another",
        result.brief!.items[0].content.id.slice(0, 12),
        "skip",
        "",
      ),
      /不存在/,
    );
    const limits = { ...c.limits, dailyModelCalls: 1 };
    const r = { source: 0, calls: 1, tokens: 100, cost: 0 };
    const reservations = await Promise.all([
      store.reserve("atomic", "2026-10-11", r, limits),
      store.reserve("atomic", "2026-10-11", r, limits),
    ]);
    assert.deepEqual(reservations.sort(), [false, true]);
    const usage = {
      id: "settlement-1",
      runId: result.run.id,
      phase: "screen",
      provider: "test",
      model: "test",
      input: 10,
      output: 10,
      cost: null,
      status: "succeeded",
    };
    await store.settle("atomic", "2026-10-11", r, 20, null, usage);
    await store.settle("atomic", "2026-10-11", r, 20, null, usage);
    assert.equal(
      Number(
        (
          await db.query(
            "SELECT tokens FROM radar.budgets WHERE namespace='atomic'",
          )
        ).rows[0].tokens,
      ),
      20,
    );
    assert.ok(await store.lease("lock", "a"));
    assert.equal(await store.lease("lock", "b"), false);
    assert.ok(await store.renew("lock", "a"));
    await store.release("lock", "a");
    assert.ok(await store.lease("lock", "b"));
    await db.query(
      "UPDATE radar.contents SET updated_at=now()-interval '100 days'",
    );
    await db.query(
      await readFile(
        new URL("../migrations/maintenance.sql", import.meta.url),
        "utf8",
      ),
    );
    assert.equal((await store.contents(result.run.contentIds))[0].text, "");
    const saved = (await store.brief(result.run.id))!;
    assert.equal(saved.items.length, 5);
    assert.ok(saved.items.some((item) => item.analysis.category === "trading"));
  } finally {
    await pg.close();
  }
});
