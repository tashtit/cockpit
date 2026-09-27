import { memo, useEffect, useLayoutEffect, useRef, type JSX } from 'react'
import type { SessionProvider } from '../../shared/types'
import { needsLook, type WorkModel, type WorkTab } from '../../shared/work'
import { XIcon } from './logos'
import { SidePanel } from './SidePanel'
import { TabList, type TabDef } from './Tabs'
import { WorkChecksTab } from './WorkChecksTab'
import { WorkEditsTab } from './WorkEditsTab'
import { WorkFilesTab } from './WorkFilesTab'
import { WorkFollowUpsTab } from './WorkFollowUpsTab'
import { WorkPlanTab } from './WorkPlanTab'
import { WorkTodosTab } from './WorkTodosTab'
import type { WorkFocus } from './work-tab'

/**
 * The Work panel: what the agent handed you to look at, beside the conversation —
 * the plan it proposed, where its to-do list stands, every edit it made, file by
 * file, how the checks it ran ended, the files and pages it shared with you, and the
 * work it suggested for sessions of their own. Built from the agents' own tool calls (`work.ts`), so it is what the agent
 * *said*: the edits are each call's own description of its change, and **Changes**
 * (the worktree's diff, ⌘D) stays the word on what is actually on disk.
 *
 * Opened from the header's Work key or from any row that carries one of these; a row
 * opens the panel at itself — its plan version, or its file with the edit ringed.
 */

/**
 * Memoized, as its blocks are: the chat renders on every stream flush and keystroke, and
 * the model it is handed is folded again only when a row carrying work changed.
 */
export const WorkPanel = memo(function WorkPanel({
  model,
  focus,
  onTab,
  onClose,
  cwd,
  provider,
  pendingPlanKey,
  onOpenChanges,
  sessionId,
  onOpenUrl,
  onStartFollowUp
}: {
  model: WorkModel
  focus: WorkFocus
  onTab: (tab: WorkTab) => void
  onClose: () => void
  cwd: string
  provider: SessionProvider
  /** The plan row still waiting for the person's approval, if one is */
  pendingPlanKey: number | null
  /** Swap the transcript for the worktree's diff — absent where there is none */
  onOpenChanges?: () => void
  /** The indexed session, which main reads a shared file for; null before it has an id */
  sessionId: string | null
  onOpenUrl: (url: string) => void
  /** Fill in the new-session form with a suggestion; absent where sessions can't start */
  onStartFollowUp?: (followUp: { readonly title: string; readonly prompt: string; readonly cwd?: string }) => void
}): JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)

  // opening moves the reader in: the selected tab takes focus, so the keyboard is
  // where the eyes went (and Escape is one key away)
  useEffect(() => {
    tabsRef.current?.querySelector<HTMLButtonElement>('[role=tab][aria-selected=true]')?.focus()
  }, [focus.at])

  // a tab is a fresh page: never entered half-scrolled because the one before was long
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0
  }, [focus.tab])

  const openTodos = model.todos.filter((t) => t.status !== 'completed').length
  const tabs: readonly TabDef<WorkTab>[] = [
    { id: 'plan', label: 'Plan', dot: pendingPlanKey !== null },
    { id: 'todos', label: 'To-dos', count: openTodos },
    { id: 'edits', label: 'Edits', count: model.files.length },
    // the checks that want a look: failed, or out of date since an edit
    { id: 'checks', label: 'Checks', count: model.checks.filter(needsLook).length },
    { id: 'files', label: 'Files', count: model.shared.files.length + model.shared.links.length },
    { id: 'follow-ups', label: 'Follow-ups', count: model.followUps.filter((f) => !f.dismissed).length }
  ]

  return (
    <SidePanel id="work-panel" label="Work" onClose={onClose}>
      <div className="work-head" ref={tabsRef}>
        <TabList id="work" label="Work" tabs={tabs} selected={focus.tab} onSelect={onTab} />
        <button className="icon-btn small work-close" aria-label="Close the Work panel" title="Close (Esc)" onClick={onClose}>
          <XIcon />
        </button>
      </div>
      <div
        className="work-body"
        ref={bodyRef}
        role="tabpanel"
        id={`work-panel-${focus.tab}`}
        aria-labelledby={`work-tab-${focus.tab}`}
        // the panel scrolls on its own: a keyboard reader must be able to reach it
        tabIndex={0}
      >
        {focus.tab === 'plan' ? (
          <WorkPlanTab model={model} focus={focus} pendingPlanKey={pendingPlanKey} provider={provider} />
        ) : focus.tab === 'todos' ? (
          <WorkTodosTab model={model} provider={provider} />
        ) : focus.tab === 'checks' ? (
          <WorkChecksTab model={model} focus={focus} provider={provider} scroller={bodyRef} />
        ) : focus.tab === 'follow-ups' ? (
          <WorkFollowUpsTab
            model={model}
            focus={focus}
            provider={provider}
            sessionId={sessionId}
            scroller={bodyRef}
            onStart={onStartFollowUp}
          />
        ) : focus.tab === 'files' ? (
          <WorkFilesTab
            model={model}
            focus={focus}
            cwd={cwd}
            provider={provider}
            sessionId={sessionId}
            onOpenUrl={onOpenUrl}
          />
        ) : (
          <WorkEditsTab model={model} focus={focus} cwd={cwd} scroller={bodyRef} onOpenChanges={onOpenChanges} />
        )}
      </div>
    </SidePanel>
  )
})
