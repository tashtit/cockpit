# Chat — Session View (`ChatView.tsx`)

> Extends `MASTER.md`. Rules here win for this view.

**Pattern:** transcript reader for agent sessions. Optimized for scanning long agent
output: assistant prose is the wide column, tool noise collapses to one-liners, user
turns are compact right-aligned bubbles.

## Header (`.chat-header`)

Identity + situation in one row, left to right:
solid agent `.badge` · `.acct-chip` ("running as" — shows the identity's local part,
full identity in the tooltip; shed entirely ≤780px) · title + sub (branch chip, clickable
cwd that copies its path, "· not started" when no native session yet) · PR affordance ·
permission mode select. Header min-height is 52px — it's the drag region, keep it a real
grab target.

- The PR slot is exclusive: a `PrBadge` when the branch has a PR, else green `.btn-pr`
  "Create PR" (GitHub merge-button semantics), else nothing. Never both.
- Header is a window drag region; every interactive child opts out (`no-drag`), and the
  cwd/branch subtitle is selectable text.
- Mode select persists to `cockpit:mode`; hints live in `title`, labels stay one word.

## Transcript (`.messages`)

- Row vocabulary — do not invent new message shapes:
  - user → `.bubble-user` right-aligned, accent tint, `max-width: min(74%, 60ch)`
  - assistant → avatar + `.markdown` body, `max-width: min(85%, 76ch)`; `.streaming`
    shows the accent left border; `.reasoning` dims + italicizes
  - tool call/result → `.tool-row` collapsed `<details>`: gear/return-arrow chip + mono
    120-char preview — the humanized headline (`SessionMessage.preview`: Bash command,
    Edit/Read/Write path, from `toolPreview()` in main) when available, else the raw
    input; expands to `.tool-full` (260px max, scrolls) which always keeps the raw input
  - system → `.sys-row` dotted-left-border annotation, aligned with the assistant column
- Tool/system glyphs are text-presentation unicode (`⚙︎` with U+FE0E, `↳`) — if these
  ever grow, switch to SVGs from `logos.tsx`; never bare emoji-presentation glyphs.
- **DOM bound:** only the last `RENDER_LAST` (400) messages render, with an explicit
  `(showing the last N of M messages)` sys-row. Keep both when touching this.
- Consecutive duplicate system notices are filtered — providers repeat them.
- `Message` is memoized; keys are absolute log offsets (`log.length - visible.length + i`),
  stable because the log is append-only. Don't "fix" this to item ids or bare indexes.
- Auto-scroll pins to bottom on new messages/busy; busy shows `.pulse` +
  "<Agent> is working…" — the `.thinking` line renders in the placard register
  (mono uppercase annunciator; the transform is CSS, the DOM text stays sentence
  case for screen readers).
- Assistant avatars carry a quiet livery ring (`.avatar.plogo-*` border tint) — the
  authoring agent reads at a glance without leaving the rest-intensity tint range.
- `.messages > * { flex-shrink: 0 }` is load-bearing: without it, flex children shrink
  toward min-content before the container scrolls, and tool-rows (`overflow: hidden`)
  compress to unreadable slivers in long transcripts. Any new scrollable column flex
  container needs the same guard.
- Code blocks get a hover/focus Copy button; highlight.js tokens map to app palette
  variables — no imported highlight theme.

## Composer

- Textarea: Enter sends, Shift+Enter newlines (stated in the placeholder),
  `field-sizing: content` between 2.4lh and 12lh. Focus lands here whenever a session
  opens or starts.
- The action button swaps in place: `.btn-primary` Send ↔ `.btn-danger` Stop while busy —
  same slot, no layout shift.
- Pasting an image attaches it: a full-width `.composer-attach` chip row appears above
  the textarea, one `.attach-chip` (24px thumbnail + name + × remove) per image, save
  failures as an inline `.attach-error`. Chips clear on send and on session switch; a
  message may be images-only. Attached paths ride `ChatRequest.images` and reach the
  agent as file references appended to the prompt. The mechanics live in
  `attachments.tsx` (`useImageAttachments` + `AttachRow`) and are shared with the home
  quick composer and the New-session form — never reimplement them per view.

## Accessibility

- One `sr-only` `role="status" aria-live="polite"` region announces turn completion or
  failure — never per streamed token. Keep announcements at that granularity.
- Avatar SVGs are `aria-hidden`; the textarea carries `aria-label="Message <Agent>"`.
