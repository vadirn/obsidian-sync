import { execFile } from "node:child_process";

const BIN = process.env.VAULT_QUERY_BIN ?? "vault-query";
const VAULT_ROOT = process.env.VAULT_ROOT ?? "/vault";

// --- consult --format json envelopes (consult_cmd.rs:57-72) ---

export interface SelectedDoc {
  path: string;
  title: string;
  type: string | null;
  score: number;
  body: string;
  tokens: number;
  links: string[];
  superseded: boolean;
}

export interface DocPointer {
  path: string;
  title: string;
  type: string | null;
  score: number;
  coverage: number;
  tokens_est: number;
  section?: string; // optional: absent when no section qualifies (serde skip_if none)
}

export interface ConsultSelected {
  status: "selected";
  query: string;
  total_tokens: number;
  docs: SelectedDoc[];
  pointers: DocPointer[];
}

export interface NearMiss {
  path: string;
  title: string;
  score: number;
  matched_terms: string[];
}

export interface ConsultAbstain {
  status: "abstain";
  query: string;
  reason: "no results" | "below threshold" | "low coverage" | "no score elbow";
  near_misses: NearMiss[];
}

export type ConsultResult = ConsultSelected | ConsultAbstain;

// --- read --format json shapes (read.rs:543-613) ---

export interface OverviewNode {
  address: string;
  heading: string;
  level: number;
  line: number;
  lines: number;
  tokens: number;
  slug: string;
  children: OverviewNode[];
}

export interface OverviewTextNode {
  address: string; // "0"
  label: string;
  line: number;
  lines: number;
  tokens: number;
}

export interface OverviewJson {
  path: string;
  fields: string[];
  links: number;
  text: OverviewTextNode | null;
  tree: OverviewNode[];
}

export interface UnfoldJson {
  path: string;
  address: string; // resolved canonical address
  heading: string;
  slug: string;
  level: number;
  line: number;
  lines: number;
  tokens: number;
  content: string;
  children: unknown[];
}

// --- search --format json shapes (search.rs) ---

export interface SearchResult {
  path: string;
  title: string;
  type: string | null;
  score: number;
  snippet: string;
  body: string;
}

export interface SearchJson {
  query: string;
  count: number;
  results: SearchResult[];
}

/** search projection that drops the heavy `body` field (output discipline). */
export interface SearchResultLite {
  path: string;
  title: string;
  type: string | null;
  score: number;
  snippet: string;
}

export interface SearchJsonLite {
  query: string;
  count: number;
  results: SearchResultLite[];
}

export class VaultQueryError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = "VaultQueryError";
  }
}

function run(args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile(BIN, args, { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 }, (err, stdout, stderr) => {
      // No err: exit 0 = selected / read ok.
      if (!err) {
        resolve({ stdout, code: 0 });
        return;
      }
      // execFile sets err.code to the numeric exit status only for a clean non-zero exit.
      // A timeout (code null, signal set) or maxBuffer overflow (code is the string
      // ERR_CHILD_PROCESS_STDIO_MAXBUFFER) leaves code non-numeric: stdout is partial or
      // empty, so treat it as failure rather than feeding "" to JSON.parse.
      const code = (err as { code?: unknown }).code;
      if (typeof code !== "number") {
        const signal = (err as { signal?: string | null }).signal;
        const reason =
          code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
            ? "output exceeded the 32MB maxBuffer"
            : signal
              ? `killed by ${signal} (likely the 60s timeout)`
              : (err as Error).message;
        reject(new VaultQueryError(`vault-query did not exit cleanly: ${reason}`, -1));
        return;
      }
      // exit 4 = consult abstain (NORMAL, envelope on stdout).
      if (code === 4) {
        resolve({ stdout, code });
        return;
      }
      // 1 = anyhow runtime error; 2 = clap usage error. Both real failures.
      reject(new VaultQueryError(stderr?.trim() || `vault-query exited ${code}`, code));
    });
  });
}

export async function consult(
  query: string,
  opts: { types?: string; includeSuperseded?: boolean } = {},
): Promise<ConsultResult> {
  // --vault-root bypasses HOME/cwd config resolution; --no-log avoids the JSONL
  // side-channel write (vault mount is read-only on the server).
  const args = ["consult", query, "--vault-root", VAULT_ROOT, "--format", "json", "--no-log"];
  if (opts.types) args.push("--types", opts.types);
  if (opts.includeSuperseded) args.push("--include-superseded");
  const { stdout } = await run(args);
  return JSON.parse(stdout) as ConsultResult;
}

/** read with no ADDRESS: heading tree + token sizes, no section content. */
export async function readOverview(path: string): Promise<OverviewJson> {
  // `read` has no JSONL side-channel, so (unlike consult) it takes no --no-log flag.
  const { stdout } = await run(["read", path, "--vault-root", VAULT_ROOT, "--format", "json"]);
  return JSON.parse(stdout) as OverviewJson;
}

