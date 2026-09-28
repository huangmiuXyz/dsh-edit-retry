// Offline self-check for the edit-retry plugin.
//
// The fakes here mirror the REAL contracts, because a fake that invents a shape
// tests nothing: an earlier revision read `node.content` / `node.seq` and this
// harness happily agreed, while the live Chat view node carries the message
// record as `node.data` (`chatNode(context, kind, anchorSeq, state)`).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repo root, resolved from this file so the check runs from any checkout. */
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
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
// shipped bubble is its single child.
check('render: only child is the shipped bubble', tree.children[0]?.type === fakeShipped, String(tree.children[0]?.type?.name))
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
  stateCalls.some((call) => call?.left === 1200 - 168 && call?.top === 800 - 36),
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

// The open menu renders one item, and choosing it enters the editor.
// The shim's useState order is editing, busy, error, menu.
useStateScript = [false, false, undefined, { left: 10, top: 20 }]
const menuTree = shim({ node: userNode(8, [text('你好')]), sessionId: 'session-x', t: fakeT, useWorkspaces })
const menuBox = resolve(menuTree.children[1])
check('menu: renders the popup when open', menuBox?.props?.className === 'dsh-edit-retry-menu', String(menuBox?.props?.className))
check('menu: positioned at the pointer', menuBox?.props?.style?.left === '10px' && menuBox?.props?.style?.top === '20px', JSON.stringify(menuBox?.props?.style))
const menuItem = resolve((menuBox?.children ?? [])[0])
check('menu: offers the zh edit action', menuItem?.children?.[0] === '编辑并重试', JSON.stringify(menuItem?.children))
stateCalls.length = 0
menuItem?.props?.onClick?.()
check('menu: choosing the item enters the editor', stateCalls.includes(true), JSON.stringify(stateCalls))

// Closed by default: no popup competes with the shipped bubble.
useStateScript = []
const closedTree = shim({ node: userNode(8, [text('你好')]), sessionId: 'session-x', t: fakeT, useWorkspaces })
check('menu: stays closed until asked', closedTree.children[1] === null, JSON.stringify(closedTree.children.length))

// --- 5. submit path: fork vs fresh session, and the resend ---------------------
const forkCalls = []
const createCalls = []
const promptCalls = []
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
const sessions = {
  fork: (options) => {
    forkCalls.push(options)
    return Promise.resolve('session-child')
  },
  create: (options) => {
    createCalls.push(options ?? {})
    return Promise.resolve('session-fresh')
  },
  binding: () => ({
    eventSource: {
      getSnapshot: () => ({ entries: windowEntries, hasMore: windowHasMore, revision: 1, change: { kind: 'append', entries: [] } })
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
async function submitVia(seq, value, cwd, workspaceId) {
  sourceWorkspaceId = workspaceId
  useStateScript = [true]
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

// A later prompt forks at the event immediately before the message, so the child
// inherits the already-drained inbox and cannot re-send anything.
forkCalls.length = 0
createCalls.length = 0
promptCalls.length = 0
await submitVia(21, '第二句')
check('submit: later prompt forks instead of creating', forkCalls.length === 1 && createCalls.length === 0, JSON.stringify({ forkCalls, createCalls }))
check('submit: forks the source session', forkCalls[0]?.sessionId === 'session-1', JSON.stringify(forkCalls[0]))
check('submit: forks at the message predecessor', forkCalls[0]?.atSeq === 20, String(forkCalls[0]?.atSeq))
check('submit: bumps the inherited title', forkCalls[0]?.increaseTitle === true, String(forkCalls[0]?.increaseTitle))

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
