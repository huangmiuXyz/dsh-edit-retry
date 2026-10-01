// Offline self-check for the edit-retry plugin.
//
// The fakes here mirror the REAL contracts, because a fake that invents a shape
// tests nothing: an earlier revision read `node.content` / `node.seq` and this
// harness happily agreed, while the live Chat view node carries the message
// record as `node.data` (`chatNode(context, kind, anchorSeq, state)`).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Repo root, resolved from this file so the check runs from any checkout. */
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** The client half's source, read fresh (the combo check also evaluates it). */
const ownClientSource = () => fs.readFileSync(path.join(PKG, 'src', 'client.js'), 'utf8')
let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  — ' + detail}`)
  if (!ok) failures++
}

// --- 1. manifests -------------------------------------------------------------
const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'))
check('package.json: name', pkg.name === 'dsh-edit-retry', pkg.name)
check('package.json: dsh.client.platform', pkg.dsh?.client?.platform === 'web')
// `immediately` puts the bundle in the boot-blocking tier: a module failure then
// fails the WHOLE web boot ("web boot: N entry did not activate") instead of
// degrading to one inactive plugin. Never set it without a reason.
check('package.json: not in the boot-blocking tier', pkg.dsh?.client?.immediately === undefined, String(pkg.dsh?.client?.immediately))
check('package.json: exports ./client', typeof pkg.exports?.['./client'] === 'string', pkg.exports?.['./client'])
check('package.json: bundle patch', typeof pkg.dsh?.bundle?.patch === 'string', pkg.dsh?.bundle?.patch)
check('package.json: inject lists ui-chat', (pkg.dsh?.client?.inject ?? []).includes('@deepseek-ai/dsh-client-ui-chat'))
check('package.json: declares no Client external', pkg.dsh?.client?.external === undefined, JSON.stringify(pkg.dsh?.client?.external))

// The patch is a four-line static file. Parse it with js-yaml when one happens to
// be installed, otherwise read the insert row structurally — the check stays
// dependency-free, which is what lets it run straight from a fresh clone.
const patchText = fs.readFileSync(path.join(PKG, 'cordis.patch.yml'), 'utf8')
let row
let parser = 'structural'
try {
  const yaml = (await import('js-yaml')).default
  row = yaml.load(patchText)?.[0]?.insert?.[0]
  parser = 'js-yaml'
} catch {
  const inserted = /^\s*-\s*insert:\s*$/m.test(patchText)
  const name = patchText.match(/^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/m)?.[1]
  row = inserted && name !== undefined ? { name } : undefined
}
check('cordis.patch.yml: inserts a row', row !== undefined, parser)
check('cordis.patch.yml: row name matches package', row?.name === pkg.name, row?.name)

// --- 2. client factory in a fake browser --------------------------------------
function makeElement(type, props, ...children) {
  return { type, props: props ?? {}, children }
}
/** Values a scripted `useState` hands back, in call order. */
let useStateScript = []
/** Values passed to any state setter, so a handler's effect can be asserted. */
const stateCalls = []
const reactStub = {
  createElement: makeElement,
  useState: (init) => {
    const scripted = useStateScript.length > 0 ? useStateScript.shift() : undefined
    return [
      scripted === undefined ? (typeof init === 'function' ? init() : init) : scripted,
      (next) => { stateCalls.push(next) }
    ]
  },
  useCallback: (fn) => fn,
  useEffect: () => {},
  useRef: (init) => ({ current: init === undefined ? null : init }),
  Fragment: Symbol('Fragment')
}
let shippedProps
const fakeShipped = function ShippedUserNode(props) { shippedProps = props; return null }

let captured
globalThis.window = {
  __ModuleLoader__: { load(spec) { captured = spec } },
  innerWidth: 1200,
  innerHeight: 800
}

const source = fs.readFileSync(path.join(PKG, 'src', 'client.js'), 'utf8')
new Function('window', source)(globalThis.window)

check('client.js: registers a module', captured !== undefined)
check('client.js: module id', captured?.id === 'dsh-edit-retry', captured?.id)
check('client.js: has factory', typeof captured?.factory === 'function')

// Tripwire: a dynamic Client half must import nothing but React (the shipped
// guidance forbids requiring Harness Client packages such as ui-primitives).
const requireStub = (name) => {
  if (name === 'react') return reactStub
  throw new Error(`client half must not require "${name}"`)
}
const mod = captured.factory(requireStub)
check('factory: imports only react', true)
check('factory returns apply', typeof mod.apply === 'function')
check('factory returns inject', Array.isArray(mod.inject) && mod.inject.includes('slots'), JSON.stringify(mod.inject))

// --- 3. faithful fakes --------------------------------------------------------
/**
 * A faithful `ChatNode<'user'>`. The Chat view node wraps the message record:
 * `chatNode(context, kind, anchorSeq, state)` → `{ kind, anchorSeq, data: state }`,
 * and `UserMessageNode` is `{ kind, seq, time, content, source }`.
 */
function userNode(seq, content) {
  return {
    key: 'chat:user',
    kind: 'user',
    id: `node-${seq}`,
    target: 'chat',
    anchorSeq: seq,
    location: {},
    visibility: 'visible',
    data: { kind: 'user', seq, time: 0, content, source: { kind: 'user' } }
  }
}
const text = (value) => ({ type: 'text', text: value })
const image = (data) => ({ type: 'image', mediaType: 'image/png', data })

/** Workspace the fake source Session is accounted to; undefined means Ungrouped. */
let sourceWorkspaceId

/** The slot's standard `useWorkspaces` seat over a snapshot for the source Session. */
function useWorkspaces(selector) {
  return selector({
    items: sourceWorkspaceId === undefined
      ? []
      : [{ workspaceId: sourceWorkspaceId, path: '/x', title: 't', sessionIds: ['session-1'] }],
    archivedSessionIds: [],
    pinnedSessionIds: [],
    state: 'idle',
    phase: 'ready',
    error: null
  })
}

/** A fake slot service whose election picks the lowest (or highest) priority. */
function makeSlots(rule, shippedLocale = 'chat') {
  // Mirrors the registry exactly: the registry hoists `locale` OUT of `options`
  // onto the entry, and the renderer keys the `t` seat off `entry.locale`.
  // `null` is the sentinel for "declares no namespace" (an explicit `undefined`
  // would just re-trigger the default parameter).
  const entries = [{
    options: { key: 'user', priority: 0 },
    ...(shippedLocale === null ? {} : { locale: shippedLocale }),
    component: fakeShipped
  }]
  return {
    // `entries(slotKey)` returns every entry of that SLOT, raw — not filtered by cell key.
    entries: () => entries.slice(),
    // `entriesOfSlot(slotKey)` elects one winner PER CELL.
    entriesOfSlot: () => {
      const cells = new Map()
      for (const entry of entries) {
        const cell = entry.options?.key
        if (cell === undefined) continue
        const current = cells.get(cell)
        if (current === undefined) { cells.set(cell, entry); continue }
        const a = current.options.priority ?? 0
        const b = entry.options.priority ?? 0
        if (rule === 'lowest' ? b < a : b > a) cells.set(cell, entry)
      }
      return [...cells.values()]
    },
    register: (options, component) => {
      const entry = { options: { ...options, priority: options.priority ?? 0 }, component, __passed: options }
      entries.push(entry)
      return () => {
        const index = entries.indexOf(entry)
        if (index >= 0) entries.splice(index, 1)
      }
    },
    __entries: entries
  }
}

