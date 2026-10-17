import { createHmac } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  hash,
  labelOf,
  sourceTime,
  type Brief,
  type BriefItem,
} from "./domain.js";
import type { Store } from "./storage.js";
import { withLease } from "./pipeline.js";

export function signature(timestamp: string, secret: string) {
  return createHmac("sha256", `${timestamp}\n${secret}`)
    .update("")
    .digest("base64");
}
const escape = (text: string) =>
  text.replace(/[<>]/g, "").replace(/([\\*\[\]_`])/g, "\\$1");
function elements(
  item: BriefItem,
  index: number,
  labelMap?: Record<string, string>,
): Record<string, unknown>[] {
  const a = item.analysis,
    c = item.content;
  const text = `**${index + 1}. ${escape(a.title)}** · ${labelOf(a.category, labelMap)}\n${escape(a.summary)}\n\n**值得读** ${escape(a.whyRead)}${a.extension ? `\n**AI 推演** ${escape(a.extension)}` : ""}${a.claimType === "hypothesis" ? "\n创意假设，非已发生事实" : ""}${a.caveat ? `\n阅读提示：${escape(a.caveat)}` : ""}\n\n${escape(c.author || "作者未提供")} · ${sourceTime(c)} · ${c.scope === "full_text" ? "正文" : "仅依据摘要/截取文本"} · 编号 ${c.id.slice(0, 12)}`;
  return [
    { tag: "markdown", content: text },
    {
      tag: "button",
      text: { tag: "plain_text", content: "阅读原文" },
      type: "default",
      behaviors: [{ type: "open_url", default_url: c.url }],
    },
  ];
}
function payload(
  brief: Brief,
  parts: Record<string, unknown>[],
  part: number,
  total: number,
): Record<string, unknown> {
  return {
    msg_type: "interactive",
    card: {
      schema: "2.0",
      header: {
        title: {
          tag: "plain_text",
          content: `灵感雷达 · ${brief.date} (${part}/${total})`,
        },
        template: "blue",
      },
      body: { elements: parts },
    },
  };
}
export function cards(brief: Brief): Record<string, unknown>[] {
  const pages: Record<string, unknown>[][] = [];
  let current: Record<string, unknown>[] = [];
  const add = (group: Record<string, unknown>[]) => {
    if (
      Buffer.byteLength(
        JSON.stringify(payload(brief, [...current, ...group], 99, 99)),
      ) > 18000 &&
      current.length
    ) {
      pages.push(current);
      current = [];
    }
    current.push(...group);
    if (
      Buffer.byteLength(JSON.stringify(payload(brief, current, 99, 99))) > 18000
    )
      throw new Error("单条简报超过飞书卡片大小上限，请缩短内容");
  };
  add([
    {
      tag: "markdown",
      content: `精选 ${brief.items.length} 条${brief.warnings?.length ? " · 本次覆盖有限，详见运行日志" : ""}${!brief.items.length ? (brief.warnings?.length ? "\n已分析部分暂未选出合格内容，不代表当天没有好内容。" : "\n今天没有足够好的内容，不凑数。") : ""}`,
    },
  ]);
  brief.items.forEach((item, i) => add(elements(item, i, brief.labels)));
  if (current.length) pages.push(current);
  return pages.map((page, i) => payload(brief, page, i + 1, pages.length));
}
export class DeliveryError extends Error {
  constructor(
    public uncertain: boolean,
    detail: string,
  ) {
    super(detail);
  }
}
export interface DeliveryAdapter {
  readonly target: string;
  render(brief: Brief): Record<string, unknown>[];
  send(body: Record<string, unknown>, signal?: AbortSignal): Promise<void>;
}
export class FeishuSender implements DeliveryAdapter {
  constructor(
    public webhook: string,
    private secret = "",
    private http: typeof fetch = fetch,
  ) {
    const url = new URL(webhook);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "open.feishu.cn" ||
      !url.pathname.startsWith("/open-apis/bot/v2/hook/")
    )
      throw new Error("飞书 Webhook 格式错误，请使用官方群机器人地址");
  }
  get target() {
    return hash(this.webhook);
  }
  render(brief: Brief) {
    return cards(brief);
  }
  async send(
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const message = {
      ...body,
      ...(this.secret
        ? { timestamp, sign: signature(timestamp, this.secret) }
        : {}),
    };
    if (Buffer.byteLength(JSON.stringify(message)) > 20000)
      throw new DeliveryError(false, "飞书消息超过 20 KB");
    let response: Response;
    try {
      response = await this.http(this.webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message),
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000),
      });
    } catch {
      throw new DeliveryError(
        true,
        "飞书请求未获响应，发送结果未知；请检查群后再决定重发",
      );
    }
    if (response.status >= 500)
      throw new DeliveryError(
        true,
        `飞书 HTTP ${response.status}，发送结果未知`,
      );
    if (!response.ok)
      throw new DeliveryError(false, `飞书 HTTP ${response.status}`);
    let data: Record<string, unknown>;
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new DeliveryError(true, "飞书返回内容无法解析，发送结果未知");
    }
    if (typeof data.code !== "number")
      throw new DeliveryError(true, "飞书响应缺少业务 code，发送结果未知");
    if (data.code !== 0)
      throw new DeliveryError(
        false,
        `飞书业务错误码 ${data.code}，检查签名、关键词和群配置`,
      );
  }
}
export async function deliver(
  store: Store,
  brief: Brief,
  sender: DeliveryAdapter,
  options: {
    allowUnknown?: boolean;
    resend?: string;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  await withLease(
    store,
    brief.namespace,
    async (signal) => {
      const parts = sender.render(brief);
      for (let i = 0; i < parts.length; i++) {
        const id = hash(
          `${brief.id}:${sender.target}:${i}:${options.resend || "default"}`,
        );
        await store.putDelivery({
          id,
          briefId: brief.id,
          target: sender.target,
          part: i,
          body: parts[i],
          status: "pending",
          attempts: 0,
        });
        const d = (await store.getDelivery(id))!;
        if (d.status === "sent") continue;
        if (["unknown", "sending"].includes(d.status) && !options.allowUnknown)
          throw new Error(
            "该分片发送结果未知，检查群后用 --allow-unknown 明确重试；其余已发送分片会跳过",
          );
        signal.throwIfAborted();
        await store.deliveryState(id, "sending");
        try {
          await sender.send(d.body, signal);
          await store.deliveryState(id, "sent");
        } catch (error) {
          await store.deliveryState(
            id,
            error instanceof DeliveryError && !error.uncertain
              ? "failed"
              : "unknown",
            error instanceof DeliveryError ? error.message : "发送结果未知",
          );
          throw error;
        }
        if (i < parts.length - 1) await delay(1100, undefined, { signal });
      }
    },
    options.signal,
  );
}
