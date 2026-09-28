// Edit-and-retry — CLIENT half.
//
// Right-clicking an ordinary user message opens a one-item context menu; choosing
// it swaps the bubble for an inline editor, and saving produces a retry session
// carrying the edited text as its prompt.
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
    /** Menu extents used to keep the popup inside the viewport. */
    const MENU_WIDTH = 168
    const MENU_HEIGHT = 36

    // --- copy -------------------------------------------------------------------
    // Read through the `locale` service on every render, so the two dictionaries
    // follow the Harness language without taking on a namespace registration.
    const ZH = {
      action: '编辑并重试',
      title: '编辑这条消息并重试',
      hint: '保存后从这里新建会话并立即发送',
      submit: '保存并重试',
      cancel: '取消',
      sending: '正在重试…',
      failed: '重试失败：'
    }
    const EN = {
      action: 'Edit and retry',
      title: 'Edit this message and retry',
      hint: 'Saving forks a new session from here and sends immediately',
      submit: 'Save and retry',
      cancel: 'Cancel',
      sending: 'Retrying…',
      failed: 'Retry failed: '
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
.dsh-edit-retry-menuitem:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-edit-retry-menuitem:focus-visible { outline: 2px solid var(--dsw-alias-button-primary-fill); outline-offset: -2px; }
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
     * Whether this message is the session's first human prompt.
     *
     * Conclusive only on a COMPLETE window: with older history still unloaded an
     * earlier prompt may simply be outside it, and answering "first" there would
     * throw away history the caller can still see.
     * @returns true when no earlier human prompt exists and none is unloaded.
     */
    function isFirstHumanPrompt(ctx, sessionId, seq) {
      const window = ctx.get('sessions')?.binding(sessionId)?.eventSource?.getSnapshot()
      if (window === undefined || window.hasMore) return false
      for (const entry of window.entries) {
        if (entry.type !== 'event') continue
        const event = entry.event
        if (event.type !== 'user/message' || event.seq >= seq) continue
        if (event.data?.source?.kind === 'user') return false
      }
      return true
    }

    /**
     * Produce the retry target, open it, and send `text` there.
     *
     * Two shapes, because the first prompt has no history worth inheriting:
     *
     * - Later prompts FORK at the event immediately before the message. That prefix
     *   ends after the Turn opened, so the agent inbox has already claimed its
     *   message and the child inherits a drained inbox.
     * - The FIRST prompt instead opens a FRESH session. Forking it cannot win:
     *   cutting inside Turn 1 leaves the Host to balance it with synthetic
     *   `step/end` + `turn/end`, which the transcript renders as an empty
     *   "用时 N 秒" row; cutting in front of Turn 1 inherits the inbox splice that
     *   still HOLDS the original prompt but not the later splice that claimed it,
     *   so the child re-sends the original text before the edited one.
     * @returns the retry session id.
     */
    async function retryFrom(ctx, { sessionId, seq, cwd, workspaceId }, text) {
      const sessions = ctx.get('sessions')
      const workspace = ctx.get('uiWorkspace')
      if (sessions === undefined) throw new Error('sessions service unavailable')
      if (workspace === undefined) throw new Error('uiWorkspace service unavailable')

      let targetId
      if (isFirstHumanPrompt(ctx, sessionId, seq)) {
        // Mirror where the SOURCE session lives, so the retry lands in the same
        // sidebar group instead of Ungrouped. `session.create` accepts workspaceId
        // or cwd and never both, and ONLY a workspaceId attaches the session to a
        // workspace — a bare cwd leaves it unaccounted.
        targetId = await sessions.create(workspaceId === undefined ? { cwd } : { workspaceId })
      } else {
        const atSeq = seq - 1
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
        await reference.binding.session.prompt([{ type: 'text', text }], 'queue')
      })

      return targetId
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
          : h('div', { className: 'dsh-edit-retry-error' }, `${t.failed}${error}`),
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
          const [busy, setBusy] = useState(false)
          const [error, setError] = useState(undefined)
          // Pointer position of the open context menu, or undefined while closed.
          const [menu, setMenu] = useState(undefined)
          const menuRef = useRef(null)
          const t = copyFor(ctx)

          // `ChatNode<'user'>` is the Chat VIEW node: `chatNode(context, kind,
          // anchorSeq, state)` wraps the message record as `data`. The shipped
          // renderer reads it the same way — `const data = node.data`.
          const data = props.node.data
          const content = data.content
          const textOnly = isTextOnly(content)
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
              setBusy(true)
              setError(undefined)
              retryFrom(
                ctx,
                { sessionId: props.sessionId, seq: data.seq, cwd: props.cwd, workspaceId },
                text
              )
                .then(() => setEditing(false))
                .catch((failure) => setError(String(failure?.message ?? failure)))
                .finally(() => setBusy(false))
            },
            [props.sessionId, props.cwd, workspaceId, data.seq]
          )

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
                      onClick: () => {
                        setMenu(undefined)
                        setEditing(true)
                      }
                    },
                    t.action
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