function runApply(rule = 'lowest', shippedLocale = 'chat', services = {}) {
  const slots = makeSlots(rule, shippedLocale)
  const cleanups = []
  let injectedKey
  const ctx = {
    get: (name) => {
      if (name === 'locale') return services.locale ?? { getSnapshot: () => ({ active: 'zh-CN' }) }
      return services[name]
    },
    on: () => () => {},
    effect: (callback) => {
      const cleanup = callback()
      cleanups.push(cleanup)
      return () => { if (typeof cleanup === 'function') cleanup() }
    },
    slots: {
      inject(key, callback) { injectedKey = key; callback() },
      entries: slots.entries,
      entriesOfSlot: slots.entriesOfSlot,
      register: slots.register
    }
  }
  mod.apply(ctx)
  return { injectedKey, slots, cleanups }
}

const { injectedKey, slots } = runApply()
const mine = slots.__entries.filter((e) => e.component !== fakeShipped)
check('seat: injects into conversation.chat.node', injectedKey === 'conversation.chat.node', injectedKey)
check('seat: exactly one shim registered', mine.length === 1, String(mine.length))
check('seat: registers key "user"', mine[0]?.options?.key === 'user', mine[0]?.options?.key)
check('seat: shadows the shipped entry from below', mine[0]?.__passed?.priority === -1, String(mine[0]?.__passed?.priority))
// Without the shipped entry's locale namespace the renderer injects no `t` seat,
// and the shipped bubble's action row crashes on `t is not a function`.
check('seat: forwards the shipped locale seat', mine[0]?.__passed?.locale === 'chat', String(mine[0]?.__passed?.locale))
check('seat: shipped bubble kept as the wrapped body', slots.__entries.some((e) => e.component === fakeShipped))
const elected = slots.entriesOfSlot('conversation.chat.node')[0]
check('seat: shim is the elected cell winner', elected?.component === mine[0]?.component)

// --- 4. render path -----------------------------------------------------------
/** Resolve function components until a host element appears (the stub does not render them). */
function resolve(element, depth = 0) {
  if (element === null || element === undefined) return null
  if (depth > 10) return element
  if (typeof element.type === 'function') return resolve(element.type({ ...element.props }), depth + 1)
  return element
}

const shim = mine[0].component
const fakeT = (key) => key
const tree = shim({ node: userNode(8, [text('你好')]), sessionId: 'session-x', t: fakeT, useWorkspaces })
check('render: returns host element', tree?.props?.className === 'dsh-edit-retry-host', tree?.props?.className)
// The host is a layout-neutral block that exists only to carry the handler; the
// shipped bubble leads it, followed by the status and menu slots, both idle here.
check('render: leads with the shipped bubble', tree.children[0]?.type === fakeShipped, String(tree.children[0]?.type?.name))
check('render: renders no status while idle', tree.children[1] === null, String(tree.children[1]))
check('render: renders no menu while closed', tree.children[2] === null, String(tree.children[2]))
check('render: renders no edit button', !JSON.stringify(tree).includes('dsh-edit-retry-icon'))
resolve(tree.children[0])
check('render: forwards the t seat to the shipped bubble', shippedProps?.t === fakeT)

// No fabricated seat: the shipped node receives exactly the seat the renderer
// injected. Substituting one would hide a broken locale forward behind raw keys,
// turning a loud, diagnosable failure into silent wrong UI.
const noSeatTree = shim({ node: userNode(10, [text('hi')]), sessionId: 'session-x', useWorkspaces })
resolve(noSeatTree.children[0])
check('render: does not fabricate a t seat', shippedProps?.t === undefined, String(shippedProps?.t))

// A shipped entry that declares no locale namespace is a defect worth shouting
// about at registration time — silently forwarding no seat would crash later.
const warnings = []
const originalWarn = console.warn
console.warn = (...args) => warnings.push(args.join(' '))
try {
  runApply('lowest', null)
} finally {
  console.warn = originalWarn
}
check(
  'seat: reports a locale-less shipped entry',
  warnings.some((line) => line.includes('no locale namespace')),
  warnings.join(' | ') || '(no warning)'
)

// An attachment message cannot be resent as text, so double-click must do nothing.
const attachTree = shim({ node: userNode(9, [text('see'), image('x')]), sessionId: 'session-x', useWorkspaces })

// --- 4b. context-menu entry ---------------------------------------------------
const plainTarget = { closest: () => null }
const interactiveTarget = { closest: (selector) => (selector.includes('button') ? {} : null) }
/** A right-click event at the pointer, recording whether the native menu is kept. */
function contextMenu(target, x = 100, y = 200) {
  const event = { target, clientX: x, clientY: y, prevented: false }
  event.preventDefault = () => { event.prevented = true }
  return event
}

check('menu: host carries the handler', typeof tree.props.onContextMenu === 'function')

stateCalls.length = 0
const openedMenu = contextMenu(plainTarget)
tree.props.onContextMenu(openedMenu)
check('menu: suppresses the native menu', openedMenu.prevented)
check('menu: opens at the pointer', stateCalls.some((call) => call?.left === 100 && call?.top === 200), JSON.stringify(stateCalls))

// Near the viewport edge the menu must stay reachable instead of hanging off it.
stateCalls.length = 0
tree.props.onContextMenu(contextMenu(plainTarget, 1190, 790))
check(
  'menu: clamps inside the viewport',
  stateCalls.some((call) => call?.left === 1200 - 168 && call?.top === 800 - 108),
  JSON.stringify(stateCalls)
)

// The shipped copy control is a <button> inside the wrapper: its own context menu
// must stay its own.
stateCalls.length = 0
const onButton = contextMenu(interactiveTarget)
tree.props.onContextMenu(onButton)
check('menu: ignores interactive descendants', stateCalls.length === 0 && !onButton.prevented, JSON.stringify(stateCalls))

// An attachment message cannot be resent as text, so it keeps the native menu.
stateCalls.length = 0
const onAttachment = contextMenu(plainTarget)
attachTree.props.onContextMenu(onAttachment)
check('menu: ignores attachment messages', stateCalls.length === 0 && !onAttachment.prevented, JSON.stringify(stateCalls))

