/**
 * The managed-block markers, shared by the main process (which writes them) and the
 * renderer (which draws them as rails in the pre-apply review). One definition, so
 * the review can never show a marker the writer doesn't use.
 */
export const START = '<!-- cockpit:shared:start -->'
export const END = '<!-- cockpit:shared:end -->'
