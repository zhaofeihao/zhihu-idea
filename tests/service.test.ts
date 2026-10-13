import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../src/config.js";
import { service, collectionDeadline } from "../src/service.js";
import type { Brief } from "../src/domain.js";

test("服务健康检查、北京时间截止、指定快照发送与优雅停止", async () => {
  const config = await loadConfig(),
    control = new AbortController();
  let port = 0,
    collections = 0,
    sends = 0;
  const now = new Date("2026-10-10T01:05:00Z");
  const b: Brief = {
    id: "scheduled",
    date: "2026-10-10",
    namespace: config.namespace,
    items: [],
    status: "empty",
    createdAt: now.toISOString(),
  };
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const task = service(
    config,
    async (deadline) => {
      collections++;
      assert.equal(deadline, now.getTime() + 600000);
      await blocked;
      return b;
    },
    async (actual) => {
      assert.equal(actual, b);
      sends++;
    },
    control.signal,
    {
      port: 0,
      tickMs: 5,
      now: () => now,
      onListening: (n) => {
        port = n;
      },
    },
  );
  try {
    while (!port) await delay(5);
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { working: boolean }).working, true);
    assert.equal((await fetch(`http://127.0.0.1:${port}/other`)).status, 404);
    unblock();
    while (!sends) await delay(5);
    await delay(25);
    assert.equal(collections, 1);
    assert.equal(sends, 1);
    assert.equal(
      collectionDeadline(new Date("2026-10-09T23:00:00Z"), config),
      Date.parse("2026-10-10T01:00:00Z"),
    );
  } finally {
    unblock();
    control.abort();
    await task;
  }
});