// The open menu offers two entries — retry first, the editor second, then a rule
// and the delete-source toggle — and choosing the second enters the editor.
// The shim's useState order is editing, busy, error, menu, deleteSource.
useStateScript = [false, undefined, undefined, { left: 10, top: 20 }, false]
const menuTree = shim({ node: userNode(8, [text('你好')]), sessionId: 'session-x', t: fakeT, useWorkspaces })
const menuBox = resolve(menuTree.children[2])
check('menu: renders the popup when open', menuBox?.props?.className === 'dsh-edit-retry-menu', String(menuBox?.props?.className))
check('menu: positioned at the pointer', menuBox?.props?.style?.left === '10px' && menuBox?.props?.style?.top === '20px', JSON.stringify(menuBox?.props?.style))
const menuItems = (menuBox?.children ?? []).map((child) => resolve(child))
check('menu: offers four rows', menuItems.length === 4, String(menuItems.length))
check('menu: offers the zh retry first', menuItems[0]?.children?.[0] === '重试', JSON.stringify(menuItems[0]?.children))
check('menu: offers the zh edit action second', menuItems[1]?.children?.[0] === '编辑并重试', JSON.stringify(menuItems[1]?.children))
check('menu: the two entries are distinct handlers', menuItems[0]?.props?.onClick !== menuItems[1]?.props?.onClick)
check('menu: retry is enabled for non-empty text', menuItems[0]?.props?.disabled === false, String(menuItems[0]?.props?.disabled))
check('menu: separates the toggle from the actions', menuItems[2]?.props?.className === 'dsh-edit-retry-separator', String(menuItems[2]?.props?.className))
check('menu: offers the zh delete-source toggle last', menuItems[3]?.children?.[1] === '重试后删除原会话', JSON.stringify(menuItems[3]?.children))
check('menu: the toggle is a checkbox, not an action', menuItems[3]?.props?.role === 'menuitemcheckbox', String(menuItems[3]?.props?.role))
check('menu: the toggle starts unchecked', menuItems[3]?.props?.['aria-checked'] === false, String(menuItems[3]?.props?.['aria-checked']))
// The unchecked state must still be VISIBLE. An empty slot renders as nothing and
// the row stops reading as a checkbox at all, which is the whole point of the box.
check('menu: the unchecked toggle draws a box', menuItems[3]?.children?.[0]?.props?.className === 'dsh-edit-retry-check', String(menuItems[3]?.children?.[0]?.props?.className))
check('menu: the unchecked box is unfilled', !String(menuItems[3]?.children?.[0]?.props?.className).includes('check-on'), String(menuItems[3]?.children?.[0]?.props?.className))
check('menu: the unchecked box carries no glyph', menuItems[3]?.children?.[0]?.children?.[0] === null, JSON.stringify(menuItems[3]?.children?.[0]?.children))
stateCalls.length = 0
menuItems[1]?.props?.onClick?.()
check('menu: choosing the edit entry enters the editor', stateCalls.includes(true), JSON.stringify(stateCalls))

// Marking the toggle actually marks it — the visual tick is driven by the flag,
// and an armed toggle must survive into the retry that follows.
stateCalls.length = 0
menuItems[3]?.props?.onClick?.()
check('menu: choosing the toggle flips it on', stateCalls.includes(true), JSON.stringify(stateCalls))
useStateScript = [false, undefined, undefined, { left: 10, top: 20 }, true]
const armedTree = shim({ node: userNode(8, [text('你好')]), sessionId: 'session-x', t: fakeT, useWorkspaces })
const armedToggle = resolve(resolve(armedTree.children[2])?.children?.[3])
check('menu: an armed toggle shows a tick', armedToggle?.props?.['aria-checked'] === true, String(armedToggle?.props?.['aria-checked']))
check('menu: an armed toggle renders the tick glyph', armedToggle?.children?.[0]?.children?.[0] === '✓', JSON.stringify(armedToggle?.children?.[0]))
check('menu: the armed box is filled in', armedToggle?.children?.[0]?.props?.className === 'dsh-edit-retry-check dsh-edit-retry-check-on', String(armedToggle?.children?.[0]?.props?.className))
check('menu: the toggle is operable while idle', armedToggle?.props?.disabled === false, String(armedToggle?.props?.disabled))

// Blank text is not worth resending, so retry disables itself while the
// editor stays available — it is the only way to put text on such a message.
useStateScript = [false, undefined, undefined, { left: 10, top: 20 }, false]
const blankTree = shim({ node: userNode(8, [text('   ')]), sessionId: 'session-x', t: fakeT, useWorkspaces })
const blankItems = (resolve(blankTree.children[2])?.children ?? []).map((child) => resolve(child))
check('menu: retry is disabled for blank text', blankItems[0]?.props?.disabled === true, String(blankItems[0]?.props?.disabled))
check('menu: the edit entry stays available for blank text', blankItems[1]?.props?.disabled === false, String(blankItems[1]?.props?.disabled))

// The menu closes on click, so the status slot is the only place a retry
// can report progress and failure.
useStateScript = [false, 'retry', undefined, undefined]
const busyTree = shim({ node: userNode(8, [text('你好')]), sessionId: 'session-x', t: fakeT, useWorkspaces })
const busyStatus = resolve(busyTree.children[1])
check('status: shows progress while a retry runs', busyStatus?.children?.[0]?.children?.[0] === '正在重试…', JSON.stringify(busyStatus?.children))

// The error slot carries its own label, so a retry failure and a delete failure
// are distinguishable rather than both claiming the retry failed.
useStateScript = [false, undefined, '重试失败：boom', undefined]
const failedTree = shim({ node: userNode(8, [text('你好')]), sessionId: 'session-x', t: fakeT, useWorkspaces })
const failedStatus = resolve(failedTree.children[1])
check('status: reports a failed retry', failedStatus?.children?.[0]?.children?.[0] === '重试失败：boom', JSON.stringify(failedStatus?.children))

// During the delete half the SAME slot must say what is actually happening.
useStateScript = [false, 'delete', undefined, undefined]
const deletingTree = shim({ node: userNode(8, [text('你好')]), sessionId: 'session-x', t: fakeT, useWorkspaces })
const deletingStatus = resolve(deletingTree.children[1])
check('status: names the delete phase, not the retry phase', deletingStatus?.children?.[0]?.children?.[0] === '正在删除原会话…', JSON.stringify(deletingStatus?.children))

useStateScript = [false, undefined, '删除原会话失败：nope', undefined]
const deleteFailedTree = shim({ node: userNode(8, [text('你好')]), sessionId: 'session-x', t: fakeT, useWorkspaces })
const deleteFailedStatus = resolve(deleteFailedTree.children[1])
check('status: reports a failed delete', deleteFailedStatus?.children?.[0]?.children?.[0] === '删除原会话失败：nope', JSON.stringify(deleteFailedStatus?.children))

