# Settings (`Settings.tsx`)

> Extends `MASTER.md`. Rules here win for this view.

**Pattern:** single `.ns-card` managing indexed agent sources (config homes). Small
surface — resist growth; new setting groups get a new `.ns-label` section in the same
card before they ever get tabs.

## Rules

- Header: `.ns-head` h2 + ghost Close. The heading takes focus on mount
  (`tabIndex={-1}` + `.focus()`) so screen readers land in context after navigation —
  keep this pattern for any new full-view card.
- Source list: `.source-row` = provider logo · body (bold label, accent mono identity
  when known, dimmed mono path with `title` for the full value) · ghost-danger Remove.
  Empty state reuses `.tree-empty` ("no sources configured").
- Identity is looked up live from the accounts snapshot (`identityOf`) — sources show
  *who* they authenticate as, not just where they live. Preserve when redesigning rows.
- Add form: provider select → path input → optional label input → primary Add
  (disabled until path is non-empty). Errors inline via `.new-error`; the API error
  message is shown verbatim — main-process errors are already human-readable.
- Copy style: hints reference real env/config names in `<code>`
  (e.g. `CLAUDE_CONFIG_DIR`) — concrete, not generic.
