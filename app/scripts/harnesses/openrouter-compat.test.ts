import { test } from "node:test";
import assert from "node:assert/strict";
import { openRouterFunctionOutputCompatibilityHook } from "./openrouter-compat.ts";

test("removes the SDK's synthetic function-call output ID without changing its linkage or output", () => {
  const url = new URL("https://openrouter.ai/api/v1/responses");
  const requestInput = {
    url,
    options: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "example/model",
        input: [
          { type: "function_call", id: "fc_123", call_id: "call_abc", name: "run_cli", arguments: "{}" },
          { type: "function_call_output", id: "output_call_abc", call_id: "call_abc", output: "{\"ok\":true}" },
          { role: "user", content: "continue" },
        ],
      }),
    },
  };

  const normalized = openRouterFunctionOutputCompatibilityHook.beforeCreateRequest({}, requestInput);

  assert.notStrictEqual(normalized, requestInput);
  assert.strictEqual(normalized.url, url);
  assert.equal(normalized.options?.method, "POST");
  assert.deepEqual(JSON.parse(String(normalized.options?.body)), {
    model: "example/model",
    input: [
      { type: "function_call", id: "fc_123", call_id: "call_abc", name: "run_cli", arguments: "{}" },
      { type: "function_call_output", call_id: "call_abc", output: "{\"ok\":true}" },
      { role: "user", content: "continue" },
    ],
  });
});

test("removes every matching synthetic output ID while preserving valid and unrelated IDs", () => {
  const requestInput = {
    url: new URL("https://openrouter.ai/api/v1/responses"),
    options: {
      body: JSON.stringify({
        input: [
          { type: "function_call_output", id: "output_call_one", call_id: "call_one", output: "one" },
          { type: "function_call_output", id: "output_call_two", call_id: "call_two", output: "two" },
          { type: "function_call_output", id: "fc_valid", call_id: "call_three", output: "three" },
          { type: "function_call_output", id: "output_someone_else", call_id: "call_four", output: "four" },
          { type: "message", id: "output_call_five", call_id: "call_five", content: "unchanged" },
        ],
      }),
    },
  };

  const normalized = openRouterFunctionOutputCompatibilityHook.beforeCreateRequest({}, requestInput);
  const body = JSON.parse(String(normalized.options?.body));

  assert.deepEqual(body.input, [
    { type: "function_call_output", call_id: "call_one", output: "one" },
    { type: "function_call_output", call_id: "call_two", output: "two" },
    { type: "function_call_output", id: "fc_valid", call_id: "call_three", output: "three" },
    { type: "function_call_output", id: "output_someone_else", call_id: "call_four", output: "four" },
    { type: "message", id: "output_call_five", call_id: "call_five", content: "unchanged" },
  ]);
});

test("returns the original request object for bodies that need no normalization", () => {
  const fixtures: Array<RequestInit["body"] | null | undefined> = [
    undefined,
    null,
    new Uint8Array([1, 2, 3]),
    "not json",
    "null",
    "[]",
    JSON.stringify({ input: "not-an-array" }),
    JSON.stringify({ input: [{ type: "function_call_output", id: "output_", call_id: "", output: "x" }] }),
    JSON.stringify({ input: [{ type: "function_call_output", id: "fc_valid", call_id: "call_x", output: "x" }] }),
  ];

  for (const body of fixtures) {
    const requestInput = {
      url: new URL("https://openrouter.ai/api/v1/responses"),
      options: { method: "POST", body },
    };
    assert.strictEqual(
      openRouterFunctionOutputCompatibilityHook.beforeCreateRequest({}, requestInput),
      requestInput,
      `expected no-op for ${typeof body === "string" ? body : String(body)}`,
    );
  }
});
