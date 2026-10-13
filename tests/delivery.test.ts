import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { MemoryStore } from "../src/memory-store.js";
import { loadConfig } from "../src/config.js";
import { Pipeline } from "../src/pipeline.js";
import { DemoModel, DemoSource } from "../src/demo.js";
import { cards, deliver, signature, FeishuSender } from "../src/delivery.js";

const webhook = "https://open.feishu.cn/open-apis/bot/v2/hook/test";
test("飞书签名按 timestamp+换行+secret 作 HMAC key，空字符串作消息", () => {
  assert.equal(
    signature("1599360473", "demo"),
    createHmac("sha256", "1599360473\ndemo").digest("base64"),
  );
});
test("HTTP 200 不代表成功；超时保留未知结果并禁止自动重发", async () => {
  const store = new MemoryStore(),
    c = await loadConfig();
  c.limits.queries = 4;
  const b = (
    await new Pipeline(store, new DemoSource(), new DemoModel(), () => {}).run(
      c,
    )
  ).brief!;
  let calls = 0;
  const sender = new FeishuSender(webhook, "", async () => {
    calls++;
    throw new Error("timeout");
  });
  await assert.rejects(deliver(store, b, sender), /未知/);
  assert.equal([...store.deliveries.values()][0].status, "unknown");
  await assert.rejects(deliver(store, b, sender), /未知/);
  assert.equal(calls, 1);
  const rejected = new FeishuSender(
    webhook,
    "",
    async () => new Response(JSON.stringify({ code: 19021 })),
  );
  await assert.rejects(
    deliver(store, b, rejected, { allowUnknown: true }),
    /19021/,
  );
  assert.equal([...store.deliveries.values()][0].status, "failed");
  await deliver(
    store,
    b,
    new FeishuSender(
      webhook,
      "",
      async () => new Response(JSON.stringify({ code: 0 })),
    ),
  );
  const count = [...store.deliveries.values()][0].attempts;
  await deliver(store, b, sender);
  assert.equal([...store.deliveries.values()][0].attempts, count);
  assert.equal(calls, 1);
  assert.ok((await store.history(c.namespace)).ids.size > 0);
});
test("卡片按 UTF-8 字节分片，模型文本不能插入 @all 或额外链接", async () => {
  const store = new MemoryStore(),
    c = await loadConfig();
  const b = (
    await new Pipeline(store, new DemoSource(), new DemoModel(), () => {}).run(
      c,
    )
  ).brief!;
  b.items = b.items.flatMap((x) =>
    Array.from({ length: 3 }, () => ({
      ...x,
      analysis: {
        ...x.analysis,
        summary: "中".repeat(1000),
        whyRead: "<at id=all></at> [伪链接](https://evil.test)",
      },
    })),
  );
  const parts = cards(b);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((x) => Buffer.byteLength(JSON.stringify(x)) < 20000));
  assert.ok(!JSON.stringify(parts).includes("<at"));
});
