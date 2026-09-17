// @semantic-release/commit-analyzer ships no types; this is the one call next-version.mts makes
declare module '@semantic-release/commit-analyzer' {
  export function analyzeCommits(
    pluginConfig: Record<string, unknown>,
    context: {
      readonly commits: readonly { readonly hash: string; readonly message: string }[]
      readonly logger: Record<'log' | 'error' | 'warn' | 'success', (...args: unknown[]) => void>
      readonly cwd: string
    }
  ): Promise<'major' | 'minor' | 'patch' | null>
}
