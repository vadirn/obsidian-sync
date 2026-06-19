// End-to-end MCP transport test: connects to the running server over Streamable HTTP
// exactly as Claude's custom connector does (initialize handshake, session, tools/call).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_ = process.env.MCP_URL ?? "http://mcp.localhost:3000/mcp";
const TOKEN = process.env.MCP_BEARER_TOKEN ?? "";
const transport = new StreamableHTTPClientTransport(new URL(URL_), {
  requestInit: TOKEN ? { headers: { Authorization: `Bearer ${TOKEN}` } } : undefined,
});
const client = new Client({ name: "test-client", version: "0.0.0" });
await client.connect(transport);
console.log("connected; session =", transport.sessionId);

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));

for (const query of process.argv.slice(2)) {
  const res = await client.callTool({ name: "consult", arguments: { query } });
  const payload = JSON.parse(res.content[0].text);
  console.log(`\n=== consult("${query}") ===`);
  console.log(
    "abstained:",
    payload.abstained,
    "| reason:",
    payload.reason ?? "-",
    "| synthesis:",
    payload.synthesis ? "present" : "null",
  );
  console.log(
    "slices:",
    payload.slices
      .map((s) => `${s.path} · ${s.address} (${s.excerpt.length} chars)`)
      .join("\n        ") || "(none)",
  );
  if (payload.synthesis) console.log("synthesis:", payload.synthesis.slice(0, 300));
}

await client.close();