// Closed by default: no popup competes with the shipped bubble.
useStateScript = []
const closedTree = shim({ node: userNode(8, [text('你好')]), sessionId: 'session-x', t: fakeT, useWorkspaces })
check('menu: stays closed until asked', closedTree.children[2] === null, JSON.stringify(closedTree.children.length))

// --- 5. submit path: fork vs fresh session, and the resend ---------------------
const forkCalls = []
const createCalls = []
const promptCalls = []
/** Ordered landmark log: what the retry did to the target, and in which order. */
const callOrder = []
/**
 * A faithful COMPLETE event window for one session: an earlier human prompt at
 * seq 8 opens turn 1; a later one at seq 21 opens turn 2.
 */
let windowEntries = [
  { type: 'event', event: { type: 'permission/preset', seq: 0 } },
  { type: 'event', event: { type: 'agent/inbox/spliced', seq: 3 } },
  { type: 'event', event: { type: 'turn/start', seq: 4 } },
  { type: 'event', event: { type: 'agent/inbox/spliced', seq: 5 } },
  { type: 'event', event: { type: 'step/start', seq: 6 } },
  { type: 'event', event: { type: 'system/message', seq: 7 } },
  { type: 'event', event: { type: 'user/message', seq: 8, data: { source: { kind: 'user' } } } },
  { type: 'event', event: { type: 'turn/end', seq: 19 } },
  { type: 'event', event: { type: 'turn/start', seq: 20 } },
  { type: 'event', event: { type: 'user/message', seq: 21, data: { source: { kind: 'user' } } } }
]
let windowHasMore = false
/**
 * The `modelSelection` projection of each session, keyed by id — the durable
 * `{ lastUsed, next }` wire view the composer's model control renders. The retry
 * reads the SOURCE's, and compares the TARGET's before deciding to write a
 * selection of its own.
 */
let selectionsById = {}
const sessions = {
  fork: (options) => {
    forkCalls.push(options)
    return Promise.resolve('session-child')
  },
  create: (options) => {
    createCalls.push(options ?? {})
    return Promise.resolve('session-fresh')
  },
  binding: (id) => ({
    eventSource: {
      getSnapshot: () => ({ entries: windowEntries, hasMore: windowHasMore, revision: 1, change: { kind: 'append', entries: [] } })
    },
    session: {
      projections: {
        // `faceOf` answers for EVERY key and reports absence as an undefined
        // snapshot — never as a missing face.
        faceOf: (key) => ({ getSnapshot: () => (key === 'modelSelection' ? selectionsById[id] : undefined) })
      }
    }
  }),
  using: async (target, options, operation) =>
    operation({
      sessionId: target,
      ready: Promise.resolve(),
      binding: {
        sessionId: target,
        session: {
          prompt: async (content, mode) => {
            promptCalls.push({ target, content, mode })
            callOrder.push('prompt')
          }
        }
      }
    })
}
const opened = []
const { slots: submitSlots } = runApply('lowest', 'chat', {
  sessions,
  uiWorkspace: { openSession: async (id) => { opened.push(id) } }
})
const submitShim = submitSlots.__entries.find((e) => e.component !== fakeShipped).component

/** Drive the shim into its editor and click submit. */
async function submitVia(seq, value, cwd, workspaceId, armed = false) {
  sourceWorkspaceId = workspaceId
  // The shim's useState order is editing, busy, error, menu, deleteSource; an
  // omitted tail falls back to that slot's own initial value.
  useStateScript = armed ? [true, undefined, undefined, undefined, true] : [true]
  const host = submitShim({
    node: userNode(seq, [text(value)]),
    sessionId: 'session-1',
    cwd,
    t: fakeT,
    useWorkspaces
  })
  const body = resolve(host?.children?.[0])
  const row = resolve((body?.children ?? []).filter(Boolean).find((child) => child?.props?.className === 'dsh-edit-retry-row'))
  resolve((row?.children ?? []).find((child) => child?.props?.className?.includes('btn-primary')))?.props?.onClick?.()
  await new Promise((done) => setTimeout(done, 0))
}

/**
 * Drive the shim's menu and choose retry.
 *
 * Nothing here can observe "the editor was skipped" directly — the stub's setters
 * record values, not which `useState` they belong to, and both entries set `true`
 * once (editing vs busy). The proof is indirect and stronger: the edit entry only
 * opens an editor and reaches the sessions service on a LATER submit, so a fork
 * and a prompt landing on this tick can only come from the retry entry.
 */
async function retryVia(seq, value, cwd, workspaceId) {
  sourceWorkspaceId = workspaceId
  useStateScript = [false, undefined, undefined, { left: 10, top: 20 }]
  const host = submitShim({
    node: userNode(seq, [text(value)]),
    sessionId: 'session-1',
    cwd,
    t: fakeT,
    useWorkspaces
  })
  const items = (resolve(host?.children?.[2])?.children ?? []).map((child) => resolve(child))
  items[0]?.props?.onClick?.()
  await new Promise((done) => setTimeout(done, 0))
}

// Retrying the FIRST prompt must not fork: a fork either cuts inside turn 1 (Host
// synthesizes an empty closing row) or in front of it (the child inherits the
// inbox splice still holding the ORIGINAL prompt and re-sends it).
await submitVia(8, '改过的第一句', PKG, 'ws-1')
check('submit: first prompt opens a fresh session', createCalls.length === 1, JSON.stringify(createCalls))
check('submit: first prompt does not fork', forkCalls.length === 0, JSON.stringify(forkCalls))
// Only a workspaceId attaches the session; a bare cwd lands it in Ungrouped.
check('submit: fresh session attaches to the source Workspace', createCalls[0]?.workspaceId === 'ws-1', JSON.stringify(createCalls[0]))
check('submit: never sends workspaceId and cwd together', createCalls[0]?.cwd === undefined, JSON.stringify(createCalls[0]))
check('submit: opens the fresh session', opened[0] === 'session-fresh', String(opened[0]))
check('submit: resends the edited text as a queued prompt', promptCalls[0]?.target === 'session-fresh' && promptCalls[0]?.mode === 'queue' && promptCalls[0]?.content?.[0]?.text === '改过的第一句', JSON.stringify(promptCalls[0]))

// A source that is itself Ungrouped has no Workspace to mirror; the retry stays
// Ungrouped with it rather than inventing one.
createCalls.length = 0
await submitVia(8, '第一句', PKG, undefined)
check('submit: an Ungrouped source creates with cwd only', createCalls[0]?.workspaceId === undefined && createCalls[0]?.cwd === PKG, JSON.stringify(createCalls[0]))

