import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  search,
  readOverview,
  readSection,
  get,
  resolve,
  links,
  backlinks,
  listCards,
  listNotes,
  listProjects,
  listTags,
  listFiles,
  listFolder,
  VaultQueryError,
} from "./vault-query.js";
import { Semaphore, ConcurrencyLimitError } from "./limits.js";

// Listing/get output can be large; cap text pass-through with a visible marker
// so a runaway dump can't blow the agent's context window.
const MAX_TEXT_CHARS = 12000;

function capText(s: string): string {
  return s.length > MAX_TEXT_CHARS ? s.slice(0, MAX_TEXT_CHARS) + "\n… (truncated)" : s;
}

/**
 * Reject caller-supplied paths that escape the vault. execFile passes argv (no
 * shell), so injection is already impossible; this stops an agent reading
 * `/etc/...` or climbing out with `../`. Throws VaultQueryError so the handler
 * maps it to a tool error like any other failure.
 */
function assertVaultPath(p: string): void {
  if (p.startsWith("/") || p.startsWith("\\")) {
    throw new VaultQueryError(`path must be vault-relative, not absolute: ${p}`, 2);
  }
  const segments = p.split(/[/\\]/);
  if (segments.some((seg) => seg === "..")) {
    throw new VaultQueryError(`path must not contain ".." segments: ${p}`, 2);
  }
}

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/** Run a handler body, mapping VaultQueryError/busy to the shared tool-error shape. */
async function handle(fn: () => Promise<string>): Promise<ToolResult> {
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

export function registerVaultTools(server: McpServer, indexSemaphore: Semaphore): void {
  server.registerTool(
    "search",
    {
      title: "Search the vault (lexical)",
      description:
        "Lexical full-text search (BM25, or regex with regex:true) over the vault. Returns ranked " +
        "hits projected to path/title/type/score/snippet (no body) — then `read` or `get` the ones " +
        'you want. Use this for known-item lookup by keyword. For "what\'s my thinking on X" use ' +
        "`consult` instead: it selects and abstains, which search does not.",
      inputSchema: {
        query: z.string().describe("Search query (terms for BM25, or a pattern when regex:true)."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max results (BM25 mode). Default 20."),
        regex: z.boolean().optional().describe("Use regex grep instead of BM25 ranking."),
        types: z
          .string()
          .optional()
          .describe('Comma-separated frontmatter types to scope to (e.g. "card,note").'),
        path: z.string().optional().describe("Limit search to a vault subfolder."),
        no_superseded: z
          .boolean()
          .optional()
          .describe("Exclude superseded entries and checkpoints."),
      },
    },
    async ({ query, limit, regex, types, path, no_superseded }) =>
      // search rebuilds the tantivy index like consult, so it shares the OOM backstop.
      handle(() =>
        indexSemaphore
          .run(() => search({ query, limit, regex, types, path, noSuperseded: no_superseded }))
          .then((r) => JSON.stringify(r)),
      ),
  );

  server.registerTool(
    "read",
    {
      title: "Read a vault file or section",
      description:
        "Read a vault file. With no address: a folded overview tree (headings + token sizes) to " +
        'navigate by. With an address (numeric like "1.4", a heading slug, or "0"/"text" for the ' +
        "pre-heading region): the resolved section content. Path must be vault-relative.",
      inputSchema: {
        path: z.string().describe('Vault-relative path, e.g. "20 cards/Impureim sandwich.md".'),
        address: z
          .string()
          .optional()
          .describe('Section address: numeric (e.g. "1.4"), heading slug, or "0"/"text".'),
      },
    },
    async ({ path, address }) =>
      handle(async () => {
        assertVaultPath(path);
        const out = address ? await readSection(path, address) : await readOverview(path);
        return JSON.stringify(out);
      }),
  );

  server.registerTool(
    "get",
    {
      title: "Get a vault entry by name",
      description:
        "Find and read a single note/card/reference/checkpoint by name fragment, returning its " +
        "content. Use for known-item lookup when you know roughly what it's called. For \"what's my " +
        'thinking on X" use `consult`.',
      inputSchema: {
        name: z.string().describe("Name fragment to resolve to one entry."),
        no_superseded: z.boolean().optional().describe("Exclude superseded entries."),
      },
    },
    async ({ name, no_superseded }) =>
      handle(() => get(name, { noSuperseded: no_superseded }).then(capText)),
  );

  server.registerTool(
    "resolve",
    {
      title: "Resolve a slug to path(s)",
      description:
        'Resolve a slug (e.g. "impureim-sandwich") to its vault file path(s), one per line.',
      inputSchema: {
        slug: z.string().describe("Slug to resolve."),
      },
    },
    async ({ slug }) => handle(() => resolve(slug).then(capText)),
  );

  server.registerTool(
    "links",
    {
      title: "Outgoing links from a file",
      description: "List the outgoing wikilinks from a vault file. Path must be vault-relative.",
      inputSchema: {
        path: z.string().describe("Vault-relative path to the .md file."),
      },
    },
    async ({ path }) =>
      handle(() => {
        assertVaultPath(path);
        return links(path).then(capText);
      }),
  );

  server.registerTool(
    "backlinks",
    {
      title: "Incoming links to a file",
      description: "List incoming references to a vault file. Path must be vault-relative.",
      inputSchema: {
        path: z.string().describe("Vault-relative path to the .md file."),
        no_superseded: z.boolean().optional().describe("Exclude superseded entries."),
      },
    },
    async ({ path, no_superseded }) =>
      handle(() => {
        assertVaultPath(path);
        return backlinks(path, { noSuperseded: no_superseded }).then(capText);
      }),
  );

  server.registerTool(
    "list_cards",
    {
      title: "List all cards",
      description: "Enumerate every card in the vault with metadata.",
      inputSchema: {},
    },
    async () => handle(() => listCards().then(capText)),
  );

  server.registerTool(
    "list_notes",
    {
      title: "List all notes",
      description: "Enumerate every note in the vault with metadata.",
      inputSchema: {},
    },
    async () => handle(() => listNotes().then(capText)),
  );

  server.registerTool(
    "list_projects",
    {
      title: "List active projects",
      description: "List active projects (optionally a named base view).",
      inputSchema: {
        view: z.string().optional().describe("Base view name to apply."),
      },
    },
    async ({ view }) => handle(() => listProjects({ view }).then(capText)),
  );

  server.registerTool(
    "list_tags",
    {
      title: "List tags",
      description: "List tags across the vault.",
      inputSchema: {
        sort: z.enum(["name", "count"]).optional().describe("Sort order. Default: name."),
      },
    },
    async ({ sort }) => handle(() => listTags({ sort }).then(capText)),
  );

  server.registerTool(
    "list_files",
    {
      title: "List vault files",
      description: "List vault files, optionally scoped by folder or tag, or just counted.",
      inputSchema: {
        folder: z.string().optional().describe("Limit to a subfolder."),
        tag: z.string().optional().describe("Filter to files carrying this tag."),
        count: z.boolean().optional().describe("Return only the count."),
      },
    },
    async ({ folder, tag, count }) => handle(() => listFiles({ folder, tag, count }).then(capText)),
  );

  server.registerTool(
    "list_folder",
    {
      title: "List a folder with metadata",
      description:
        'List files in a vault folder (e.g. "20 cards") with frontmatter metadata. ' +
        "Folder must be vault-relative.",
      inputSchema: {
        folder: z.string().describe('Folder relative to vault root, e.g. "20 cards".'),
        fields: z
          .string()
          .optional()
          .describe("Comma-separated extra frontmatter fields to display."),
        no_superseded: z.boolean().optional().describe("Exclude superseded entries."),
      },
    },
    async ({ folder, fields, no_superseded }) =>
      handle(() => {
        assertVaultPath(folder);
        return listFolder(folder, { fields, noSuperseded: no_superseded }).then(capText);
      }),
  );
}
