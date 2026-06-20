import { randomUUID } from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { runConsult } from "./consult-tool.js";
import { synthesisEnabled } from "./synthesis.js";
import { oauthProvider, basicAuthGate } from "./oauth.js";

const PORT = Number(process.env.PORT ?? 3000);
const RESOURCE = process.env.MCP_RESOURCE_URL ?? "https://localhost/mcp";
const AUTH_MODE = (process.env.MCP_AUTH_MODE ?? "bearer") as "none" | "bearer" | "oauth";
const STATIC_TOKEN = process.env.MCP_BEARER_TOKEN ?? "";
const ORIGIN = RESOURCE.replace(/\/mcp$/, "");

if (AUTH_MODE === "oauth" && !process.env.MCP_AUTH_PASSWORD) {
  // The /authorize gate is the only thing standing between the public internet
  // and a token for the private vault. Refuse to start without it.
  throw new Error("MCP_AUTH_MODE=oauth requires MCP_AUTH_PASSWORD (the /authorize gate).");
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "obsidian-consult", version: "1.0.0" });
  server.registerTool(
    "consult",
    {
      title: "Consult the vault",
      description:
        "Retrieve the user's own prior thinking (notes, decisions, definitions, positions) from " +
        "their Obsidian vault for a task framing. Returns a query-side synthesis plus the evidence " +
        "slices it rests on (path + section address + excerpt). Sets abstained:true when nothing " +
        "clears the relevance gate (confident silence): proceed without vault context in that case.",
      inputSchema: {
        query: z.string().describe("The task framing or topic to search the vault for."),
        types: z
          .string()
          .optional()
          .describe(
            'Comma-separated frontmatter types to scope to (e.g. "track,checkpoint", "card,note").',
          ),
        include_superseded: z
          .boolean()
          .optional()
          .describe("Include superseded entries and checkpoints in scope."),
      },
    },
    async ({ query, types, include_superseded }) => {
      try {
        const result = await runConsult(query, { types, includeSuperseded: include_superseded });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (e) {
        // exit 1/2 from vault-query → tool error surfaced to the client.
        return {
          isError: true,
          content: [{ type: "text", text: `vault-query error: ${(e as Error).message}` }],
        };
      }
    },
  );
  return server;
}

const app = express();
app.use(express.json({ limit: "4mb" }));

if (AUTH_MODE === "oauth") {
  // Self-hosted OAuth 2.1 AS. mcpAuthRouter serves /authorize, /token, /register,
  // /revoke, /.well-known/oauth-authorization-server, and the path-specific
  // /.well-known/oauth-protected-resource/mcp. The Basic gate runs ahead of the
  // SDK's /authorize handler so only an authenticated human can mint a code.
  app.use("/authorize", basicAuthGate);
  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(ORIGIN),
      baseUrl: new URL(ORIGIN),
      resourceServerUrl: new URL(RESOURCE),
      scopesSupported: [],
      resourceName: "Obsidian consult vault",
    }),
  );
} else {
  // RFC 9728 Protected Resource Metadata: points OAuth clients at the authorization server.
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    const issuer = process.env.MCP_OAUTH_ISSUER ?? ORIGIN;
    res.json({ resource: RESOURCE, authorization_servers: [issuer] });
  });
}

function authGuard(req: Request, res: Response, next: NextFunction): void {
  if (AUTH_MODE === "none") return next();

  const hdr = req.header("authorization") ?? "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";

  if (AUTH_MODE === "bearer" && token && STATIC_TOKEN && token === STATIC_TOKEN) {
    return next();
  }
  // oauth mode never reaches here: those routes use requireBearerAuth (see mcpAuth).
  res
    .status(401)
    .set(
      "WWW-Authenticate",
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`,
    )
    .json({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null });
}

// In oauth mode the /mcp routes validate OAuth-issued (or static) tokens via the
// SDK middleware; otherwise the bearer/none authGuard applies.
const mcpAuth =
  AUTH_MODE === "oauth"
    ? requireBearerAuth({
        verifier: oauthProvider,
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(RESOURCE)),
      })
    : authGuard;

// Stateful Streamable HTTP: one transport per MCP session, keyed by Mcp-Session-Id.
const transports: Record<string, StreamableHTTPServerTransport> = {};

app.post("/mcp", mcpAuth, async (req: Request, res: Response) => {
  const sid = req.header("mcp-session-id");
  let transport: StreamableHTTPServerTransport | undefined = sid ? transports[sid] : undefined;

  if (!transport && !sid && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true, // plain JSON replies (no SSE), simpler for clients and curl
      onsessioninitialized: (id) => {
        transports[id] = transport!;
      },
    });
    transport.onclose = () => {
      if (transport!.sessionId) delete transports[transport!.sessionId];
    };
    await buildServer().connect(transport);
  } else if (!transport) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: no valid session ID" },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

// GET (server→client SSE stream) and DELETE (terminate session) reuse the session transport.
async function sessionRequest(req: Request, res: Response): Promise<void> {
  const sid = req.header("mcp-session-id");
  const transport = sid ? transports[sid] : undefined;
  if (!transport) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transport.handleRequest(req, res);
}

app.get("/mcp", mcpAuth, sessionRequest);
app.delete("/mcp", mcpAuth, sessionRequest);

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, auth: AUTH_MODE, synthesis: synthesisEnabled() });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `obsidian-consult MCP on :${PORT} (auth=${AUTH_MODE}, synthesis=${synthesisEnabled() ? "on" : "off"})`,
  );
});
