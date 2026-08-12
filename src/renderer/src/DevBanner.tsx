import type { JSX } from 'react'
import { BranchIcon } from './logos'

/**
 * Dev-only: full-width banner naming the branch/worktree this instance runs
 * from — parallel `npm run dev` windows look identical otherwise. Main tags
 * the dev-server URL with `?devBranch=`; a packaged app never carries the
 * param, so this renders nothing outside dev.
 */
export function DevBanner(): JSX.Element | null {
  const branch = new URLSearchParams(window.location.search).get('devBranch')
  if (!branch) return null
  return (
    <div className="dev-banner">
      <span className="dev-banner-text" title={`dev build running from branch ${branch}`}>
        <BranchIcon size={10} />
        <span className="chip-text">{branch}</span>
      </span>
    </div>
  )
}
