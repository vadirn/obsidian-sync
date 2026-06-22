import { ConcurrencyLimitError } from "./limits.js";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/**
 * Run an MCP tool handler body, mapping the shared failure modes to the tool-result
 * shape: a busy signal (ConcurrencyLimitError) passes its retryable message through;
 * any other throw (VaultQueryError, etc.) becomes a `vault-query error` tool error.
 */
export async function handle(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: await fn() }] };
  } catch (e) {
    const text =
      e instanceof ConcurrencyLimitError
        ? (e as Error).message
        : `vault-query error: ${(e as Error).message}`;
    return { isError: true, content: [{ type: "text", text }] };
  }
}
