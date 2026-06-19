import {
  consult,
  readOverview,
  readSection,
  type DocPointer,
  type OverviewNode,
} from "./vault-query.js";
import { synthesize } from "./synthesis.js";

export interface Slice {
  path: string;
  address: string;
  excerpt: string;
}

export interface ConsultToolResult {
  synthesis: string | null;
  slices: Slice[];
  abstained: boolean;
  reason?: string; // present when abstained
  note?: string; // e.g. "drilled top 3 of N pointers"
}

const MAX_EXCERPT_CHARS = 6000;
const MAX_DRILLED_POINTERS = 3; // navigator protocol: rank by coverage, drill top 3

function trim(s: string): string {
  return s.length > MAX_EXCERPT_CHARS ? s.slice(0, MAX_EXCERPT_CHARS) + "…" : s;
}

/** Flatten an overview tree and pick the densest node (most tokens) to drill. */
function densestNode(tree: OverviewNode[]): OverviewNode | null {
  let best: OverviewNode | null = null;
  const walk = (nodes: OverviewNode[]): void => {
    for (const n of nodes) {
      if (!best || n.tokens > best.tokens) best = n;
      if (n.children?.length) walk(n.children);
    }
  };
  walk(tree);
  return best;
}

/**
 * Drill one pointer into a slice. Uses the pointer's `section` address when present
 * (the densest matching section, per consult.rs:416); otherwise reads the overview
 * and drills the densest heading, falling back to the pre-heading text region ("0").
 */
async function drill(p: DocPointer): Promise<Slice | null> {
  try {
    if (p.section) {
      const u = await readSection(p.path, p.section);
      return { path: p.path, address: u.address, excerpt: trim(u.content) };
    }
    const overview = await readOverview(p.path);
    const node = densestNode(overview.tree);
    const address = node?.address ?? (overview.text ? "0" : null);
    if (!address) return null;
    const u = await readSection(p.path, address);
    return { path: p.path, address: u.address, excerpt: trim(u.content) };
  } catch {
    // address out of range / fragment: retry the pre-heading region once, else drop.
    try {
      const u = await readSection(p.path, "0");
      return { path: p.path, address: u.address, excerpt: trim(u.content) };
    } catch {
      return null;
    }
  }
}

export async function runConsult(
  query: string,
  opts: { types?: string; includeSuperseded?: boolean } = {},
): Promise<ConsultToolResult> {
  const result = await consult(query, opts);

  if (result.status === "abstain") {
    return { synthesis: null, slices: [], abstained: true, reason: result.reason };
  }

  // Inlined docs become slices directly; bodies are already full.
  const slices: Slice[] = result.docs.map((d) => ({
    path: d.path,
    address: "(full document)",
    excerpt: trim(d.body),
  }));

  // Drill the top pointers (docs too large to inline) by coverage.
  const ranked = [...result.pointers].sort(
    (a, b) => b.coverage - a.coverage || b.tokens_est - a.tokens_est,
  );
  let note: string | undefined;
  if (ranked.length > MAX_DRILLED_POINTERS) {
    note = `drilled top ${MAX_DRILLED_POINTERS} of ${ranked.length} pointers`;
  }
  for (const p of ranked.slice(0, MAX_DRILLED_POINTERS)) {
    const s = await drill(p);
    if (s) slices.push(s);
  }

  const synthesis = await synthesize(query, slices);
  return { synthesis, slices, abstained: false, note };
}
