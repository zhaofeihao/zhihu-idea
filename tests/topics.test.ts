import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import {
  score,
  weightsFor,
  labelOf,
  defaultWeightVector,
  type Analysis,
} from "../src/domain.js";
import { activeTopics } from "../src/models.js";

async function writeConfig(mutate: (c: any) => void): Promise<string> {
  const base = JSON.parse(await readFile("config/radar.json", "utf8"));
  mutate(base);
  const dir = await mkdtemp(join(tmpdir(), "radar-cfg-"));
  const path = join(dir, "radar.json");
  await writeFile(path, JSON.stringify(base));
  return path;
}

test("话题可自定义：只配部分话题、新增话题、查询数量不限", async () => {
  const path = await writeConfig((c) => {
    c.discovery.queries = {
      insight: ["只有一条也可以"],
      养生: ["民间养生偏方里的硬核经验", "被误解的养生常识", "一线中医的真实观察"],
    };
    c.limits.brief = 2;
  });
  const c = await loadConfig(path);
  assert.deepEqual(Object.keys(c.discovery.queries), ["insight", "养生"]);
  assert.equal(c.discovery.queries.insight.length, 1);
  assert.equal(c.discovery.queries["养生"].length, 3);
  assert.deepEqual(activeTopics(c), ["insight", "养生"]);
});

test("自定义话题默认套用认知突破权重，可按话题覆盖", async () => {
  const custom: Analysis = {
    category: "养生",
    title: "t",
    summary: "s",
    whyRead: "w",
    extension: "",
    evidenceQuotes: ["q"],
    claimType: "observation",
    scores: {
      novelty: 80,
      inspiration: 90,
      business: 100,
      evidence: 40,
      quality: 60,
    },
    topicKey: "养生",
    followUpQueries: [],
    caveat: "",
  };
  // 未配置权重：套用通用默认（认知突破），商业价值权重为 0。
  assert.deepEqual(weightsFor("养生"), defaultWeightVector);
  const base = score(custom);
  // 覆盖权重后结果随之变化。
  const overridden = score(custom, {
    养生: {
      weights: {
        novelty: 0,
        inspiration: 0,
        business: 100,
        evidence: 0,
        quality: 0,
      },
    },
  });
  assert.equal(overridden, 100);
  assert.notEqual(base, overridden);
});

test("话题权重五维之和必须为 100", async () => {
  const path = await writeConfig((c) => {
    c.topics = { insight: { weights: { novelty: 50, inspiration: 10, business: 0, evidence: 10, quality: 10 } } };
  });
  await assert.rejects(loadConfig(path), /之和必须为 100/);
});

test("展示名解析：配置覆盖 → 内置 → 话题键", () => {
  assert.equal(labelOf("insight"), "认知突破");
  assert.equal(labelOf("养生"), "养生");
  assert.equal(labelOf("养生", { 养生: "养生之道" }), "养生之道");
});
