import { readFile } from "node:fs/promises";
import pg from "pg";
import type { Config } from "./config.js";
import { requireEnv } from "./config.js";
import {
  normalizeTopic,
  type Brief,
  type Content,
  type Query,
} from "./domain.js";

export interface RunState {
  id: string;
  namespace: string;
  date: string;
  config: Config;
  preferences: string;
  queue: Query[];
  cursor: number;
  contentIds: string[];
  explorationIds?: string[];
  discovered: boolean;
  analyzed: boolean;
  explored: boolean;
  errors: string[];
  status: string;
  deepIds: string[];
}
export interface Usage {
  id: string;
  runId: string;
  phase: string;
  provider: string;
  model: string;
  input: number | null;
  output: number | null;
  cost: number | null;
  status: string;
}
export interface Reservation {
  source: number;
  calls: number;
  tokens: number;
  cost: number;
}
export interface Delivery {
  id: string;
  briefId: string;
  target: string;
  part: number;
  body: Record<string, unknown>;
  status: string;
  attempts: number;
}
export interface Store {
  lease(namespace: string, owner: string): Promise<boolean>;
  renew(namespace: string, owner: string): Promise<boolean>;
  release(namespace: string, owner: string): Promise<void>;
  run(id: string): Promise<RunState | null>;
  saveRun(run: RunState): Promise<void>;
  putContent(c: Content, run: string, q: Query): Promise<void>;
  contents(ids: string[]): Promise<Content[]>;
  cached<T>(key: string): Promise<T | null>;
  cache(key: string, id: string, phase: string, value: unknown): Promise<void>;
  brief(id?: string, namespace?: string): Promise<Brief | null>;
  saveBrief(b: Brief): Promise<void>;
  history(namespace: string): Promise<{
    ids: Set<string>;
    fingerprints: Set<string>;
    topics: Set<string>;
  }>;
  preferences(namespace: string): Promise<string>;
  feedback(
    namespace: string,
    shortId: string,
    rating: string,
    reason: string,
  ): Promise<void>;
  reserve(
    namespace: string,
    date: string,
    r: Reservation,
    limits: Config["limits"],
  ): Promise<boolean>;
  settle(
    namespace: string,
    date: string,
    reserved: Reservation,
    tokens: number | null,
    cost: number | null,
    usage: Usage,
  ): Promise<void>;
  getDelivery(id: string): Promise<Delivery | null>;
  putDelivery(d: Delivery): Promise<void>;
  deliveryState(id: string, status: string, error?: string): Promise<void>;
}
export interface Database {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}
export class SqlStore implements Store {
  constructor(public db: Database) {}
  async lease(namespace: string, owner: string) {
    const r = await this.db.query(
      "INSERT INTO radar.leases VALUES($1,$2,now()+interval '90 seconds') ON CONFLICT(namespace) DO UPDATE SET owner=EXCLUDED.owner, expires_at=EXCLUDED.expires_at WHERE radar.leases.expires_at < now() OR radar.leases.owner=$2 RETURNING owner",
      [namespace, owner],
    );
    return r.rows.length > 0;
  }
  async renew(namespace: string, owner: string) {
    return (
      (
        await this.db.query(
          "UPDATE radar.leases SET expires_at=now()+interval '90 seconds' WHERE namespace=$1 AND owner=$2 AND expires_at>now() RETURNING owner",
          [namespace, owner],
        )
      ).rows.length > 0
    );
  }
  async release(namespace: string, owner: string) {
    await this.db.query(
      "DELETE FROM radar.leases WHERE namespace=$1 AND owner=$2",
      [namespace, owner],
    );
  }
  async run(id: string) {
    return (
      ((await this.db.query("SELECT body FROM radar.runs WHERE id=$1", [id]))
        .rows[0]?.body as RunState) || null
    );
  }
  async saveRun(r: RunState) {
    await this.db.query(
      "INSERT INTO radar.runs(id,namespace,day,status,body) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET status=$4,body=$5,updated_at=now()",
      [r.id, r.namespace, r.date, r.status, JSON.stringify(r)],
    );
  }
  async putContent(c: Content, run: string, q: Query) {
    await this.db.query(
      "INSERT INTO radar.contents(id,fingerprint,body) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET fingerprint=$2,body=jsonb_set($3::jsonb,'{discoveredAt}',radar.contents.body->'discoveredAt'),updated_at=now()",
      [c.id, c.fingerprint, JSON.stringify(c)],
    );
    await this.db.query(
      "INSERT INTO radar.discovery_hits VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [run, q.id, c.id, JSON.stringify(q)],
    );
  }
  async contents(ids: string[]) {
    if (!ids.length) return [];
    return (
      await this.db.query(
        "SELECT body FROM radar.contents WHERE id=ANY($1::text[])",
        [ids],
      )
    ).rows.map((r) => r.body as Content);
  }
  async cached<T>(key: string) {
    return (
      ((
        await this.db.query(
          "SELECT body FROM radar.analyses WHERE cache_key=$1",
          [key],
        )
      ).rows[0]?.body as T) ?? null
    );
  }
  async cache(key: string, id: string, phase: string, value: unknown) {
    await this.db.query(
      "INSERT INTO radar.analyses(cache_key,content_id,phase,body) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [key, id, phase, JSON.stringify(value)],
    );
  }
  async brief(id?: string, namespace?: string) {
    const r = id
      ? await this.db.query("SELECT body FROM radar.briefs WHERE id=$1", [id])
      : await this.db.query(
          "SELECT body FROM radar.briefs WHERE namespace=$1 ORDER BY created_at DESC LIMIT 1",
          [namespace],
        );
    return (r.rows[0]?.body as Brief) || null;
  }
  async saveBrief(b: Brief) {
    await this.db.query(
      "INSERT INTO radar.briefs(id,namespace,day,body) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [b.id, b.namespace, b.date, JSON.stringify(b)],
    );
    for (const i of b.items)
      await this.db.query(
        "INSERT INTO radar.brief_items VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [
          b.id,
          i.content.id,
          i.content.fingerprint,
          normalizeTopic(i.analysis.topicKey),
        ],
      );
  }
  async history(namespace: string) {
    const r = await this.db.query(
      "SELECT DISTINCT i.content_id,i.fingerprint,i.topic FROM radar.brief_items i JOIN radar.briefs b ON b.id=i.brief_id WHERE b.namespace=$1 AND EXISTS(SELECT 1 FROM radar.deliveries d WHERE d.brief_id=b.id AND d.status IN ('sent','unknown','sending'))",
      [namespace],
    );
    return {
      ids: new Set(r.rows.map((x) => String(x.content_id))),
      fingerprints: new Set(r.rows.map((x) => String(x.fingerprint))),
      topics: new Set(r.rows.map((x) => String(x.topic))),
    };
  }
  async preferences(namespace: string) {
    const rows = (
      await this.db.query(
        "SELECT f.rating,f.reason,c.body FROM radar.feedback f JOIN radar.contents c ON c.id=f.content_id WHERE f.namespace=$1 ORDER BY f.updated_at DESC LIMIT 20",
        [namespace],
      )
    ).rows;
    return JSON.stringify(
      rows.map((r) => ({
        rating: r.rating,
        reason: r.reason,
        title: (r.body as Content).title,
      })),
    );
  }
  async feedback(
    namespace: string,
    shortId: string,
    rating: string,
    reason: string,
  ) {
    const rows = (
      await this.db.query(
        "SELECT DISTINCT c.id FROM radar.contents c JOIN radar.discovery_hits h ON h.content_id=c.id JOIN radar.runs r ON r.id=h.run_id WHERE r.namespace=$1 AND c.id LIKE $2",
        [namespace, shortId + "%"],
      )
    ).rows;
    if (rows.length !== 1)
      throw new Error("内容编号不存在或不唯一，请使用简报中的编号");
    await this.db.query(
      "INSERT INTO radar.feedback(namespace,content_id,rating,reason) VALUES($1,$2,$3,$4) ON CONFLICT(namespace,content_id) DO UPDATE SET rating=$3,reason=$4,updated_at=now()",
      [namespace, rows[0].id, rating, reason],
    );
  }
  async reserve(
    namespace: string,
    date: string,
    r: Reservation,
    l: Config["limits"],
  ) {
    await this.db.query(
      "INSERT INTO radar.budgets(namespace,day) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [namespace, date],
    );
    const rows = (
      await this.db.query(
        "UPDATE radar.budgets SET source_calls=source_calls+$3,model_calls=model_calls+$4,tokens=tokens+$5,cost=cost+$6 WHERE namespace=$1 AND day=$2 AND source_calls+$3<=$7 AND model_calls+$4<=$8 AND tokens+$5<=$9 AND ($10::double precision IS NULL OR cost+$6<=$10) RETURNING namespace",
        [
          namespace,
          date,
          r.source,
          r.calls,
          r.tokens,
          r.cost,
          l.dailySourceCalls,
          l.dailyModelCalls,
          l.dailyTokens,
          l.dailyCost,
        ],
      )
    ).rows;
    return rows.length > 0;
  }
  async settle(
    namespace: string,
    date: string,
    r: Reservation,
    tokens: number | null,
    cost: number | null,
    u: Usage,
  ) {
    // Unknown responses retain the reservation: retries must not erase possible charges.
    await this.db.query(
      `WITH recorded AS (
      INSERT INTO radar.usage(id,run_id,phase,provider,model,input_tokens,output_tokens,estimated_cost,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id
    ) UPDATE radar.budgets SET tokens=GREATEST(0,tokens+$12),cost=GREATEST(0,cost+$13)
      WHERE namespace=$10 AND day=$11 AND EXISTS(SELECT 1 FROM recorded)`,
      [
        u.id,
        u.runId,
        u.phase,
        u.provider,
        u.model,
        u.input,
        u.output,
        u.cost,
        u.status,
        namespace,
        date,
        tokens === null ? 0 : tokens - r.tokens,
        cost === null ? 0 : cost - r.cost,
      ],
    );
  }
  async getDelivery(id: string) {
    const r = (
      await this.db.query("SELECT * FROM radar.deliveries WHERE id=$1", [id])
    ).rows[0];
    return r
      ? {
          id,
          briefId: String(r.brief_id),
          target: String(r.target),
          part: Number(r.part),
          body: r.body as Record<string, unknown>,
          status: String(r.status),
          attempts: Number(r.attempts),
        }
      : null;
  }
  async putDelivery(d: Delivery) {
    await this.db.query(
      "INSERT INTO radar.deliveries(id,brief_id,target,part,body) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
      [d.id, d.briefId, d.target, d.part, JSON.stringify(d.body)],
    );
  }
  async deliveryState(id: string, status: string, error = "") {
    await this.db.query(
      "UPDATE radar.deliveries SET status=$2,error=$3,attempts=attempts+CASE WHEN $2='sending' THEN 1 ELSE 0 END,updated_at=now() WHERE id=$1",
      [id, status, error],
    );
  }
}
export async function connect(): Promise<{
  store: SqlStore;
  close: () => Promise<void>;
  migration: () => Promise<void>;
}> {
  const ca = process.env.DATABASE_CA_FILE
    ? await readFile(process.env.DATABASE_CA_FILE, "utf8")
    : undefined;
  const url = new URL(requireEnv("DATABASE_URL"));
  // Remove pg URL SSL flags which could override explicit certificate verification.
  for (const p of ["sslmode", "sslcert", "sslkey", "sslrootcert"])
    url.searchParams.delete(p);
  const pool = new pg.Pool({
    connectionString: url.toString(),
    max: 3,
    ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 10000,
    statement_timeout: 30000,
  });
  pool.on("error", () => console.error("数据库连接中断，当前任务可稍后恢复"));
  const store = new SqlStore(pool);
  try {
    await pool.query("SELECT 1");
  } catch {
    await pool.end();
    throw new Error(
      "数据库连接失败，请检查 Supabase 连接串、密码、项目状态和 CA 证书",
    );
  }
  return {
    store,
    close: () => pool.end(),
    migration: async () => {
      const client = await pool.connect();
      try {
        const { migrate } = await import("./migrate.js");
        await migrate(client);
      } finally {
        client.release();
      }
    },
  };
}
