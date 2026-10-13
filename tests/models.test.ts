import test from "node:test";
import assert from "node:assert/strict";
import { AiModel, ModelError } from "../src/models.js";
import { loadConfig } from "../src/config.js";
import { DemoSource } from "../src/demo.js";

test("DeepSeek 提供商请求使用 JSON 输出与结构校验（注入 HTTP，无真实付费请求）", async () => {
  process.env.DEEPSEEK_API_KEY = "mock-only";
  const c = await loadConfig();
  c.models.screen.model = "test-model";
  let request: Record<string, unknown> | undefined;
  const http: typeof fetch = async (_input, init) => {
    request = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        id: "test",
        object: "chat.completion",
        created: 1,
        model: "test-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                category: "trading",
                decision: "keep",
                discovery: "观察",
                reason: "原因",
              }),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
    );
  };
  const item = (
    await new DemoSource().fetch(
      { id: "q", kind: "search", text: "", category: "business" },
      1,
    )
  ).items[0];
  item.author = "行业维修研究所";
  const result = await new AiModel(http).generate("screen", item, "[]", c);
  assert.equal(result.input, 10);
  assert.equal(result.output, 20);
  assert.equal(result.value.category, "trading");
  assert.equal(
    (request!.response_format as { type: string }).type,
    "json_object",
  );
  assert.ok(JSON.stringify(request).includes("JSON"));
  const messages = request!.messages as { role: string; content: string }[];
  const input = JSON.parse(messages.find((m) => m.role === "user")!.content);
  assert.equal(input.author, item.author);
  assert.equal(input.text, item.text);
  const malformed: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        id: "bad",
        object: "chat.completion",
        created: 1,
        model: "test-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "不是有效 JSON" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
    );
  await assert.rejects(
    new AiModel(malformed).generate("screen", item, "[]", c),
    (error) =>
      error instanceof ModelError && error.input === 10 && error.output === 20,
  );
});
test("GPT 使用 Responses API，失败只给出安全错误而不泄露响应内容", async () => {
  process.env.OPENAI_API_KEY = "mock-only";
  const c = await loadConfig();
  c.models.screen = {
    ...c.models.screen,
    provider: "openai",
    model: "test-model",
  };
  let url = "";
  const http: typeof fetch = async (input) => {
    url = String(input);
    return new Response(
      JSON.stringify({
        id: "resp_test",
        object: "response",
        created_at: 1,
        status: "completed",
        model: "test-model",
        output: [
          {
            type: "message",
            id: "msg_test",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  category: "trading",
                  decision: "keep",
                  discovery: "观察",
                  reason: "原因",
                }),
                annotations: [],
              },
            ],
          },
        ],
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 20,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 30,
        },
      }),
    );
  };
  const item = (
    await new DemoSource().fetch(
      { id: "q", kind: "search", text: "", category: "business" },
      1,
    )
  ).items[0];
  const result = await new AiModel(http).generate("screen", item, "[]", c);
  assert.ok(url.endsWith("/responses"));
  assert.equal(result.input, 10);
  assert.equal(result.value.category, "trading");
  await assert.rejects(
    new AiModel(
      async () => new Response("secret-response", { status: 401 }),
    ).generate("screen", item, "[]", c),
    (error) =>
      error instanceof ModelError && !error.message.includes("secret-response"),
  );
});
