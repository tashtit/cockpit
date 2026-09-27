/**
 * `work` over `items`, at most `limit` at a time, results in the input's order.
 * Main fans out over many files, worktrees or registries at once — git and du per
 * worktree in cleanup, a stat per session in the model picker, a registry request per
 * MCP server: all of them at once starve the machine the agents are working on, one at
 * a time is slow. Rejections are the caller's; every caller hands this units that
 * resolve, failure included.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  work: (item: T) => Promise<R>,
  limit: number
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await work(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}
