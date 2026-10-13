import { readFile, readdir } from "node:fs/promises";
import { hash } from "./domain.js";
import type { Database } from "./storage.js";
export const migrationDirectory = new URL("../migrations/", import.meta.url);
/** Caller holds a dedicated connection for the entire transaction. */
export async function migrate(db: Database) {
  const files = (await readdir(migrationDirectory))
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  if (!files.length) throw new Error("找不到编号数据库迁移");
  await db.query("BEGIN");
  try {
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('radar:migrations'))",
    );
    const exists = (
      await db.query("SELECT to_regclass('radar.migrations') AS table_name")
    ).rows[0]?.table_name;
    const applied = exists
      ? (await db.query("SELECT id,checksum FROM radar.migrations")).rows
      : [];
    for (const file of files) {
      const sql = await readFile(new URL(file, migrationDirectory), "utf8"),
        checksum = hash(sql),
        id = file.slice(0, -4);
      const old = applied.find((row) => row.id === id);
      if (old) {
        if (old.checksum !== checksum)
          throw new Error("已应用的迁移文件被修改，请创建新迁移");
        continue;
      }
      await db.query(sql);
      await db.query(
        "INSERT INTO radar.migrations(id,checksum) VALUES($1,$2)",
        [id, checksum],
      );
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}
