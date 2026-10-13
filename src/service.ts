import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:http";
import { day, type Brief } from "./domain.js";
import { safeError, type Config } from "./config.js";
export function schedulePhase(
  now: Date,
  c: Config,
): "collect" | "deliver" | "idle" {
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: c.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
  if (clock >= c.schedule.deliver) return "deliver";
  if (clock >= c.schedule.collect) return "collect";
  return "idle";
}
interface ServiceOptions {
  port?: number;
  tickMs?: number;
  retryMs?: number;
  now?: () => Date;
  onListening?: (port: number) => void;
}
export function collectionDeadline(now: Date, c: Config): number {
  const planned = Date.parse(`${day(now)}T${c.schedule.deliver}:00+08:00`);
  // A machine starting after delivery time catches up only today, bounded to ten minutes.
  return planned > now.getTime() ? planned : now.getTime() + 600000;
}
/** Restarts recover the same pipeline and delivery IDs, not the latest manual preview. */
export async function service(
  c: Config,
  collect: (deadline: number) => Promise<Brief | null>,
  send: (brief: Brief) => Promise<void>,
  signal: AbortSignal,
  options: ServiceOptions = {},
) {
  let lastTick = Date.now(),
    healthy = true,
    working = false,
    nextAttempt = 0;
  let collected: Brief | null = null;
  const completed = new Set<string>();
  const server = createServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }
    const ok = healthy && (working || Date.now() - lastTick < 120000);
    response
      .writeHead(ok ? 200 : 503, { "Content-Type": "application/json" })
      .end(JSON.stringify({ status: ok ? "ok" : "degraded", working }));
  });
  const port = options.port ?? Number(process.env.HEALTH_PORT || 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("HEALTH_PORT 必须为有效端口");
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address && typeof address !== "string")
    options.onListening?.(address.port);
  console.log(
    `定时服务启动：${c.timezone}，采集 ${c.schedule.collect}，推送 ${c.schedule.deliver}`,
  );
  try {
    while (!signal.aborted) {
      lastTick = Date.now();
      const now = options.now?.() ?? new Date(),
        date = day(now),
        phase = schedulePhase(now, c);
      for (const key of completed)
        if (!key.startsWith(date)) completed.delete(key);
      try {
        if (phase !== "idle" && Date.now() >= nextAttempt) {
          working = true;
          if (!completed.has(date + ":collect")) {
            collected = await collect(collectionDeadline(now, c));
            if (!collected || collected.date !== date)
              throw new Error("当天简报尚未完成，稍后恢复");
            completed.add(date + ":collect");
          }
          if (phase === "deliver" && !completed.has(date + ":deliver")) {
            await send(collected!);
            completed.add(date + ":deliver");
          }
          healthy = true;
        }
      } catch (error) {
        healthy = false;
        nextAttempt = Date.now() + (options.retryMs ?? 300000);
        console.error(`任务失败，稍后检查恢复：${safeError(error)}`);
      } finally {
        working = false;
      }
      try {
        await delay(options.tickMs ?? 30000, undefined, { signal });
      } catch {
        break;
      }
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
