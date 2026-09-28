/**
 * Edit-and-retry, host half.
 *
 * The retry itself is client-only: `sessions.fork`, `uiWorkspace.openSession` and
 * `session.prompt` all live on client services. This half exists for the one thing
 * the client cannot do — **delete the source session**. The row is also what makes
 * the client-modules scan discover the package and serve `exports["./client"]`.
 *
 * DSH offers client plugins no way to delete a session. The workspace surface
 * exposes `archiveSession` (reversible, the session stays on disk), the agent
 * protocol's `session_delete` belongs to external ACP agents, and the session
 * store has no public remove API at all. So deletion has to be assembled here,
 * against the host's own services and the on-disk log, and the client reaches it
 * over the HTTP route registered below.
 *
 * The order below is not arbitrary. A half-deleted session is worse than an
 * undeleted one: if the log survives but the workspace accounting does not, the
 * session falls out of its group into Ungrouped; if the accounting survives but
 * the log does not, the sidebar keeps a row that can never open. So the log is
 * removed and CONFIRMED gone before any accounting is touched.
 *
 * This walks into three internals — `sessions.store`/`detachEntered`,
 * `storageDomain` table shapes, and the on-disk log layout. Each is probed with a
 * feature check and skipped rather than assumed, so a DSH upgrade degrades this to
 * a partial or refused delete instead of a crash.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Route the client half posts to. Namespaced so it cannot collide. */
const ROUTE = '/dsh-edit-retry/session/delete'
/**
 * Header the client must send. A cross-origin page can POST a "simple" request
 * without a preflight, so requiring a custom header is what actually forces one —
 * the browser then blocks the call because this server answers no CORS preflight.
 * Same-origin callers (our own client half) are unaffected.
 */
const HEADER = 'x-dsh-edit-retry'
/** A session id we are willing to name in a filesystem path. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** How long to wait for a cancelled agent to settle before deleting anyway. */
const QUIESCE_MS = 15000

class DeleteError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

// --- paths --------------------------------------------------------------------

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function sessionsRoot() {
  return path.join(dshHome(), 'sessions')
}

/**
 * Whether `candidate` really sits inside `root`.
 *
 * The id charset already excludes separators and `..`, so this is the second lock
 * on the same door: it is the check that still holds if that regex is ever
 * loosened, and it is what makes the recursive remove below defensible.
 */
function isInside(root, candidate) {
  const rel = path.relative(root, candidate)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * Every spelling of one session id.
 *
 * The id is spelled two ways across the stores: raw (`<uuid>`) in the JSONL log
 * directory, and `session-<uuid>` in workspace and projection rows. Cleaning one
 * spelling only would leave the other behind to resurrect the session.
 */
function idVariants(sessionId) {
  const out = new Set([sessionId])
  if (sessionId.startsWith('session-')) out.add(sessionId.slice('session-'.length))
  else out.add(`session-${sessionId}`)
  return [...out].filter((id) => SAFE_ID.test(id))
}

/** Every `~/.dsh/sessions/<slug>/<id>/` directory matching this id, both spellings. */
function findSessionDirs(sessionId) {
  const root = sessionsRoot()
  let slugs
  try {
    slugs = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue
    for (const variant of idVariants(sessionId)) {
      const candidate = path.join(root, slug.name, variant)
      if (!isInside(root, candidate)) continue
      try {
        if (fs.statSync(candidate).isDirectory() && !found.includes(candidate)) found.push(candidate)
      } catch {
        /* not this slug; keep scanning */
      }
    }
  }
  return found
}

function removeSessionDirs(sessionId) {
  let removed = 0
  for (const dir of findSessionDirs(sessionId)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      removed += 1
    } catch {
      /* the verification pass below is what reports a failure */
    }
  }
  return removed
}

// --- live session teardown ----------------------------------------------------

/**
 * Stop a running agent on this session and wait for it to settle.
 *
 * Deletion is not a graceful shutdown, but a driver still writing into the log
 * while we remove the directory can re-create it after the sweep — so cancel
 * first, then wait. The wait is time-boxed: a wedged driver must not block the
 * delete forever.
 */
