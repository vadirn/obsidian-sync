import type { Response } from "express";

/**
 * Write the JSON-RPC 2.0 error envelope every MCP error response shares.
 * Set any extra headers (WWW-Authenticate, Retry-After) on `res` before calling.
 */
export function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}
