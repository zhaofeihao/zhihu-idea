import {
  normalizeTopic,
  type Content,
  type Brief,
  type Query,
} from "./domain.js";
import type { Config } from "./config.js";
import type {
  Store,
  RunState,
  Usage,
  Reservation,
  Delivery,
} from "./storage.js";

/** Ephemeral demo/test store. Never used as a fallback for a failed cloud connection. */
export class MemoryStore implements Store {
  runs = new Map<string, RunState>();
  items = new Map<string, Content>();
  results = new Map<string, unknown>();
  briefs = new Map<string, Brief>();
  deliveries = new Map<string, Delivery>();
  usage: Usage[] = [];
  leases = new Map<string, { owner: string; expires: number }>();
  budgets = new Map<string, Reservation>();
  ratings = new Map<string, { rating: string; reason: string; id: string }>();
  async lease(namespace: string, owner: string) {
    const old = this.leases.get(namespace);
    if (old && old.owner !== owner && old.expires > Date.now()) return false;
    this.leases.set(namespace, { owner, expires: Date.now() + 90000 });
    return true;
  }
  async renew(namespace: string, owner: string) {
    const old = this.leases.get(namespace);
    if (!old || old.owner !== owner || old.expires < Date.now()) return false;
    old.expires = Date.now() + 90000;
    return true;
  }
  async release(namespace: string, owner: string) {
    if (this.leases.get(namespace)?.owner === owner)
      this.leases.delete(namespace);
  }
  async run(id: string) {
    return structuredClone(this.runs.get(id) || null);
  }
  async saveRun(r: RunState) {
    this.runs.set(r.id, structuredClone(r));
  }
  async putContent(c: Content, _run: string, _q: Query) {
    this.items.set(
      c.id,
      structuredClone({
        ...c,
        discoveredAt: this.items.get(c.id)?.discoveredAt ?? c.discoveredAt,
      }),
    );
  }
  async contents(ids: string[]) {
    return ids.flatMap((id) =>
      this.items.has(id) ? [structuredClone(this.items.get(id)!)] : [],
    );
  }
  async cached<T>(key: string) {
    return structuredClone(this.results.get(key) ?? null) as T | null;
  }
  async cache(key: string, _id: string, _phase: string, value: unknown) {
    this.results.set(key, structuredClone(value));
  }
  async brief(id?: string, namespace?: string) {
    return structuredClone(
      id
        ? this.briefs.get(id) || null
        : [...this.briefs.values()]
            .filter((x) => x.namespace === namespace)
            .at(-1) || null,
    );
  }
  async saveBrief(b: Brief) {
    if (!this.briefs.has(b.id)) this.briefs.set(b.id, structuredClone(b));
  }
  async history(namespace: string) {
    const items = [...this.briefs.values()]
      .filter(
        (b) =>
          b.namespace === namespace &&
          [...this.deliveries.values()].some(
            (d) =>
              d.briefId === b.id &&
              ["sent", "sending", "unknown"].includes(d.status),
          ),
      )
      .flatMap((b) => b.items);
    return {
      ids: new Set(items.map((x) => x.content.id)),
      fingerprints: new Set(items.map((x) => x.content.fingerprint)),
      topics: new Set(items.map((x) => normalizeTopic(x.analysis.topicKey))),
    };
  }
  async preferences(namespace: string) {
    return JSON.stringify(
      [...this.ratings.entries()]
        .filter(([key]) => key.startsWith(namespace + ":"))
        .map(([, value]) => value),
    );
  }
  async feedback(
    namespace: string,
    id: string,
    rating: string,
    reason: string,
  ) {
    const matches = [...this.items.keys()].filter((x) => x.startsWith(id));
    if (matches.length !== 1) throw new Error("内容编号不存在或不唯一");
    this.ratings.set(namespace + ":" + matches[0], {
      id: matches[0],
      rating,
      reason,
    });
  }
  async reserve(
    namespace: string,
    date: string,
    r: Reservation,
    l: Config["limits"],
  ) {
    const key = namespace + date,
      old = this.budgets.get(key) || {
        source: 0,
        calls: 0,
        tokens: 0,
        cost: 0,
      };
    const next = {
      source: old.source + r.source,
      calls: old.calls + r.calls,
      tokens: old.tokens + r.tokens,
      cost: old.cost + r.cost,
    };
    if (
      next.source > l.dailySourceCalls ||
      next.calls > l.dailyModelCalls ||
      next.tokens > l.dailyTokens ||
      (l.dailyCost !== null && next.cost > l.dailyCost)
    )
      return false;
    this.budgets.set(key, next);
    return true;
  }
  async settle(
    namespace: string,
    date: string,
    r: Reservation,
    tokens: number | null,
    cost: number | null,
    usage: Usage,
  ) {
    if (this.usage.some((u) => u.id === usage.id)) return;
    const old = this.budgets.get(namespace + date)!;
    if (tokens !== null)
      old.tokens = Math.max(0, old.tokens + tokens - r.tokens);
    if (cost !== null) old.cost = Math.max(0, old.cost + cost - r.cost);
    this.usage.push(usage);
  }
  async getDelivery(id: string) {
    return structuredClone(this.deliveries.get(id) || null);
  }
  async putDelivery(d: Delivery) {
    if (!this.deliveries.has(d.id))
      this.deliveries.set(d.id, structuredClone(d));
  }
  async deliveryState(id: string, status: string) {
    const d = this.deliveries.get(id)!;
    d.status = status;
    if (status === "sending") d.attempts++;
  }
}
