import type { Slice } from "./consult-tool.js";
import { resolveSecret } from "./secrets.js";

const BASE_URL = process.env.FIREWORKS_BASE_URL ?? "https://api.fireworks.ai/inference/v1";
const MODEL = process.env.FIREWORKS_MODEL ?? "accounts/fireworks/models/glm-5p2";
const MAX_TOKENS = Number(process.env.FIREWORKS_MAX_TOKENS ?? 1024);

// Key from env, or from a file (Docker-secret style) when FIREWORKS_API_KEY_FILE is set.
const API_KEY = resolveSecret("FIREWORKS_API_KEY");

export function synthesisEnabled(): boolean {
  return API_KEY.length > 0;
}

// Mirrors the vault-navigator merge protocol (nix PR #52): merge QUERY-side only,
// in the user's own framing, citing only the supplied slices, never fabricating.
// Task-side adaptation is left to the calling client (the consult skill's contract).
const SYSTEM_PROMPT = [
  "You merge a user's own prior notes from their personal knowledge vault to answer a QUERY.",
  "You are given the query and a set of evidence slices (each: a vault path, a section address, and an excerpt).",
  "Write tight, connected prose that merges what the slices say about the query, phrased in the user's own framing where the notes supply it.",
  "Rules:",
  "- Match the synthesis language to the QUERY language (a Russian query → Russian prose, an English query → English), whatever language the slices use. Translate slice content into the query's language; keep proper nouns, code, and identifiers verbatim.",
  "- Ground every claim in the supplied slices: assert only facts, citations, paths, and positions the slices support.",
  "- Merge query-side: report what the user already thinks about the query, and leave task-side adaptation to the caller.",
  "- Keep only the slices that bear on the query. When nothing bears on it, state that plainly in one sentence.",
  "- Output the synthesis prose directly and keep it concise: start with the substance itself.",
].join("\n");

function renderSlices(slices: Slice[]): string {
  return slices.map((s, i) => `[${i + 1}] ${s.path} · ${s.address}\n${s.excerpt}`).join("\n\n");
}

/**
 * Query-scoped synthesis of the slices via Fireworks (GLM). Returns prose, or null
 * if synthesis is disabled (no API key) or the call fails. Callers fall back to
 * returning slices alone so a synthesis outage never breaks the consult tool.
 */
export async function synthesize(query: string, slices: Slice[]): Promise<string | null> {
  if (!synthesisEnabled() || slices.length === 0) return null;

  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Query: ${query}\n\nSlices:\n${renderSlices(slices)}\n\nSynthesis:`,
      },
    ],
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`fireworks synthesis failed: ${res.status} ${detail.slice(0, 300)}`);
      return null;
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = json.choices?.[0]?.message?.content?.trim();
    return text && text.length > 0 ? text : null;
  } catch (e) {
    console.error(`fireworks synthesis error: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