async function stopAgentIfRunning(ctx, sessionId) {
  const agents = ctx.get('agents')
  if (agents === undefined || typeof agents.get !== 'function') return false
  const agent = agents.get(sessionId)
  if (agent === undefined || agent === null) return false
  if (typeof agent.cancel === 'function') {
    try {
      agent.cancel({ kind: 'user' })
    } catch {
      /* already settling */
    }
  }
  if (typeof agent.whenIdle === 'function') {
    try {
      await Promise.race([
        agent.whenIdle(),
        new Promise((resolve) => setTimeout(resolve, QUIESCE_MS))
      ])
    } catch {
      /* proceed: the directory sweep is the real guarantee */
    }
  }
  return true
}

/**
 * Flush a live session's pending writes.
 *
 * The persistence layer flushes on `session/disposed`, and that dispose runs after
 * we delete the log — which would write the file straight back. Draining first
 * leaves the later dispose with nothing to re-create.
 */
async function flushSessionIfLive(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (sessions === undefined || typeof sessions.flush !== 'function') return false
  let flushed = false
  for (const variant of idVariants(sessionId)) {
    const session = typeof sessions.get === 'function' ? sessions.get(variant) : undefined
    if (session === undefined || session === null) continue
    try {
      await sessions.flush(session)
      flushed = true
    } catch {
      /* the log is removed regardless */
    }
  }
  return flushed
}

/**
 * Drop the session from the host's in-memory store, so session lists stop
 * returning it and no later flush can re-materialize its files.
 *
 * `detachEntered` is the store's own teardown path — there is no public remove —
 * so it is preferred, and the raw store delete is only the fallback.
 */
function detachLiveSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (sessions === undefined || sessions === null) return false
  let detached = false
  try {
    const store = sessions.store
    for (const variant of idVariants(sessionId)) {
      const entry = store !== undefined && typeof store.get === 'function' ? store.get(variant) : undefined
      if (entry === undefined || entry === null) continue
      if (typeof sessions.detachEntered === 'function') {
        sessions.detachEntered(entry)
        detached = true
      } else if (store !== undefined && typeof store.delete === 'function') {
        store.delete(variant)
        if (entry.session !== undefined && sessions.attachments !== undefined && typeof sessions.attachments.delete === 'function') {
          sessions.attachments.delete(entry.session)
        }
        detached = true
      }
    }
  } catch {
    /* the log removal is what decides whether the session is gone */
  }
  return detached
}

// --- persisted accounting -----------------------------------------------------

/**
 * Remove the session's rows from the opened storage domains.
 *
 * These are the authoritative in-memory state, so clearing them here is what
 * stops the periodic flush from re-publishing a row for a log that no longer
 * exists. Both domains are probed: an absent domain, table or slot is a normal
 * outcome on profiles that do not mount them, not an error.
 */
async function stripStorageDomains(ctx, sessionId, { workspace }) {
  const domains = ctx.get('storageDomain')
  const result = { projection: false, workspace: false }
  if (domains === undefined || domains === null || typeof domains.get !== 'function') return result
  const variants = idVariants(sessionId)

  const projection = domains.get('session_projcache')
  if (projection !== undefined && projection !== null && typeof projection.table === 'function') {
    try {
      const table = projection.table('sessions')
      for (const variant of variants) {
        if (table.get(variant) !== undefined) {
          await table.delete(variant)
          result.projection = true
        }
      }
    } catch {
      /* unit closed or table absent */
    }
  }

  if (!workspace) return result
  const ws = domains.get('workspace')
  if (ws === undefined || ws === null || typeof ws.table !== 'function') return result
  try {
    const table = ws.table('workspaces')
    for (const [workspaceId, record] of table.entries()) {
      if (record === null || typeof record !== 'object' || !Array.isArray(record.sessionIds)) continue
      if (!variants.some((variant) => record.sessionIds.includes(variant))) continue
      await table.put(workspaceId, {
        ...record,
        sessionIds: record.sessionIds.filter((id) => !variants.includes(id))
      })
      result.workspace = true
    }
  } catch {
    /* unit closed or table absent */
  }
  // An archived session has no workspace row left, so the archive set is the only
  // place still naming it — and leaving it there keeps the row in the sidebar's
  // archived view.
  try {
    const global = ws.global
    if (global !== undefined && typeof global.get === 'function' && typeof global.set === 'function') {
      const state = global.get()
      if (state !== null && typeof state === 'object' && Array.isArray(state.archivedSessionIds)) {
        if (variants.some((variant) => state.archivedSessionIds.includes(variant))) {
          await global.set({
            ...state,
            archivedSessionIds: state.archivedSessionIds.filter((id) => !variants.includes(id))
          })
          result.workspace = true
        }
      }
    }
  } catch {
    /* no global slot */
  }
  return result
}

