import type { JSX } from 'react'

/**
 * A repository as the sidebar names it: `owner/` dimmed (`.repo-owner`) before the name
 * when it is on GitHub, else its directory's name. The palette and the profile's top
 * repositories say it the same way.
 */
export function RepoName({
  repo
}: {
  readonly repo: { readonly fullName: string | null; readonly name: string }
}): JSX.Element {
  if (!repo.fullName?.includes('/')) return <>{repo.name}</>
  const [owner, name] = repo.fullName.split('/')
  return (
    <>
      <span className="repo-owner">{owner}/</span>
      {name}
    </>
  )
}
