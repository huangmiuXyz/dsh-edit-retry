// Edit-and-retry — CLIENT half.
//
// Right-clicking an ordinary user message opens a context menu: "Retry" resends the
// text untouched, "Edit and retry" swaps the bubble for an inline editor first, and a
// separated toggle below them arms "delete the source session once the retry is in
// flight".
//
// Either entry produces a retry session carrying that text as its prompt — the edit
// is optional, the retry is not. The delete is opt-in and permanent, so it runs only
// after the retry has actually been handed to the host: a retry that failed leaves
// the source untouched. The delete itself cannot happen here; it is the host half's
// job (see src/index.js), reached over the route the constants below name.
//
// The context menu is the ONLY way in — there is no edit button and no
// double-click. A button would have to live in the shipped action row (copy +
// time), which is rendered inside the shipped component and cannot be extended
// from outside, so it would end up as a second row fighting the shipped layout.
// Double-click was tried and removed: it collides with the browser's
// select-a-word gesture. Interactive descendants keep their own context menu, and
// an attachment message cannot be resent as text, so both are excluded.
//
// Why fork instead of rewriting the log in place:
//   The durable log is append-only (seq = log.length) and the transcript only
//   renders append-origin surface events. An in-place surface replace would
//   therefore change what the MODEL sees while the SCREEN kept the old text —
//   a silent divergence. Forking is exactly the path the shipped "branch"
//   button uses, so behaviour and permissions match the product.
//
// Which model the retry runs on:
//   A fork inherits only the source's EVENT PREFIX up to the retry point, and a
//   Host resolves a session's model from that session's own log (a pending
//   `model/selection`, else the route of its last `request/header`, else the
//   deployment default). So a child forked at an older message used to run on
//   the model of THAT TURN, silently ignoring a switch the user made later —
//   the usual case, since one switches models and then retries something above.
//   The retry therefore reads the source's current selection (exactly what the
//   composer shows) and pins it on the child before its first prompt.
//
// How the bubble is wrapped without copying it:
//   The shipped `conversation.chat.node` entry for key "user" sits at the default
//   priority 0. This profile-installed Client half registers the SAME key at
//   priority -1: the renderer elects the first non-abdicated entry of each cell
//   in priority order, so the lower number shadows the shipped one. The shim then
//   renders the SHIPPED component through `ctx.slots.entries()`, so bubble
//   styling, image rendering, copy and timestamps stay owned by the product.
//
//   Do not omit the priority. The automatic shadowing-rank allocation in the
//   Client runtime applies to DYNAMIC packages only; a bundle loaded through the
//   profile's module table keeps the priority it passes, so registering at the
//   default 0 collides with the shipped entry.
//
// Bundle format (client-modules protocol): a classic script registering a
// factory via `window.__ModuleLoader__.load({ id, factory })`. The factory
// receives `require` and returns the plugin exports. React is the only import;
// everything else is inline (no JSX, no Harness Client packages). Only `--dsw-*`
// theme tokens are styled against.
window.__ModuleLoader__.load({
  id: 'dsh-edit-retry',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    const SLOT = 'conversation.chat.node'
    const KEY = 'user'
    /** Label carried by the temporary reference this plugin holds while sending. */
    const SOURCE = 'editRetry'
    const CSS_ID = 'dsh-edit-retry/EditRetry.css'
    /** Interactive descendants keep their own context menu; never steal it. */
    const INTERACTIVE = 'a, button, [role="button"], input, textarea, select'
    /** Menu extents used to keep the popup inside the viewport. Three rows + rule. */
    const MENU_WIDTH = 168
    const MENU_HEIGHT = 108
    /**
     * The host half's delete route and the header it insists on. These MUST match
     * `src/index.js` — client and host are separate module graphs with no shared
     * import, so the self-check asserts the two spellings agree.
     */
    const DELETE_ROUTE = '/dsh-edit-retry/session/delete'
    const DELETE_HEADER = 'x-dsh-edit-retry'
    /** Where the "delete the source session" choice is remembered. */
    const PREF_KEY = 'dsh-edit-retry:delete-source'

    // --- copy -------------------------------------------------------------------
    // Read through the `locale` service on every render, so the two dictionaries
    // follow the Harness language without taking on a namespace registration.
    const ZH = {
      retry: '重试',
      action: '编辑并重试',
      deleteSource: '重试后删除原会话',
      title: '编辑这条消息并重试',
      hint: '保存后从这里新建会话并立即发送',
      submit: '保存并重试',
      cancel: '取消',
      sending: '正在重试…',
      deleting: '正在删除原会话…',
      failed: '重试失败：',
      deleteFailed: '删除原会话失败：'
    }
    const EN = {
      retry: 'Retry',
      action: 'Edit and retry',
      deleteSource: 'Delete the original session',
      title: 'Edit this message and retry',
      hint: 'Saving forks a new session from here and sends immediately',
      submit: 'Save and retry',
      cancel: 'Cancel',
      sending: 'Retrying…',
      deleting: 'Deleting the original session…',
      failed: 'Retry failed: ',
      deleteFailed: 'Could not delete the original session: '
    }

    function copyFor(ctx) {
      let language
      try {
        language = ctx.get('locale')?.getSnapshot?.()?.active
      } catch {
        language = undefined
      }
      if (typeof language !== 'string' || language.length === 0) {
        language = typeof navigator !== 'undefined' ? navigator.language : undefined
      }
      return String(language ?? 'en').toLowerCase().startsWith('zh') ? ZH : EN
    }

    // --- the delete-the-source preference ----------------------------------------
    // Deletion is permanent, so it is opt-in and remembered: a user who turns it on
    // once should not have to re-arm it on every message. Storage access is wrapped
    // because a locked-down browser profile can throw on localStorage itself.
    function readDeletePref() {
      try {
        return window.localStorage.getItem(PREF_KEY) === '1'
      } catch {
        return false
      }
    }

    function writeDeletePref(on) {
      try {
        window.localStorage.setItem(PREF_KEY, on ? '1' : '0')
      } catch {
        /* the choice still applies to this render tree */
      }
    }

    // --- deleting the source session ---------------------------------------------
    /**
     * Ask the host half to delete the session the retry came from.
     *
     * The header is not decoration: it is what forces a CORS preflight, which the
     * host answers by refusing, so a random page cannot reach this route. Same
     * origin, so no credentials handling is needed.
     * @returns the host's report.
     */
    async function deleteSourceSession(sessionId) {
      const response = await fetch(DELETE_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [DELETE_HEADER]: '1' },
        body: JSON.stringify({ sessionId })
      })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok || payload?.ok !== true) {
        throw new Error(payload?.error ?? `HTTP ${response.status}`)
      }
      return payload
    }

    // --- styles -----------------------------------------------------------------
    // The host is a plain block wrapper: it exists only to carry the context-menu
    // handler, because the shipped renderer destructures its props and never
    // forwards unknown ones to the DOM. A block wrapper is layout-neutral around
    // the shipped `userRow` column.
    //
    // The menu itself is fixed-positioned at the pointer. It cannot be portalled
    // (no react-dom) and must not use `@deepseek-ai/dsh-client-ui-primitives`
    // (a dynamic Client half imports no Harness UI package), so it is drawn from
    // plain elements and theme tokens like everything else here. `fixed` also keeps
    // it clear of the transcript's own scroll clipping.
    const CSS = `
.dsh-edit-retry-host { display: block; }
.dsh-edit-retry-menu {
  position: fixed;
  z-index: 1000;
  min-width: 148px;
  padding: 4px;
  border: .5px solid var(--dsw-alias-border-l4);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: 0 8px 24px rgb(0 0 0 / 16%);
}
.dsh-edit-retry-menuitem {
  display: block;
  box-sizing: border-box;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 18px;
  text-align: start;
  white-space: nowrap;
  cursor: pointer;
}
.dsh-edit-retry-menuitem:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-edit-retry-menuitem:focus-visible { outline: 2px solid var(--dsw-alias-button-primary-fill); outline-offset: -2px; }
.dsh-edit-retry-menuitem:disabled { cursor: default; opacity: .45; }
/* The toggle is a separator-delimited third row: it configures the two above it
   rather than being a third action, and the rule is what says so. */
.dsh-edit-retry-separator { margin: 4px 6px; border-top: .5px solid var(--dsw-alias-border-l4); }
.dsh-edit-retry-menutoggle { display: flex; align-items: center; gap: 8px; }
/* A checkbox, drawn rather than implied. An empty slot reads as nothing at all —
   the unchecked state has to be a visible box for the row to look like the control
   it is. Checked fills with the primary colour and takes the on-primary glyph. */
.dsh-edit-retry-check {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 14px;
  height: 14px;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 4px;
  color: var(--dsw-alias-label-primary-foreground);
  font-size: 10px;
  line-height: 1;
  transition: background-color .12s ease, border-color .12s ease;
}
.dsh-edit-retry-check-on {
  border-color: var(--dsw-alias-button-primary-fill);
  background: var(--dsw-alias-button-primary-fill);
}
/* Retry feedback: the menu closes on click, so progress and failure have
   to surface under the bubble the way the editor's own row does. */
.dsh-edit-retry-status { padding: 4px 2px 0; }
.dsh-edit-retry-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
  box-sizing: border-box;
  width: 100%;
  padding: 10px 12px;
  border: .5px solid var(--dsw-alias-border-l4);
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-1);
}
.dsh-edit-retry-editor:focus-within { border-color: var(--dsw-alias-border-l3); }
.dsh-edit-retry-textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 72px;
  max-height: 40vh;
  padding: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  resize: vertical;
}
.dsh-edit-retry-row { display: flex; align-items: center; gap: 8px; }
.dsh-edit-retry-hint {
  margin-inline-end: auto;
  color: var(--dsw-alias-label-caption);
  font-size: 12px;
  line-height: 16px;
}
.dsh-edit-retry-error { color: var(--dsw-alias-label-error, #d9534f); font-size: 12px; line-height: 16px; }
.dsh-edit-retry-btn {
  height: 28px;
  padding: 0 12px;
  border: .5px solid transparent;
  border-radius: 14px;
  font: inherit;
  font-size: 13px;
  line-height: 18px;
  cursor: pointer;
  transition: background-color .12s ease, color .12s ease, border-color .12s ease, opacity .12s ease;
}
.dsh-edit-retry-btn:disabled { cursor: default; opacity: .5; }
.dsh-edit-retry-btn:focus-visible { outline: 2px solid var(--dsw-alias-button-primary-fill); outline-offset: 2px; }
.dsh-edit-retry-btn-primary {
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
.dsh-edit-retry-btn-ghost {
  border-color: var(--dsw-alias-border-l4);
  background: transparent;
  color: var(--dsw-alias-label-primary);
}
.dsh-edit-retry-btn-ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
`

    // --- message helpers --------------------------------------------------------
    /** Concatenated text of every `text` part, in order. */
    function textOf(content) {
      if (!Array.isArray(content)) return ''
      let out = ''
      for (const part of content) {
        if (part && part.type === 'text' && typeof part.text === 'string') out += part.text
      }
      return out
    }

    /** True when the message is pure text — the only shape this plugin resends. */
    function isTextOnly(content) {
      if (!Array.isArray(content)) return false
      return content.every((part) => part && part.type === 'text')
    }

    // --- the shipped `user` renderer --------------------------------------------
    /**
     * Recover the SHIPPED `user` entry. The raw `entries()` view still holds it
     * even though this plugin's entry wins the cell.
     *
     * The whole entry matters, not just its component: its `locale` namespace is
     * what makes the renderer inject the `t` seat, and the shipped bubble's action
     * row calls `t`. Forwarding props without that seat crashes the shipped node.
     * @returns the shipped entry, or undefined while it has not registered.
     */
    function shippedUserEntry(ctx, self) {
      let raw
      try {
        raw = ctx.slots.entries(SLOT)
      } catch {
        return undefined
      }
      if (!Array.isArray(raw)) return undefined
      for (const entry of raw) {
        if (entry?.options?.key !== KEY) continue
        if (entry.component === self) continue
        return entry
      }
      return undefined
    }

    // --- the retry itself -------------------------------------------------------
    /**
     * The session's loaded event window, oldest first.
     *
     * Conclusive only on a COMPLETE window: with older history still unloaded an
     * earlier prompt may simply be outside it, and both callers below would then
     * answer from a prefix that is not the session's start.
     * @returns the window's events, or undefined when it proves nothing.
     */
    function completeWindow(ctx, sessionId) {
      const window = ctx.get('sessions')?.binding(sessionId)?.eventSource?.getSnapshot()
      if (window === undefined || window.hasMore) return undefined
      return window.entries.filter((entry) => entry?.type === 'event').map((entry) => entry.event)
    }

    /**
     * Whether this message is the session's first human prompt.
     * @returns true when no earlier human prompt exists in the window.
     */
    function isFirstHumanPrompt(events, seq) {
      for (const event of events) {
        if (event.type !== 'user/message' || event.seq >= seq) continue
        if (event.data?.source?.kind === 'user') return false
      }
      return true
    }

    /** The seq of the `turn/start` this message belongs to, or -1 when unknown. */
    function turnStartOf(events, seq) {
      let turnStart = -1
      for (const event of events) {
        if (event.type === 'turn/start' && event.seq <= seq && event.seq > turnStart) turnStart = event.seq
      }
      return turnStart
    }

    /**
     * How many prompts sit UNCLAIMED in the inbox at `boundary`.
     *
     * Net count over the splice events: each splice inserts `inserted` at `start`
     * and removes `removedCount` from it, and the inbox is only ever drained by a
     * later splice. A positive total means the prefix still HOLDS prompts that the
     * source session had not yet consumed.
     */
    function inboxPendingAt(events, boundary) {
      let pending = 0
      for (const event of events) {
        if (event.seq === undefined || event.seq > boundary) continue
        if (event.type !== 'agent/inbox/spliced') continue
        pending += (event.data?.inserted?.length ?? 0) - (event.data?.removedCount ?? 0)
      }
      return pending
    }

    /**
     * The seq to fork at, chosen so the inherited prefix ends on a CLOSED turn.
     *
     * `seq - 1` is the event immediately before the message, and it is always
     * INSIDE the message's own turn: DSH opens the turn and splices the prompt into
     * the inbox before it records the `user/message` the transcript anchors the
     * bubble to. `buildForkSeed` then has a half-open turn on its hands and appends
     * `openTurnClosers` — a synthetic `step/end` + `turn/end {kind:"forked"}` with
     * no user message behind it, which the transcript renders as an empty
     * "用时 N 秒" row in front of the retry.
     *
     * A message that OPENS its turn can do better: the previous turn's `turn/end`
     * is a balanced boundary, so the closers find nothing open and add nothing. It
     * also sits BEFORE the inbox splice that carried this prompt, which is what
     * keeps the child from re-sending the original text — the same hazard that
     * sends the FIRST prompt down the fresh-session path.
     *
     * That boundary only works when the prefix is otherwise DRAINED. A turn the
     * user aborted can leave a prompt spliced into the inbox and never claimed
     * (observed: the prompt sits in the queue, the turn ends `aborted`, and the
     * next turn drains it); forking there inherits it, so the child would re-send
     * text the source never answered. A non-empty inbox therefore disqualifies the
     * boundary.
     *
     * A steering message, injected mid-turn, has no such boundary at all: every
     * event before it belongs to its own turn, so cutting earlier would drop
     * messages the caller can still see. It keeps `seq - 1` and the empty row.
     * @returns the inclusive boundary seq, or `seq - 1` when nothing better holds.
     */
    function forkBoundary(events, seq) {
      const fallback = seq - 1
      if (events === undefined) return fallback
      const turnStart = turnStartOf(events, seq)
      if (turnStart < 0) return fallback
      for (const event of events) {
        if (event.type !== 'user/message' || event.seq >= seq || event.seq <= turnStart) continue
        if (event.data?.source?.kind === 'user') return fallback
      }
      let boundary
      for (const event of events) {
        if (event.type !== 'turn/end' || event.seq >= turnStart) continue
        if (boundary === undefined || event.seq > boundary) boundary = event.seq
      }
      if (boundary === undefined) return fallback
      return inboxPendingAt(events, boundary) > 0 ? fallback : boundary
    }

    /**
     * Produce the retry target, open it, and send `text` there.
     *
     * Two shapes, because the first prompt has no history worth inheriting:
     *
     * - Later prompts FORK at a CLOSED-turn boundary (see {@link forkBoundary}):
     *   either the previous turn's `turn/end`, which is balanced, or `seq - 1`
     *   when that boundary is unusable — a steering message injected mid-turn, or
     *   a prefix whose inbox still holds a prompt the source never claimed. The
     *   prefix then ends after the inbox splice that claimed the inherited prompt,
     *   so the child starts with a drained inbox.
     * - The FIRST prompt instead opens a FRESH session. Forking it cannot win:
     *   cutting inside Turn 1 leaves the Host to balance it with synthetic
     *   `step/end` + `turn/end`, which the transcript renders as an empty
     *   "用时 N 秒" row; cutting in front of Turn 1 inherits the inbox splice that
     *   still HOLDS the original prompt but not the later splice that claimed it,
     *   so the child re-sends the original text before the edited one.
     *
     * Either shape then runs on the model the SOURCE was showing (see
     * {@link sessionSelection}): the prefix a fork inherits carries the route of
     * that older turn, not the one the user has selected now.
     * @returns the retry session id.
     */
    async function retryFrom(ctx, { sessionId, seq, cwd, workspaceId }, text) {
      const sessions = ctx.get('sessions')
      const workspace = ctx.get('uiWorkspace')
      if (sessions === undefined) throw new Error('sessions service unavailable')
      if (workspace === undefined) throw new Error('uiWorkspace service unavailable')

      // Read BEFORE forking: this is the model the source was showing when the user
      // chose to retry, and no prefix of the source's log necessarily contains it.
      const selection = sessionSelection(ctx, sessionId)

      let targetId
      // One window read answers both questions below, and an unprovable window
      // (still paging) answers neither: it can neither call this message the first
      // prompt nor trust a boundary it cannot see the start of.
      const events = completeWindow(ctx, sessionId)
      if (events !== undefined && isFirstHumanPrompt(events, seq)) {
        // Mirror where the SOURCE session lives, so the retry lands in the same
        // sidebar group instead of Ungrouped. `session.create` accepts workspaceId
        // or cwd and never both, and ONLY a workspaceId attaches the session to a
        // workspace — a bare cwd leaves it unaccounted.
        targetId = await sessions.create(workspaceId === undefined ? { cwd } : { workspaceId })
      } else {
        const atSeq = forkBoundary(events, seq)
        targetId = await sessions.fork({
          sessionId,
          // A message at seq 0 has no predecessor; let the Host pick its own
          // latest-completed-turn boundary rather than sending an illegal -1.
          ...(atSeq >= 0 ? { atSeq } : {}),
          increaseTitle: true
        })
      }

      await Promise.resolve(workspace.openSession(targetId))

      await sessions.using(targetId, { source: SOURCE }, async (reference) => {
        await reference.ready
        // Carry the model over BEFORE the prompt: the Host installs a selection for
        // the next request assembly, so a selection that lands after it would apply
        // to the turn after this one. A refusal (route gone, session held by another
        // writer) is reported and swallowed — the retry itself still has to happen.
        try {
          await pinSelection(ctx, targetId, selection)
        } catch (error) {
          console.warn(`[edit-retry] retry runs on the inherited model: ${String(error?.message ?? error)}`)
        }
        await reference.binding.session.prompt([{ type: 'text', text }], 'queue')
      })

      return targetId
    }

    // --- the model the retry runs on ---------------------------------------------
    /**
     * A wire selection, or undefined when it names no provider and model.
     *
     * The `modelSelection` projection's wire view is `{ lastUsed, next }`, and both
     * halves carry the same `{ provider, model, reasoningEffort? }` shape the
     * selection RPC takes. Anything else is a shape this plugin does not know, and
     * guessing at it would be worse than not carrying the model over.
     */
    function normalizeSelection(value) {
      if (value === null || typeof value !== 'object') return undefined
      if (typeof value.provider !== 'string' || value.provider.length === 0) return undefined
      if (typeof value.model !== 'string' || value.model.length === 0) return undefined
      return {
        provider: value.provider,
        model: value.model,
        ...(typeof value.reasoningEffort === 'string' && value.reasoningEffort.length > 0
          ? { reasoningEffort: value.reasoningEffort }
          : {})
      }
    }

    /** Whether two selections name the same route AND the same reasoning effort. */
    function sameSelection(left, right) {
      if (left === undefined || right === undefined) return false
      return (
        left.provider === right.provider &&
        left.model === right.model &&
        left.reasoningEffort === right.reasoningEffort
      )
    }

    /**
     * The model selection a session is currently showing.
     *
     * This is the `modelSelection` projection's `next` — a pending intent if there
     * is one, otherwise the route of the session's last request — which is exactly
     * what the composer's model control renders. Read it through the binding rather
     * than the Host: it is the same durable frame the UI already displays, so the
     * retry cannot disagree with what the user saw when they clicked.
     * @returns `{ provider, model, reasoningEffort? }`, or undefined for a session
     *   that never selected (or whose projections are not loaded).
     */
    function sessionSelection(ctx, sessionId) {
      let value
      try {
        const sessions = ctx.get('sessions')
        value = sessions?.binding?.(sessionId)?.session?.projections?.faceOf?.('modelSelection')?.getSnapshot?.()
      } catch {
        return undefined
      }
      return normalizeSelection(value?.next ?? value?.lastUsed)
    }

    /**
     * Reach the Host's `session/selectModel` — the RPC the shipped composer model
     * control submits through.
     *
     * Probed, not declared: carrying the model over is an ADD-ON to the retry, so a
     * profile that mounts no session Remote namespace must lose only the carry-over,
     * never the menu. (`ctx.remote.session` is the namespace service; `ctx.remote`
     * is the parent, checked as the second spelling of the same thing.)
     */
    function modelRemote(ctx) {
      for (const read of [() => ctx.get('remote.session'), () => ctx.get('remote')?.session]) {
        try {
          const remote = read()
          if (remote !== null && remote !== undefined && typeof remote.selectModel === 'function') return remote
        } catch {
          /* no such service in this profile */
        }
      }
      return undefined
    }

    /**
     * Pin `selection` on a session about to be prompted.
     *
     * `selectModel` installs the choice for the NEXT request assembly, so it has to
     * land before `prompt` — the same ordering the shipped picker relies on. The
     * Host records it as a durable `model/selection` event, which is what makes the
     * child's own transcript and model control agree with the model that ran.
     *
     * Skipped when the session already resolves to the same route: a single-model
     * retry then writes no event at all.
     * @returns true when the Host accepted the selection.
     */
    async function pinSelection(ctx, sessionId, selection) {
      if (selection === undefined) return false
      const remote = modelRemote(ctx)
      if (remote === undefined) return false
      // Compared against the TARGET, so a retry that already inherits the right
      // route stays untouched. An unreadable target compares as different — the
      // Host then validates a selection that is already true, which is harmless.
      if (sameSelection(selection, sessionSelection(ctx, sessionId))) return false
      const result = await remote.selectModel({
        sessionId,
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort })
      })
      // Remote calls answer with an envelope instead of throwing, and the shipped
      // caller treats a non-`ok` answer as a failure.
      if (result === null || result === undefined || result.ok !== true) {
        throw new Error(result?.error?.message ?? result?.error?.code ?? 'the model selection was refused')
      }
      return true
    }

    // --- components -------------------------------------------------------------
    function EditRetryEditor({ t, initial, busy, error, onSubmit, onCancel }) {
      const [value, setValue] = useState(initial)
      const trimmed = value.trim()
      const canSubmit = trimmed.length > 0 && !busy

      const submit = useCallback(() => {
        if (trimmed.length === 0 || busy) return
        onSubmit(trimmed)
      }, [trimmed, busy, onSubmit])

      const onKeyDown = useCallback(
        (event) => {
          if (event.key === 'Escape' && !busy) {
            event.preventDefault()
            onCancel()
            return
          }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            submit()
          }
        },
        [busy, onCancel, submit]
      )

      return h(
        'div',
        { className: 'dsh-edit-retry-editor' },
        h('textarea', {
          className: 'dsh-edit-retry-textarea',
          value,
          autoFocus: true,
          spellCheck: false,
          'aria-label': t.title,
          onChange: (event) => setValue(event.target.value),
          onKeyDown
        }),
        error === undefined || error === null
          ? null
          : h('div', { className: 'dsh-edit-retry-error' }, error),
        h(
          'div',
          { className: 'dsh-edit-retry-row' },
          h('span', { className: 'dsh-edit-retry-hint' }, busy ? t.sending : t.hint),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-edit-retry-btn dsh-edit-retry-btn-ghost',
              disabled: busy,
              onClick: onCancel
            },
            t.cancel
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-edit-retry-btn dsh-edit-retry-btn-primary',
              disabled: !canSubmit,
              onClick: submit
            },
            t.submit
          )
        )
      )
    }

    // --- plugin -----------------------------------------------------------------
    function apply(ctx) {
      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {}
        const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_ID)}]`)
        if (existing !== null) return () => {}
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-edit-retry'
        tag.dataset.pluginCss = CSS_ID
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => tag.remove()
      }, 'edit-retry: stylesheet')

      ctx.slots.inject(SLOT, () => {
        let timer
        let attempts = 0

        ctx.effect(
          () => () => {
            if (timer !== undefined) clearTimeout(timer)
          },
          'edit-retry: registration timer'
        )

        const attempt = () => {
          timer = undefined
          // ui-chat is a declared dsh.client.inject dependency, so its `user`
          // entry normally exists already; retry briefly rather than seating a
          // shim that could not render the shipped bubble.
          const shipped = shippedUserEntry(ctx)
          if (shipped === undefined) {
            if (attempts++ < 40) {
              timer = setTimeout(attempt, 25)
              return
            }
            console.warn('[edit-retry] shipped "user" chat node never registered')
            return
          }
          // The renderer keys the `t` seat off `entry.locale` (renderer:
          // `if (entry.locale !== void 0) kit["t"] = localeSeat(face, entry.locale)`),
          // and the registry is what puts it there, hoisting it OUT of `options`
          // (`...options.locale !== void 0 ? { locale: options.locale } : {}`).
          // `entry.locale` is therefore the whole contract — no fallback.
          const locale = shipped.locale
          if (locale === undefined) {
            console.warn(
              '[edit-retry] shipped "user" node declares no locale namespace; forwarded props will carry no `t` seat'
            )
          }
          seat(ctx, makeShim(shipped, ctx), locale)
        }

        attempt()
      })

      function makeShim(shipped, ctx) {
        return function EditRetryUserNode(props) {
          const [editing, setEditing] = useState(false)
          // undefined while idle, otherwise the phase: 'retry' | 'delete'.
          const [busy, setBusy] = useState(undefined)
          // Carries its own label, so a retry failure and a delete failure read
          // differently instead of both claiming the retry failed.
          const [error, setError] = useState(undefined)
          // Pointer position of the open context menu, or undefined while closed.
          const [menu, setMenu] = useState(undefined)
          // Declared last: the four slots above are the ones the self-check scripts
          // positionally, and this one has a safe default of its own.
          const [deleteSource, setDeleteSource] = useState(readDeletePref)
          const menuRef = useRef(null)
          const t = copyFor(ctx)

          // `ChatNode<'user'>` is the Chat VIEW node: `chatNode(context, kind,
          // anchorSeq, state)` wraps the message record as `data`. The shipped
          // renderer reads it the same way — `const data = node.data`.
          const data = props.node.data
          const content = data.content
          const textOnly = isTextOnly(content)
          // The text as sent, reused verbatim by the retry. Trimmed exactly
          // like the editor's own submit, so both entries send the same prompt.
          const original = textOf(content).trim()
          // Prefer a fresh lookup: a reload can replace the shipped entry.
          const Body = shippedUserEntry(ctx, EditRetryUserNode)?.component ?? shipped.component

          // The Workspace this Session is accounted to, read through the slot's own
          // standard `useWorkspaces` seat. A retry must land in the same sidebar
          // group; absent means the source sits in Ungrouped and so will the retry.
          const workspaceId = props.useWorkspaces(
            (snapshot) => snapshot.items.find((item) => item.sessionIds.includes(props.sessionId))?.workspaceId
          )

          const onSubmit = useCallback(
            (text) => {
              // `busy` doubles as the phase: the retry and the delete that may follow
              // it are one continuous operation, and the status row has to say which
              // half is running. The failure label needs the same distinction, which
              // a closure over `busy` cannot give — state read here is the value from
              // THIS render, so the phase is tracked in a plain local instead.
              let phase = 'retry'
              setBusy('retry')
              setError(undefined)
              retryFrom(
                ctx,
                { sessionId: props.sessionId, seq: data.seq, cwd: props.cwd, workspaceId },
                text
              )
                .then(async () => {
                  setEditing(false)
                  // Only now: the retry is in flight, so the source is genuinely
                  // redundant. A failed retry leaves the source untouched.
                  if (!deleteSource) return
                  phase = 'delete'
                  setBusy('delete')
                  await deleteSourceSession(props.sessionId)
                })
                .catch((failure) => {
                  const message = String(failure?.message ?? failure)
                  setError(`${phase === 'delete' ? t.deleteFailed : t.failed}${message}`)
                })
                .finally(() => setBusy(undefined))
            },
            [props.sessionId, props.cwd, workspaceId, data.seq, deleteSource, t]
          )

          // Retry: the same path with the text untouched, for when the edit was
          // never the point — the message just deserves another run. Guarded on empty
          // text because a retry that sends nothing is not a retry.
          const onRetry = useCallback(() => {
            setMenu(undefined)
            if (original.length === 0 || busy) return
            onSubmit(original)
          }, [original, busy, onSubmit])

          // Opening the menu. Interactive descendants keep their own context menu,
          // so the shipped copy control and any link in the message are left alone;
          // an attachment message has nothing to offer and keeps the native menu.
          const onContextMenu = useCallback(
            (event) => {
              if (!textOnly) return
              if (event.target.closest(INTERACTIVE) !== null) return
              event.preventDefault()
              setMenu({
                left: Math.min(event.clientX, window.innerWidth - MENU_WIDTH),
                top: Math.min(event.clientY, window.innerHeight - MENU_HEIGHT)
              })
            },
            [textOnly]
          )

          // Dismiss on pointer elsewhere, Escape, or any scroll. Capture phase so a
          // click outside closes the menu before its target reacts; the menu's own
          // subtree is exempt so its item still receives the click.
          useEffect(() => {
            if (menu === undefined) return undefined
            const dismiss = (event) => {
              const node = menuRef.current
              if (node !== null && event.target instanceof Node && node.contains(event.target)) return
              setMenu(undefined)
            }
            const onKeyDown = (event) => {
              if (event.key === 'Escape') setMenu(undefined)
            }
            window.addEventListener('pointerdown', dismiss, true)
            window.addEventListener('keydown', onKeyDown)
            window.addEventListener('scroll', dismiss, true)
            return () => {
              window.removeEventListener('pointerdown', dismiss, true)
              window.removeEventListener('keydown', onKeyDown)
              window.removeEventListener('scroll', dismiss, true)
            }
          }, [menu])

          if (editing) {
            return h(
              'div',
              { className: 'dsh-edit-retry-host' },
              h(EditRetryEditor, {
                t,
                initial: textOf(content),
                busy,
                error,
                onSubmit,
                onCancel: () => setEditing(false)
              })
            )
          }

          // Right-click is the only way in: no button competes with the shipped
          // action row, so the host stays a layout-neutral block around the bubble.
          return h(
            'div',
            { className: 'dsh-edit-retry-host', onContextMenu },
            h(Body, props),
            // Choosing retry closes the menu, so its progress and its failure
            // have nowhere else to report. Editing keeps using the editor's own row.
            busy || error !== undefined
              ? h(
                  'div',
                  { className: 'dsh-edit-retry-status' },
                  busy
                    ? h(
                        'span',
                        { className: 'dsh-edit-retry-hint' },
                        busy === 'delete' ? t.deleting : t.sending
                      )
                    : h('span', { className: 'dsh-edit-retry-error' }, error)
                )
              : null,
            menu === undefined
              ? null
              : h(
                  'div',
                  {
                    ref: menuRef,
                    className: 'dsh-edit-retry-menu',
                    role: 'menu',
                    style: { left: `${menu.left}px`, top: `${menu.top}px` }
                  },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-edit-retry-menuitem',
                      role: 'menuitem',
                      disabled: original.length === 0 || busy !== undefined,
                      onClick: onRetry
                    },
                    t.retry
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-edit-retry-menuitem',
                      role: 'menuitem',
                      disabled: busy !== undefined,
                      onClick: () => {
                        setMenu(undefined)
                        setEditing(true)
                      }
                    },
                    t.action
                  ),
                  h('div', { className: 'dsh-edit-retry-separator', role: 'separator' }),
                  // A toggle, not a third action: it arms the two entries above it.
                  // Deleting is permanent, so it is opt-in and stays where it was left.
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-edit-retry-menuitem dsh-edit-retry-menutoggle',
                      role: 'menuitemcheckbox',
                      'aria-checked': deleteSource,
                      disabled: busy !== undefined,
                      onClick: () => {
                        const next = !deleteSource
                        setDeleteSource(next)
                        writeDeletePref(next)
                      }
                    },
                    h(
                      'span',
                      {
                        className: deleteSource
                          ? 'dsh-edit-retry-check dsh-edit-retry-check-on'
                          : 'dsh-edit-retry-check',
                        'aria-hidden': 'true'
                      },
                      deleteSource ? '✓' : null
                    ),
                    t.deleteSource
                  )
                )
          )
        }
      }
    }

    /**
     * Register the shim at the priority that shadows the shipped `user` entry,
     * forwarding the shipped entry's `locale` seat, then confirm the renderer
     * elected it.
     */
    function seat(ctx, component, locale) {
      // The shipped entry holds priority 0 and a cell's first non-abdicated entry
      // wins in priority order, so a lower number shadows it. The `locale` seat
      // must be forwarded as well: the shipped bubble's action row calls `t`.
      ctx.slots.register(
        { name: SLOT, key: KEY, priority: -1, ...(locale === undefined ? {} : { locale }) },
        component
      )
      let elected
      try {
        elected = ctx.slots.entriesOfSlot(SLOT)?.find((entry) => entry?.options?.key === KEY)
      } catch {
        elected = undefined
      }
      if (elected !== undefined && elected.component !== component) {
        console.warn('[edit-retry] another entry owns the "user" chat-node cell')
      }
    }

    // The loader gates apply() until the declared services exist.
    return { apply, inject: ['slots'] }
  }
})
