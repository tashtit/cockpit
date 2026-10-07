import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import type { Provider } from '../shared/types'

/**
 * Path questions main asks everywhere, each answered once: containment, where a
 * symlinked path really leads, how the disk spells a path, and where each agent keeps
 * its config by default.
 *
 * Containment matters most. "Is this path inside that directory?" is the question
 * every destructive and every spawn-shaped operation in main asks before it acts:
 * the indexer asks it of a watcher event, `assertKnownCwd` asks it before a CLI is
 * spawned, cleanup asks it before an unlink, the diff and share paths ask it before
 * they read or write. It was written eight times in four spellings — some with
 * `sep`, some with a literal `/`, some including the directory itself and some
 * not — which is one drift away from a check that passes where its twin refuses.
 *
 * `tests/path-containment.test.ts` fails on a hand-rolled copy, the way
 * `shared-purity` and `style-reachability` hold their own rules.
 */

/**
 * True when `child` is `parent` itself or sits inside it. Both must already be
 * absolute and resolved — this compares strings and follows nothing, so a caller
 * that needs symlinks resolved calls `realpathSync` first (cleanup does).
 */
export function isUnder(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/**
 * Where `path` really leads once every symlink on the way is followed; the path itself
 * when it can't be resolved (it doesn't exist yet, or a link in it is dangling).
 */
export function realOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * `path` (absolute, resolved) as the disk spells it: symlinks followed and, on a volume
 * that ignores case (macOS's default), each existing part in the case it was made in —
 * `realpathSync.native`, the one that corrects case; `realOrSelf` echoes whatever
 * spelling it was handed. A tail that doesn't exist (yet, or any more) keeps its spelling
 * under its nearest ancestor that does, so a deleted worktree is still placed by the
 * folder it was in. Compare paths from different writers through this: Electron names
 * userData after the product (`Cockpit`), a dev run after the package (`cockpit`), and an
 * agent records the cwd its process reports — one folder, three spellings.
 */
export function spelledOnDisk(path: string): string {
  for (let existing = path; ; existing = dirname(existing)) {
    try {
      const real = realpathSync.native(existing)
      return existing === path ? real : join(real, relative(existing, path))
    } catch {
      if (dirname(existing) === existing) return path
    }
  }
}

/**
 * A provider's own config home when nothing points it elsewhere: `~/.claude`,
 * `~/.codex`, `~/.copilot`. `home` is read per call, so a test can point HOME elsewhere.
 */
export function defaultConfigHome(provider: Provider, home = homedir()): string {
  return join(home, `.${provider}`)
}
