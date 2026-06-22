// Shared configuration resolved once at startup. Centralized so the OAuth AS
// (oauth.ts) and the HTTP server (server.ts) agree on resource identity and the
// static-token escape hatch: a drift between two copies would desync OAuth
// audience checks from the server's advertised resource.
import { resolveSecret } from "./secrets.js";

/** Canonical resource URL (the MCP endpoint); OAuth audience and `aud` claims bind to it. */
export const RESOURCE = process.env.MCP_RESOURCE_URL ?? "https://localhost/mcp";

/** Origin of RESOURCE (the OAuth issuer / base URL): RESOURCE without the trailing /mcp. */
export const ORIGIN = RESOURCE.replace(/\/mcp$/, "");

/** Static bearer escape hatch shared by the SDK test client and header-based clients. */
export const STATIC_TOKEN = resolveSecret("MCP_BEARER_TOKEN");