// A later prompt forks at the previous turn's CLOSED boundary — `turn/end` at 19,
// not the message's predecessor at 20. Cutting at 20 lands inside the open turn,
// and `buildForkSeed`'s `openTurnClosers` then synthesizes a `step/end` +
// `turn/end {kind:"forked"}` with no user message behind it, which the transcript
// renders as an empty "用时 N 秒" row in front of the retry. It still sits after
// the inbox splice that claimed turn 1's prompt, so nothing is re-sent.
forkCalls.length = 0
createCalls.length = 0
promptCalls.length = 0
await submitVia(21, '第二句')
check('submit: later prompt forks instead of creating', forkCalls.length === 1 && createCalls.length === 0, JSON.stringify({ forkCalls, createCalls }))
check('submit: forks the source session', forkCalls[0]?.sessionId === 'session-1', JSON.stringify(forkCalls[0]))
check('submit: forks at the previous closed turn', forkCalls[0]?.atSeq === 19, String(forkCalls[0]?.atSeq))
check('submit: bumps the inherited title', forkCalls[0]?.increaseTitle === true, String(forkCalls[0]?.increaseTitle))

// A steering message injected MID-turn has no closed boundary before it: every
// earlier event belongs to its own turn, so cutting at the previous `turn/end`
// would drop messages the caller can still see. It keeps the predecessor — and
// with it the synthesized closing row, which is the lesser cost.
windowEntries = [
  { type: 'event', event: { type: 'turn/start', seq: 20 } },
  { type: 'event', event: { type: 'user/message', seq: 21, data: { source: { kind: 'user' } } } },
  { type: 'event', event: { type: 'user/message', seq: 22, data: { source: { kind: 'user' } } } }
]
forkCalls.length = 0
await submitVia(22, '插话')
check('submit: a mid-turn steering message keeps the predecessor', forkCalls[0]?.atSeq === 21, String(forkCalls[0]?.atSeq))

// An aborted turn can leave a prompt spliced into the inbox and never claimed —
// observed in a real log, where seq 212 spliced a prompt, the turn ended
// `aborted` at 215, and only the NEXT turn drained it at 219. The previous
// `turn/end` is still a closed boundary, but forking there would inherit that
// unclaimed prompt, so the child would re-send text the source never answered.
// A non-empty inbox therefore disqualifies the boundary and the predecessor
// stands. (Net count: inserted 1 - removed 0.)
windowEntries = [
  { type: 'event', event: { type: 'user/message', seq: 8, data: { source: { kind: 'user' } } } },
  { type: 'event', event: { type: 'turn/start', seq: 20 } },
  { type: 'event', event: { type: 'user/message', seq: 21, data: { source: { kind: 'user' } } } },
  { type: 'event', event: { type: 'agent/inbox/spliced', seq: 25, data: { target: 'next-turn', start: 0, inserted: [{ content: [{ text: '滞留' }] }], removedCount: 0 } } },
  { type: 'event', event: { type: 'turn/end', seq: 30, data: { reason: { kind: 'aborted' } } } },
  { type: 'event', event: { type: 'turn/start', seq: 31 } },
  { type: 'event', event: { type: 'user/message', seq: 32, data: { source: { kind: 'user' } } } }
]
forkCalls.length = 0
await submitVia(32, '接着问')
check('submit: an unclaimed inbox prompt disqualifies the closed turn', forkCalls[0]?.atSeq === 31, String(forkCalls[0]?.atSeq))

// An incomplete window cannot prove "first": an earlier prompt may just be
// unloaded, so history the caller can still see must not be discarded.
forkCalls.length = 0
createCalls.length = 0
windowHasMore = true
windowEntries = [
  { type: 'event', event: { type: 'step/start', seq: 5 } },
  { type: 'event', event: { type: 'system/message', seq: 6 } },
  { type: 'event', event: { type: 'user/message', seq: 7, data: { source: { kind: 'user' } } } }
]
await submitVia(7, '窗口外')
check('submit: a paged window never counts as "first"', createCalls.length === 0 && forkCalls.length === 1, JSON.stringify({ forkCalls, createCalls }))
check('submit: paged window forks at the predecessor', forkCalls[0]?.atSeq === 6, String(forkCalls[0]?.atSeq))

// --- 5b. retry ---------------------------------------------------------
// Retry is the same path with the text untouched: it must reach the sessions
// service without an editor round-trip, and resend the ORIGINAL bytes.
windowHasMore = false
windowEntries = [
  { type: 'event', event: { type: 'user/message', seq: 8, data: { source: { kind: 'user' } } } },
  { type: 'event', event: { type: 'turn/end', seq: 19 } },
  { type: 'event', event: { type: 'turn/start', seq: 20 } },
  { type: 'event', event: { type: 'user/message', seq: 21, data: { source: { kind: 'user' } } } }
]
forkCalls.length = 0
createCalls.length = 0
promptCalls.length = 0
opened.length = 0
await retryVia(21, '第二句', PKG, 'ws-1')
check('retry: forks without an editor round-trip', forkCalls.length === 1, JSON.stringify({ forkCalls, createCalls }))
check('retry: never falls back to a fresh session', createCalls.length === 0, JSON.stringify(createCalls))
check('retry: forks at the previous closed turn', forkCalls[0]?.atSeq === 19, String(forkCalls[0]?.atSeq))
check('retry: resends the original text unchanged', promptCalls[0]?.content?.[0]?.text === '第二句', JSON.stringify(promptCalls[0]))
check('retry: opens the retry session', opened[0] === 'session-child', String(opened[0]))

// The first prompt still opens a fresh session on the retry path: the fork rule
// belongs to the position of the message, not to which entry was chosen.
forkCalls.length = 0
createCalls.length = 0
promptCalls.length = 0
windowEntries = [
  { type: 'event', event: { type: 'turn/start', seq: 4 } },
  { type: 'event', event: { type: 'user/message', seq: 8, data: { source: { kind: 'user' } } } }
]
await retryVia(8, '第一句', PKG, 'ws-1')
check('retry: the first prompt still creates', createCalls.length === 1 && forkCalls.length === 0, JSON.stringify({ forkCalls, createCalls }))
check('retry: the fresh session mirrors the Workspace', createCalls[0]?.workspaceId === 'ws-1', JSON.stringify(createCalls[0]))
check('retry: the fresh session resends the original text', promptCalls[0]?.content?.[0]?.text === '第一句', JSON.stringify(promptCalls[0]))

// --- 5c. the model the retry runs on -------------------------------------------
// A fork inherits only the source's event PREFIX, and a Host resolves a session's
// model from that session's OWN log, so a selection the user made after the
// retried message never reaches the child. The retry therefore reads what the
// source is showing and pins it on the target BEFORE the prompt.
const selectCalls = []
let selectReply = { ok: true, value: { selected: { provider: 'picked', model: 'big-model', reasoningEffort: 'high' } } }
const modelRemote = {
  selectModel: async (request) => {
    selectCalls.push(request)
    callOrder.push('select')
    return selectReply
  }
}
const { slots: modelSlots } = runApply('lowest', 'chat', {
  sessions,
  uiWorkspace: { openSession: async () => {} },
  'remote.session': modelRemote
})
const modelShim = modelSlots.__entries.find((e) => e.component !== fakeShipped).component

