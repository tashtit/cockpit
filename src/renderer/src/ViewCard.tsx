import { useEffect, useRef, type JSX, type ReactNode } from 'react'

/**
 * The card a secondary view opens as — Settings, Agents, Profile, Cleanup: the heading
 * takes focus on open, so the keyboard and a screen reader land where the view begins,
 * and Close goes back. The card scrolls as a whole (`.settings-view`, which `Tabs.tsx`
 * resets on a tab switch).
 */
export function ViewCard({
  title,
  onClose,
  children
}: {
  readonly title: string
  readonly onClose: () => void
  readonly children: ReactNode
}): JSX.Element {
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  return (
    <main className="chat settings-view">
      <div className="ns-card">
        <div className="ns-head">
          <h2 ref={headingRef} tabIndex={-1}>
            {title}
          </h2>
          <button className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </div>
    </main>
  )
}
