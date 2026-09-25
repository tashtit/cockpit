import type { RepoGroup } from '../../shared/types'

/**
 * The project a suggested follow-up starts in: the one its `cwd` names (another project
 * the agent pointed at), else the session's own repo, else the no-repo bucket — never
 * the session's repo for a follow-up that named somewhere else. Null when there is none.
 */
export function followUpRepo(
  repos: readonly RepoGroup[],
  followUp: { readonly cwd?: string },
  session: { readonly repoRoot: string | null } | null
): RepoGroup | null {
  const inside = (dir: string, root: string | null): boolean =>
    root !== null && (dir === root || dir.startsWith(`${root}/`))
  const named = followUp.cwd ? repos.find((r) => inside(followUp.cwd!, r.root)) : undefined
  const own = !followUp.cwd && session?.repoRoot ? repos.find((r) => r.root === session.repoRoot) : undefined
  return named ?? own ?? repos.find((r) => r.key === 'general') ?? null
}