/** Drive `modelShim`'s retry entry for one source/target selection pair. */
async function retryWith(seq, source, target, value = '第二句') {
  selectionsById = { 'session-1': source, 'session-child': target, 'session-fresh': target }
  selectCalls.length = 0
  promptCalls.length = 0
  forkCalls.length = 0
  createCalls.length = 0
  callOrder.length = 0
  useStateScript = [false, undefined, undefined, { left: 10, top: 20 }]
  const host = modelShim({ node: userNode(seq, [text(value)]), sessionId: 'session-1', cwd: PKG, t: fakeT, useWorkspaces })
  const items = (resolve(host?.children?.[2])?.children ?? []).map((child) => resolve(child))
  items[0]?.props?.onClick?.()
  await new Promise((done) => setTimeout(done, 0))
}

// The user switched models and then retried an older message. The prefix resolves
// to the OLD route; the retry must run on the one they are looking at.
const later = [
  { type: 'event', event: { type: 'user/message', seq: 8, data: { source: { kind: 'user' } } } },
  { type: 'event', event: { type: 'turn/end', seq: 19 } },
  { type: 'event', event: { type: 'turn/start', seq: 20 } },
  { type: 'event', event: { type: 'user/message', seq: 21, data: { source: { kind: 'user' } } } }
]
windowEntries = later
await retryWith(21, { lastUsed: { provider: 'old', model: 'old-model' }, next: { provider: 'picked', model: 'big-model', reasoningEffort: 'high' } }, { lastUsed: { provider: 'old', model: 'old-model' }, next: { provider: 'old', model: 'old-model' } })
check(
  'model: the retry adopts the route the source shows, not the inherited one',
  selectCalls[0]?.sessionId === 'session-child' && selectCalls[0]?.provider === 'picked' && selectCalls[0]?.model === 'big-model' && selectCalls[0]?.reasoningEffort === 'high',
  JSON.stringify(selectCalls[0])
)
check('model: the selection lands BEFORE the prompt', callOrder.join(',') === 'select,prompt', callOrder.join(','))
check('model: the retry still sends the text', promptCalls.length === 1, JSON.stringify(promptCalls.length))

// The fresh-session path has no prefix to inherit from, so the source's selection
// has to be pinned there too — a new session would otherwise resolve to whatever
// the deployment default happens to be.
windowEntries = [
  { type: 'event', event: { type: 'turn/start', seq: 4 } },
  { type: 'event', event: { type: 'user/message', seq: 8, data: { source: { kind: 'user' } } } }
]
await retryWith(8, { next: { provider: 'picked', model: 'big-model' } }, undefined, '第一句')
check('model: a fresh retry session is pinned as well', selectCalls[0]?.sessionId === 'session-fresh' && selectCalls[0]?.provider === 'picked', JSON.stringify(selectCalls[0]))
check('model: the fresh session still gets its prompt', promptCalls[0]?.content?.[0]?.text === '第一句', JSON.stringify(promptCalls[0]))
windowEntries = later

// `next` is the pending intent, `lastUsed` only its fallback — a session whose
// user just picked a model reports it in `next`, and that is the one to copy.
await retryWith(21, { lastUsed: { provider: 'used', model: 'used' }, next: null }, { lastUsed: { provider: 'old', model: 'old' }, next: { provider: 'old', model: 'old' } })
check('model: a null `next` falls back to the last used route', selectCalls[0]?.provider === 'used' && selectCalls[0]?.model === 'used', JSON.stringify(selectCalls[0]))

// Nothing to carry: a session that never selected keeps its own resolution.
await retryWith(21, { lastUsed: null, next: null }, { lastUsed: { provider: 'old', model: 'old' }, next: { provider: 'old', model: 'old' } })
check('model: an unselected source selects nothing', selectCalls.length === 0, JSON.stringify(selectCalls))

// A target that already resolves to the same route is left alone: no redundant
// durable event, and no needless re-save of the deployment default.
await retryWith(21, { lastUsed: null, next: { provider: 'same', model: 'same', reasoningEffort: 'max' } }, { lastUsed: null, next: { provider: 'same', model: 'same', reasoningEffort: 'max' } })
check('model: an already-matching target is not re-selected', selectCalls.length === 0, JSON.stringify(selectCalls))
check('model: the prompt still goes out after a skip', promptCalls.length === 1, JSON.stringify(promptCalls.length))

// Every effort field is optional on the wire; a route without one must not gain
// a fabricated effort (`undefined` is not the same as `off`).
await retryWith(21, { next: { provider: 'p', model: 'm' } }, { next: { provider: 'old', model: 'old' } })
check('model: an absent effort is not invented', selectCalls[0] !== undefined && !('reasoningEffort' in selectCalls[0]), JSON.stringify(selectCalls[0]))

// A refused selection (route withdrawn, session held by another writer) is the
// Host saying no to the ADD-ON: the retry itself must still be sent.
selectReply = { ok: false, error: { code: 'session/model-unavailable', message: 'no adapter serves this route' } }
await retryWith(21, { next: { provider: 'gone', model: 'gone' } }, { next: { provider: 'old', model: 'old' } })
check('model: a refused selection does not fail the retry', promptCalls.length === 1, JSON.stringify({ promptCalls, selectCalls }))

const selectionWarnings = []
const realWarn = console.warn
console.warn = (...args) => selectionWarnings.push(args.join(' '))
try {
  selectReply = { ok: true }
  modelRemote.selectModel = async () => { throw new Error('transport exploded') }
  await retryWith(21, { next: { provider: 'p', model: 'm' } }, { next: { provider: 'old', model: 'old' } })
} finally {
  modelRemote.selectModel = async (request) => { selectCalls.push(request); callOrder.push('select'); return selectReply }
  console.warn = realWarn
}
check('model: a throwing selection does not fail the retry', promptCalls.length === 1, JSON.stringify(promptCalls.length))
check('model: a swallowed failure is reported', selectionWarnings.some((line) => line.includes('inherited model') && line.includes('transport exploded')), selectionWarnings.join(' | ') || '(no warning)')

