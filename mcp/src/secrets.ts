import { readFileSync } from "node:fs";

/**
 * Resolve a secret from the environment, preferring an inline value and falling
 * back to a file (Docker-secret style) when `<NAME>_FILE` is set. The file form
 * keeps the secret out of the container environment, so it never shows up in
 * `docker inspect`, `/proc/<pid>/environ`, or the env of the spawned vault-query
 * child.
 *
 * Precedence: `process.env[NAME]` (local dev / Doppler injection) wins when
 * non-empty; otherwise read and trim the file at `process.env[NAME_FILE]`. A
 * missing or unreadable file is logged and treated as absent, never thrown, so a
 * secret outage degrades the same way an empty env var would.
 */
export function resolveSecret(name: string): string {
  const direct = process.env[name] ?? "";
  if (direct) return direct;
  const file = process.env[`${name}_FILE`] ?? "";
  if (file) {
    try {
      return readFileSync(file, "utf8").trim();
    } catch (e) {
      console.error(`could not read ${name}_FILE (${file}): ${(e as Error).message}`);
    }
  }
  return "";
}
