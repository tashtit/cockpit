/**
 * Guards for untrusted JSON — provider logs, agent configs, persisted state, CLI output.
 * Every reader that walks such a value asks first whether it is an object with keys;
 * each used to spell the question itself.
 */

/** A plain JSON object: not null, not an array. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** `v` as a plain JSON object, or null for anything else (arrays included). */
export function asRecord(v: unknown): Record<string, unknown> | null {
  return isRecord(v) ? v : null
}