// The carry-over is an ADD-ON: a profile with no session Remote namespace keeps
// the menu and the retry, and only loses the model hand-off.
const { slots: noRemoteSlots } = runApply('lowest', 'chat', {
  sessions,
  uiWorkspace: { openSession: async () => {} }
})
const noRemoteShim = noRemoteSlots.__entries.find((e) => e.component !== fakeShipped).component
selectionsById = { 'session-1': { next: { provider: 'picked', model: 'big' } }, 'session-child': { next: { provider: 'old', model: 'old' } } }
selectCalls.length = 0
promptCalls.length = 0
useStateScript = [false, undefined, undefined, { left: 10, top: 20 }]
const noRemoteHost = noRemoteShim({ node: userNode(21, [text('第二句')]), sessionId: 'session-1', cwd: PKG, t: fakeT, useWorkspaces })
resolve(resolve(noRemoteHost?.children?.[2])?.children?.[0])?.props?.onClick?.()
await new Promise((done) => setTimeout(done, 0))
check('model: without the Remote namespace the retry still runs', promptCalls.length === 1 && selectCalls.length === 0, JSON.stringify({ promptCalls: promptCalls.length, selectCalls: selectCalls.length }))

// --- 5d. the delete-the-source half -------------------------------------------
// Client and host are separate module graphs with no shared import, so the route
// and header are spelled twice. Assert the two spellings agree, or the feature
// would silently 404 forever.
// `import()` needs a URL, not a path: a Windows absolute path (`E:\...`) is read
// as the scheme `e:` and rejected with ERR_UNSUPPORTED_ESM_URL_SCHEME.
const host = await import(pathToFileURL(path.join(PKG, 'src', 'index.js')).href)
check('delete: the client and host agree on the route', ownClientSource().includes(`'${host.ROUTE}'`), host.ROUTE)
check('delete: the client and host agree on the header', ownClientSource().includes(`'${host.HEADER}'`), host.HEADER)

const fetchCalls = []
let fetchReply = { ok: true, status: 200, payload: { ok: true, sessionId: 'session-1', dirsRemoved: 1 } }
globalThis.fetch = async (url, options) => {
  fetchCalls.push({ url, options })
  return {
    ok: fetchReply.ok,
    status: fetchReply.status,
    json: async () => fetchReply.payload
  }
}

// Armed: the retry lands first, then the source is deleted through the host route.
forkCalls.length = 0
promptCalls.length = 0
fetchCalls.length = 0
stateCalls.length = 0
windowEntries = [
  { type: 'event', event: { type: 'user/message', seq: 8, data: { source: { kind: 'user' } } } },
  { type: 'event', event: { type: 'turn/end', seq: 19 } },
  { type: 'event', event: { type: 'turn/start', seq: 20 } },
  { type: 'event', event: { type: 'user/message', seq: 21, data: { source: { kind: 'user' } } } }
]
await submitVia(21, '改过的', PKG, 'ws-1', true)
check('delete: an armed retry posts to the host route', fetchCalls[0]?.url === host.ROUTE, JSON.stringify(fetchCalls[0]?.url))
check('delete: the request is a POST', fetchCalls[0]?.options?.method === 'POST', String(fetchCalls[0]?.options?.method))
check('delete: the request carries the guard header', fetchCalls[0]?.options?.headers?.[host.HEADER] === '1', JSON.stringify(fetchCalls[0]?.options?.headers))
check('delete: it names the SOURCE session, not the retry', JSON.parse(fetchCalls[0]?.options?.body ?? '{}').sessionId === 'session-1', String(fetchCalls[0]?.options?.body))
check('delete: the retry is sent before the delete', promptCalls.length === 1 && fetchCalls.length === 1, JSON.stringify({ promptCalls: promptCalls.length, fetchCalls: fetchCalls.length }))
check('delete: the phase is announced before the call', stateCalls.includes('delete'), JSON.stringify(stateCalls))

// Disarmed: the very same retry must not touch the source at all.
forkCalls.length = 0
fetchCalls.length = 0
await submitVia(21, '改过的', PKG, 'ws-1', false)
check('delete: a disarmed retry never calls the route', fetchCalls.length === 0, JSON.stringify(fetchCalls))

// A failed retry must NOT delete the source: the retry never got in flight, so
// removing the original would destroy the only copy of the conversation.
forkCalls.length = 0
fetchCalls.length = 0
const realFork = sessions.fork
sessions.fork = () => Promise.reject(new Error('fork exploded'))
await submitVia(21, '改过的', PKG, 'ws-1', true)
check('delete: a failed retry leaves the source alone', fetchCalls.length === 0, JSON.stringify(fetchCalls))
sessions.fork = realFork

// A failed DELETE is reported as a delete failure, not as a retry failure.
forkCalls.length = 0
fetchCalls.length = 0
stateCalls.length = 0
fetchReply = { ok: false, status: 500, payload: { ok: false, error: 'session log could not be removed' } }
await submitVia(21, '改过的', PKG, 'ws-1', true)
check('delete: a rejected delete surfaces the host error', stateCalls.some((call) => typeof call === 'string' && call.startsWith('删除原会话失败：') && call.includes('session log could not be removed')), JSON.stringify(stateCalls))
fetchReply = { ok: true, status: 200, payload: { ok: true } }

// --- 5e. host half: the delete itself ------------------------------------------
// The host half is driven for real: a temporary DSH_HOME holds actual session
// directories, so the filesystem behaviour under test is the real one.
const SESSION = '11111111-2222-3333-4444-555555555555'
const OTHER = '99999999-8888-7777-6666-555555555555'
const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-edit-retry-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = dshHome

const slugA = path.join(dshHome, 'sessions', '--slug-a--')
const slugB = path.join(dshHome, 'sessions', '--slug-b--')
// The two id spellings live under different slugs, as they do in a real store.
const prefixedDir = path.join(slugA, `session-${SESSION}`)
const rawDir = path.join(slugB, SESSION)
const survivorDir = path.join(slugA, `session-${OTHER}`)
for (const dir of [prefixedDir, rawDir, survivorDir]) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.jsonl.zstd'), 'log')
}

function fakeTable(initial) {
  const map = new Map(Object.entries(initial))
  return {
    get: (key) => map.get(key),
    put: async (key, value) => { map.set(key, value) },
    delete: async (key) => { map.delete(key) },
    entries: () => [...map.entries()],
    __map: map
  }
}
const projectionTable = fakeTable({ [SESSION]: { rows: {} }, [OTHER]: { rows: {} } })
let workspaceRow = { workspaceId: 'ws-1', sessionIds: [SESSION, OTHER] }
const workspaceTable = fakeTable({ 'ws-1': workspaceRow })
let globalState = { archivedSessionIds: [SESSION] }
const storageDomain = {
  get: (name) => {
    if (name === 'session_projcache') return { table: (table) => (table === 'sessions' ? projectionTable : undefined) }
    if (name === 'workspace') {
      return {
        table: (table) => (table === 'workspaces' ? workspaceTable : undefined),
        global: { get: () => globalState, set: async (next) => { globalState = next } }
      }
    }
    return undefined
  }
}