/** read with an ADDRESS (numeric "1.4", slug, or "0"/"text"): resolved section content. */
export async function readSection(path: string, address: string): Promise<UnfoldJson> {
  // signature is `read <FILE> [ADDRESS] --flags`, so ADDRESS is positional before flags.
  const { stdout } = await run([
    "read",
    path,
    address,
    "--vault-root",
    VAULT_ROOT,
    "--format",
    "json",
  ]);
  return JSON.parse(stdout) as UnfoldJson;
}

/**
 * BM25/regex search, projected to drop the per-hit `body` (output discipline:
 * one full hit is ~2k tokens). The agent reads/gets what it wants afterwards.
 */
export async function search(opts: {
  query: string;
  limit?: number;
  regex?: boolean;
  types?: string;
  path?: string;
  noSuperseded?: boolean;
}): Promise<SearchJsonLite> {
  const args = ["search", opts.query, "--vault-root", VAULT_ROOT, "--format", "json"];
  if (opts.limit !== undefined) args.push("--limit", String(opts.limit));
  if (opts.regex) args.push("--regex");
  if (opts.types) args.push("--types", opts.types);
  if (opts.path) args.push("--path", opts.path);
  if (opts.noSuperseded) args.push("--no-superseded");
  const { stdout } = await run(args);
  const full = JSON.parse(stdout) as SearchJson;
  return {
    query: full.query,
    count: full.count,
    results: full.results.map(({ path, title, type, score, snippet }) => ({
      path,
      title,
      type,
      score,
      snippet,
    })),
  };
}

/** get: find and read a note/card/reference/checkpoint by name fragment. */
export async function get(name: string, opts: { noSuperseded?: boolean } = {}): Promise<string> {
  const args = ["get", name, "--vault-root", VAULT_ROOT];
  if (opts.noSuperseded) args.push("--no-superseded");
  const { stdout } = await run(args);
  return stdout;
}

/** resolve: slug → newline-separated vault path(s). */
export async function resolve(slug: string): Promise<string> {
  const { stdout } = await run(["resolve", slug, "--vault-root", VAULT_ROOT]);
  return stdout;
}

/** links: outgoing wikilinks from a file. */
export async function links(path: string): Promise<string> {
  const { stdout } = await run(["links", path, "--vault-root", VAULT_ROOT]);
  return stdout;
}

/** backlinks: incoming references to a file. */
export async function backlinks(
  path: string,
  opts: { noSuperseded?: boolean } = {},
): Promise<string> {
  const args = ["backlinks", path, "--vault-root", VAULT_ROOT];
  if (opts.noSuperseded) args.push("--no-superseded");
  const { stdout } = await run(args);
  return stdout;
}

/** cards: list all cards with metadata. */
export async function listCards(): Promise<string> {
  const { stdout } = await run(["cards", "--vault-root", VAULT_ROOT]);
  return stdout;
}

/** notes: list all notes with metadata. */
export async function listNotes(): Promise<string> {
  const { stdout } = await run(["notes", "--vault-root", VAULT_ROOT]);
  return stdout;
}

/** projects: list active projects (optional base view). */
export async function listProjects(opts: { view?: string } = {}): Promise<string> {
  const args = ["projects", "--vault-root", VAULT_ROOT];
  if (opts.view) args.push("--view", opts.view);
  const { stdout } = await run(args);
  return stdout;
}

/** tags: list tags across the vault, sorted by name or count. */
export async function listTags(opts: { sort?: string } = {}): Promise<string> {
  const args = ["tags", "--vault-root", VAULT_ROOT];
  if (opts.sort) args.push("--sort", opts.sort);
  const { stdout } = await run(args);
  return stdout;
}

/** files: list vault files, optionally scoped by folder/tag or counted. */
export async function listFiles(
  opts: { folder?: string; tag?: string; count?: boolean } = {},
): Promise<string> {
  const args = ["files", "--vault-root", VAULT_ROOT];
  if (opts.folder) args.push("--folder", opts.folder);
  if (opts.tag) args.push("--tag", opts.tag);
  if (opts.count) args.push("--count");
  const { stdout } = await run(args);
  return stdout;
}

/** list: files in a folder with frontmatter metadata. */
export async function listFolder(
  folder: string,
  opts: { fields?: string; noSuperseded?: boolean } = {},
): Promise<string> {
  const args = ["list", folder, "--vault-root", VAULT_ROOT];
  if (opts.fields) args.push("--fields", opts.fields);
  if (opts.noSuperseded) args.push("--no-superseded");
  const { stdout } = await run(args);
  return stdout;
}
