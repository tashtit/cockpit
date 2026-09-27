import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionMessage } from '../../shared/types'
import { buildWork, type WorkModel, type WorkTab } from '../../shared/work'
import type { WorkFocus } from './work-tab'

/** The rows that carry a plan, to-dos, an edit or a check — all the Work panel folds — with their keys. */
type ArtifactRows = { readonly rows: readonly SessionMessage[]; readonly keys: readonly number[] }

const NO_ARTIFACTS: ArtifactRows = { rows: [], keys: [] }

/** The same rows under the same keys — nothing the Work panel folds has moved. */
function sameArtifacts(a: ArtifactRows, b: ArtifactRows): boolean {
  return a.rows.length === b.rows.length && a.rows.every((m, i) => m === b.rows[i] && a.keys[i] === b.keys[i])
}

function artifactRows(log: readonly SessionMessage[], keys: readonly number[]): ArtifactRows {
  const rows: SessionMessage[] = []
  const rowKeys: number[] = []
  log.forEach((m, i) => {
    if (m.kind !== 'tool_call' || !m.artifact) return
    rows.push(m)
    rowKeys.push(keys[i] ?? i)
  })
  return { rows, keys: rowKeys }
}

/** A transcript row's key → its place among the rows the Work panel was folded over. */
function workIndex(artifacts: ArtifactRows, key: number): number | null {
  const i = artifacts.keys.indexOf(key)
  return i < 0 ? null : i
}

/** Where the Work key opens: a plan waiting on you, else the list under way, else a check
 *  that failed, else what it sent you, else the edits. */
function defaultTab(model: WorkModel, pendingPlanKey: number | null): WorkTab {
  if (pendingPlanKey !== null) return 'plan'
  if (model.todos.some((t) => t.status !== 'completed')) return 'todos'
  if (model.checks.some((c) => c.last?.status === 'failed')) return 'checks'
  if (model.shared.files.length > 0 || model.shared.links.length > 0) return 'files'
  if (model.files.length > 0) return 'edits'
  if (model.plans.length > 0) return 'plan'
  if (model.checks.length > 0) return 'checks'
  if (model.followUps.length > 0) return 'follow-ups'
  return 'todos'
}

type WorkPanelState = {
  /** Which tab the panel is on, and the row that opened it (a transcript key); null = closed */
  readonly work: WorkFocus | null
  /** The transcript holds something to put in the panel — the header offers its key */
  readonly workable: boolean
  /** What the panel draws — built only while it is open */
  readonly model: WorkModel | null
  /** `work` with its row named by its place among the panel's rows, as the panel reads it */
  readonly workFocus: WorkFocus | null
  /** The plan waiting on an answer, by its place among the panel's rows */
  readonly pendingPlanAt: number | null
  /** Open the panel at a row (or none) on a tab, remembering what had focus */
  readonly openWork: (key: number | null, tab: WorkTab) => void
  /** Close it and hand focus back to what opened it */
  readonly closeWork: () => void
  /** Close it where focus stays put — another panel is taking its place */
  readonly hideWork: () => void
  /** Switch tabs from inside the panel */
  readonly workTab: (tab: WorkTab) => void
  /** The header key and ⌘J: open on the tab that matters most right now, or close */
  readonly toggleWork: () => void
}

/**
 * The Work panel beside the transcript: which tab, the row that opened it, and ⌘J.
 *
 * It is offered once the transcript holds something to put in it — a plan, a to-do
 * list, an edit — and built only while it is open, from the rows that carry one. A
 * stream flush rewrites the text row, never one of these, so the rows come back as the
 * same object until one carrying work arrives, changes or leaves, and the model is
 * folded again then rather than on every flush. It names the rows by their place among
 * themselves; the transcript's row keys are translated at the panel's edge (`workFocus`,
 * `pendingPlanAt`).
 */
export function useWorkPanel({
  log,
  keys,
  cwd,
  pendingPlanKey,
  onOpen
}: {
  readonly log: readonly SessionMessage[]
  readonly keys: readonly number[]
  /** The session's directory; undefined while no session is open */
  readonly cwd: string | undefined
  /** The transcript key of a plan waiting on an answer, if any */
  readonly pendingPlanKey: number | null
  /** The panel is opening — anything else beside the conversation steps aside */
  readonly onOpen?: () => void
}): WorkPanelState {
  /** The Work panel beside the transcript: which tab, and the row that opened it */
  const [work, setWork] = useState<WorkFocus | null>(null)
  /** What had focus when the panel opened — closing hands it back */
  const workOpener = useRef<HTMLElement | null>(null)

  // the panel is a way of looking at one session — a different one opens without it
  useEffect(() => {
    setWork(null)
  }, [cwd])

  const artifactsRef = useRef<ArtifactRows>(NO_ARTIFACTS)
  const artifacts = useMemo(() => {
    const next = artifactRows(log, keys)
    if (sameArtifacts(artifactsRef.current, next)) return artifactsRef.current
    artifactsRef.current = next
    return next
  }, [log, keys])
  const workable = artifacts.rows.length > 0
  const model = useMemo(
    () => (work && cwd !== undefined ? buildWork(artifacts.rows, cwd) : null),
    [work !== null, artifacts, cwd]
  )
  const workFocus = useMemo(
    () => (work ? { ...work, key: work.key === null ? null : workIndex(artifacts, work.key) } : null),
    [work, artifacts]
  )
  const pendingPlanAt = pendingPlanKey === null ? null : workIndex(artifacts, pendingPlanKey)
  const onOpenRef = useRef(onOpen)
  onOpenRef.current = onOpen
  const openWork = useCallback((key: number | null, tab: WorkTab) => {
    const active = document.activeElement
    // by id: the side chat is a .work-panel too, and focus in it is somewhere to come back from
    if (active instanceof HTMLElement && !active.closest('#work-panel')) workOpener.current = active
    onOpenRef.current?.()
    setWork({ tab, key, at: Date.now() })
  }, [])
  const closeWork = useCallback(() => {
    setWork(null)
    // focus goes back where it came from — unless that row has since left the DOM
    const back = workOpener.current
    workOpener.current = null
    if (back?.isConnected) back.focus()
  }, [])
  const hideWork = useCallback(() => setWork(null), [])
  const workTab = useCallback((tab: WorkTab) => setWork((w) => (w ? { ...w, tab, key: null } : w)), [])

  const toggleWork = (): void => {
    if (work) closeWork()
    else if (cwd !== undefined) openWork(null, defaultTab(buildWork(artifacts.rows, cwd), pendingPlanKey))
  }
  const toggleWorkRef = useRef(toggleWork)
  toggleWorkRef.current = toggleWork
  useEffect(() => {
    if (!workable && !work) return
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'j' || document.querySelector('[role="dialog"]')) return
      e.preventDefault()
      toggleWorkRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [workable, work !== null])

  return { work, workable, model, workFocus, pendingPlanAt, openWork, closeWork, hideWork, workTab, toggleWork }
}
