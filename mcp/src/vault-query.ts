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
