import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * The renderer's last resort.
 *
 * Every other layer of this app is failure-tolerant on purpose — parsers skip a log
 * they can't read, `execText` never rejects, liveness reads an unfamiliar record as
 * idle — because the data comes from three other vendors' files and drifts between
 * their releases. React is the one layer with no such rule: a throw anywhere in the
 * tree unmounts the whole tree, and an Electron window has no reload button to offer
 * afterwards. What the user gets is a black rectangle.
 *
 * So the app keeps its window. The turns that are running are main's, not the
 * renderer's, and they carry on through this — reloading rejoins them.
 *
 * It also comes smaller: with a `fallback`, a boundary keeps one part of the window
 * — a single message — to itself, and draws the fallback in that part's place
 * instead of taking every other view down with it. `resetKey` changing is a new
 * chance: the next render tries the children again.
 *
 * The one allowed class component: `getDerivedStateFromError` has no hook form.
 */

type Props = {
  readonly children: ReactNode
  /** Drawn in the children's place after a throw; without one the whole window is replaced */
  readonly fallback?: ReactNode
  /** Changing it clears a caught error, so new content gets a fresh try */
  readonly resetKey?: unknown
}
type State = { readonly error: Error | null }

/** Message plus stack, the shape a bug report wants. */
function details(error: Error): string {
  return error.stack?.includes(error.message)
    ? error.stack
    : `${error.message}\n${error.stack ?? ''}`.trim()
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // the console is the only place this can go: a renderer that just lost its tree
    // is in no position to render a report, and main has no channel for one
    console.error('[renderer] crashed:', error, info.componentStack)
  }

  override componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.fallback !== undefined) return this.props.fallback
    return (
      <main className="ns-card" role="alert">
        <div className="ns-head">
          <h2>Something broke</h2>
        </div>
        <p className="ns-repo">
          Cockpit’s window hit an error it couldn’t draw around. Sessions already
          running are unaffected — they belong to the app, not to this window.
        </p>
        <div className="new-error">{error.message}</div>
        <pre className="md-plain">{details(error)}</pre>
        <div className="ns-actions">
          <button className="btn-ghost" onClick={() => void navigator.clipboard.writeText(details(error))}>
            Copy details
          </button>
          <button className="btn-primary" onClick={() => location.reload()}>
            Reload the window
          </button>
        </div>
      </main>
    )
  }
}
