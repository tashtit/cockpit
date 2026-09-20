import { sep } from 'node:path'

/**
 * Path containment, defined once.
 *
 * "Is this path inside that directory?" is the question every destructive and every
 * spawn-shaped operation in main asks before it acts: the indexer asks it of a
 * watcher event, `assertKnownCwd` asks it before a CLI is spawned, cleanup asks it
 * before an unlink, the diff and share paths ask it before they read or write. It
 * was written eight times in four spellings — some with `sep`, some with a literal
 * `/`, some including the directory itself and some not — which is one drift away
 * from a check that passes where its twin refuses.
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