let idleResolved = false
const agents = { get: (id) => (id === SESSION ? { cancel: () => { idleResolved = 'cancelled' }, whenIdle: async () => { idleResolved = 'idle' } } : undefined) }
const flushed = []
const liveSessions = { flush: async (session) => { flushed.push(session) }, get: (id) => (id === `session-${SESSION}` ? { id } : undefined) }
const routes = new Map()
const webServer = { register: ({ kind, path: routePath, handler }) => { routes.set(routePath, { kind, handler }); return () => routes.delete(routePath) } }

const hostEffects = []
const hostCtx = {
  get: (name) => ({ webServer, agents, sessions: liveSessions, storageDomain })[name],
  inject: () => {},
  effect: (callback, label) => { const dispose = callback(); hostEffects.push({ label, dispose }); return () => {} }
}
host.apply(hostCtx)
check('host: registers the delete route', routes.has(host.ROUTE), [...routes.keys()].join(','))
check('host: the route is an exact match', routes.get(host.ROUTE)?.kind === 'exact', String(routes.get(host.ROUTE)?.kind))
check('host: registration belongs to an effect', hostEffects.some((e) => String(e.label).includes('delete route')), JSON.stringify(hostEffects.map((e) => e.label)))

/** A request whose body arrives asynchronously, like a real stream. */
function makeReq({ method = 'POST', headers = {}, body = '' } = {}) {
  const listeners = {}
  const req = {
    method,
    headers,
    on(event, listener) { (listeners[event] ??= []).push(listener); return req },
    destroy() {}
  }
  queueMicrotask(() => {
    if (body) for (const listener of listeners.data ?? []) listener(Buffer.from(body))
    for (const listener of listeners.end ?? []) listener()
  })
  return req
}
function makeRes() {
  const res = { status: undefined, headers: undefined, body: undefined }
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers }
  res.end = (body) => { res.body = body }
  return res
}

// Guards first: the route is destructive, so everything it refuses must be refused
// before any path is touched.
const route = routes.get(host.ROUTE).handler
let guardRes = makeRes()
await route(makeReq({ method: 'GET', headers: { [host.HEADER]: '1' } }), guardRes)
check('host: refuses a non-POST', guardRes.status === 405, String(guardRes.status))

guardRes = makeRes()
await route(makeReq({ body: JSON.stringify({ sessionId: SESSION }) }), guardRes)
check('host: refuses a request without the guard header', guardRes.status === 403, String(guardRes.status))

guardRes = makeRes()
await route(makeReq({ headers: { [host.HEADER]: '1' }, body: '{' }), guardRes)
check('host: refuses a malformed body', guardRes.status === 400, String(guardRes.status))

// Path traversal is the one that would be catastrophic: prove it is refused by
// id shape AND that nothing outside the sessions root is reachable.
const escapeDir = path.join(dshHome, 'escape')
fs.mkdirSync(escapeDir, { recursive: true })
fs.writeFileSync(path.join(escapeDir, 'keep.txt'), 'keep')
let escapeError
try {
  await host.deleteSession(hostCtx, '../../escape')
} catch (error) {
  escapeError = error
}
check('host: refuses a traversal id', escapeError !== undefined, String(escapeError?.message))
check('host: nothing outside the root was touched', fs.existsSync(path.join(escapeDir, 'keep.txt')))
check('host: variant spellings cover both forms', host.idVariants(`session-${SESSION}`).length === 2 && host.idVariants(`session-${SESSION}`).includes(SESSION), JSON.stringify(host.idVariants(`session-${SESSION}`)))
check('host: containment rejects a sibling', host.isInside(slugA, path.join(dshHome, 'sessions', 'other')) === false)
check('host: finds both id spellings on disk', host.findSessionDirs(SESSION).length === 2, JSON.stringify(host.findSessionDirs(SESSION)))

// The real delete.
const deleteRes = makeRes()
await route(makeReq({ headers: { [host.HEADER]: '1' }, body: JSON.stringify({ sessionId: SESSION }) }), deleteRes)
const report = JSON.parse(deleteRes.body ?? '{}')
check('host: reports success', deleteRes.status === 200 && report.ok === true, String(deleteRes.body))
check('host: stopped the running agent', report.stopped === true && idleResolved === 'idle', JSON.stringify({ stopped: report.stopped, idleResolved }))
check('host: flushed the live session before deleting', flushed.length === 1 && report.flushed === true, JSON.stringify(flushed))
check('host: removed the prefixed log directory', !fs.existsSync(prefixedDir))
check('host: removed the raw-uuid log directory', !fs.existsSync(rawDir))
check('host: left the unrelated session alone', fs.existsSync(path.join(survivorDir, 'session.jsonl.zstd')))
check('host: removed the projection row', projectionTable.get(SESSION) === undefined && report.projectionRemoved === true, String(projectionTable.get(SESSION)))
check('host: left the other projection row alone', projectionTable.get(OTHER) !== undefined)
check('host: dropped the session from its workspace', workspaceTable.get('ws-1')?.sessionIds?.join(',') === OTHER, JSON.stringify(workspaceTable.get('ws-1')))
check('host: dropped the session from the archive set', globalState.archivedSessionIds.join(',') === '', JSON.stringify(globalState.archivedSessionIds))
check('host: reports the workspace cleanup', report.workspaceRemoved === true, String(report.workspaceRemoved))

// A session that is already gone is a 404, not a silent success — the client has
// to be able to tell "nothing to do" from "done".
const ABSENT = '00000000-0000-0000-0000-000000000000'
const missingRes = makeRes()
await route(makeReq({ headers: { [host.HEADER]: '1' }, body: JSON.stringify({ sessionId: ABSENT }) }), missingRes)
check('host: a session with no rows and no log is not found', missingRes.status === 404, String(missingRes.body))

process.env.DSH_HOME = previousHome
fs.rmSync(dshHome, { recursive: true, force: true })
delete globalThis.fetch

// --- 6. combo delivery shape --------------------------------------------------
// The browser never receives this file alone: every plugin is concatenated into
// ONE classic script, each source followed by ";\n" (client-modules'
// buildComboScript). Evaluate that exact shape — a single-file harness cannot see
// an import-time failure that only the concatenation produces.
const ownSource = fs.readFileSync(path.join(PKG, 'src', 'client.js'), 'utf8')
const sibling = 'window.__ModuleLoader__.load({ id: "@local/sibling", factory: () => ({ apply() {} }) });'
const loaded = []
const comboWindow = {
  __ModuleLoader__: {
    load(spec) {
      if (loaded.includes(spec.id)) throw new Error(`duplicate module id: ${spec.id}`)
      loaded.push(spec.id)
    }
  }
}
let comboError
try {
  new Function('window', `${ownSource};\n${sibling};\n`)(comboWindow)
} catch (error) {
  comboError = error
}
check('combo: evaluates in the real concatenated shape', comboError === undefined, comboError?.message)
check('combo: registers each module exactly once', loaded.join(',') === 'dsh-edit-retry,@local/sibling', loaded.join(','))

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