// --- the delete itself --------------------------------------------------------

/**
 * Delete one session end-to-end.
 *
 * Refuses ids it would not put in a path, force-stops a running agent, drains the
 * log, detaches the live entry, removes the log and confirms it is gone, and only
 * then clears the accounting rows.
 */
async function deleteSession(ctx, sessionId) {
  if (typeof sessionId !== 'string' || !SAFE_ID.test(sessionId) || sessionId.includes('..')) {
    throw new DeleteError(`refusing to delete unsafe session id: ${JSON.stringify(sessionId)}`, 400)
  }

  const stopped = await stopAgentIfRunning(ctx, sessionId)
  const flushed = await flushSessionIfLive(ctx, sessionId)
  const detached = detachLiveSession(ctx, sessionId)

  // Log first, and confirm it: only once the files are provably gone is it safe to
  // touch the accounting that decides which group the session appears in.
  const firstPass = removeSessionDirs(sessionId)
  const projection = await stripStorageDomains(ctx, sessionId, { workspace: false })
  // A dispose that was already in flight during the first pass can re-create the
  // directory, so sweep again — once immediately, once after the pending
  // microtask/IO callbacks such a dispose would run in.
  const secondPass = removeSessionDirs(sessionId)
  await new Promise((resolve) => setImmediate(resolve))
  const thirdPass = removeSessionDirs(sessionId)

  const remaining = findSessionDirs(sessionId)
  if (remaining.length > 0) {
    throw new DeleteError(`session log could not be removed: ${remaining.join(', ')}`, 500)
  }

  const ws = await stripStorageDomains(ctx, sessionId, { workspace: true })
  const dirsRemoved = firstPass + secondPass + thirdPass
  const projectionRemoved = projection.projection || ws.projection
  const workspaceRemoved = ws.workspace
  if (dirsRemoved === 0 && !projectionRemoved && !workspaceRemoved) {
    throw new DeleteError(`session not found: ${sessionId}`, 404)
  }
  return { sessionId, stopped, flushed, detached, dirsRemoved, projectionRemoved, workspaceRemoved }
}

// --- http ---------------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // Never let a proxy or the browser cache a destructive response.
    'cache-control': 'no-store'
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 100000) req.destroy()
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('aborted')))
  })
}

async function handleDelete(ctx, req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' })
    return
  }
  if (req.headers === undefined || req.headers === null || req.headers[HEADER] === undefined) {
    sendJson(res, 403, { ok: false, error: `missing ${HEADER} header` })
    return
  }
  let payload = {}
  try {
    const body = await readBody(req)
    if (body) payload = JSON.parse(body)
  } catch {
    sendJson(res, 400, { ok: false, error: 'bad json body' })
    return
  }
  if (payload === null || typeof payload !== 'object') {
    sendJson(res, 400, { ok: false, error: 'bad json body' })
    return
  }
  try {
    sendJson(res, 200, { ok: true, ...(await deleteSession(ctx, payload.sessionId)) })
  } catch (error) {
    const status = error instanceof DeleteError ? error.status : 500
    sendJson(res, status, { ok: false, error: String(error?.message ?? error) })
  }
}

/**
 * Register the delete route.
 *
 * `webServer` is optional — a terminal-only profile never provides it — so when it
 * is absent the route is registered if and when the service appears, instead of
 * holding the plugin's own activation open on a service that will never come.
 */
function registerRoute(ctx) {
  const register = (host, scope) => {
    scope.effect(
      () => host.register({ kind: 'exact', path: ROUTE, handler: (req, res) => handleDelete(ctx, req, res) }),
      'edit-retry: session delete route'
    )
  }
  const server = ctx.get('webServer')
  if (server !== undefined) register(server, ctx)
  else ctx.inject(['webServer'], (scope) => register(scope.webServer, scope))
}

export function apply(ctx) {
  registerRoute(ctx)
}

export { deleteSession, findSessionDirs, idVariants, isInside, ROUTE, HEADER }
