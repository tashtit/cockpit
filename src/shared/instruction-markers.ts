/**
 * The managed-block markers, shared by the main process (which writes them) and the
 * renderer (which draws them as rails in the pre-apply review). One definition, so
 * the review can never show a marker the writer doesn't use.
 *
 * The pair Cockpit writes is the one the `agent-parity` plugin (the org's shared
 * agent toolkit) calls canonical: both manage the same files, and one block under
 * one name is the only way they can share a file rather than fight over it. The
 * pair Cockpit wrote before that is read as the same block and renamed on the next
 * apply — the plugin reads both too, so a file is never wrong for either.
 */
export const START = '<!-- agent-parity:shared:start -->'
export const END = '<!-- agent-parity:shared:end -->'
export const LEGACY_START = '<!-- cockpit:shared:start -->'
export const LEGACY_END = '<!-- cockpit:shared:end -->'

/** Every spelling that opens or closes a block — canonical first. */
export const START_MARKERS: readonly string[] = [START, LEGACY_START]
export const END_MARKERS: readonly string[] = [END, LEGACY_END]

/** A line that is nothing but a marker — blanks around it and a CR are tolerated. */
function isMarkerLine(line: string): boolean {
  const t = line.trim()
  return START_MARKERS.includes(t) || END_MARKERS.includes(t)
}

/**
 * The baseline as it is stored, compared and written: trimmed, with no marker
 * lines in it.
 *
 * The baseline is by definition what goes *between* the markers, so a marker line
 * has no meaning inside it — yet pasting a whole agent file into the editor puts
 * them there. Every marker line goes, not only a leading START and a trailing END:
 * a marker anywhere in the block would nest on apply, and since extraction stops at
 * the first END it meets, the block would then be unreadable from the UI. Only
 * whole lines count, so nothing the user wrote is dropped — a marker quoted
 * mid-sentence is their text and stays.
 */
export function normalizeBaseline(text: string): string {
  return text.split('\n').filter((line) => !isMarkerLine(line)).join('\n').trim()
}
