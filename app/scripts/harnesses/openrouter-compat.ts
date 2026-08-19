type RequestInput = {
  url: URL;
  options?: RequestInit;
};

/**
 * Remove only the invalid item ID synthesized by @openrouter/agent for a
 * function-call result. `call_id` remains the required call/result linkage.
 */
export const openRouterFunctionOutputCompatibilityHook = {
  beforeCreateRequest(_context: unknown, input: RequestInput): RequestInput {
    const body = input.options?.body;
    if (typeof body !== "string") return input;

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return input;
    }
    if (!isRecord(payload) || !Array.isArray(payload.input)) return input;

    let changed = false;
    const normalizedInput = payload.input.map((item) => {
      if (
        isRecord(item)
        && item.type === "function_call_output"
        && typeof item.call_id === "string"
        && item.call_id.length > 0
        && item.id === `output_${item.call_id}`
      ) {
        const { id: _syntheticId, ...normalized } = item;
        changed = true;
        return normalized;
      }
      return item;
    });
    if (!changed) return input;

    return {
      ...input,
      options: {
        ...input.options,
        body: JSON.stringify({ ...payload, input: normalizedInput }),
      },
    };
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
