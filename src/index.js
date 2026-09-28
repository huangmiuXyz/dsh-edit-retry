/**
 * Edit-and-retry, host half.
 *
 * This plugin is client-only. `sessions.fork`, `uiWorkspace.openSession` and
 * `session.prompt` all live on client services, so there is nothing to do on
 * the host. The row exists so the Loader instantiates the package — which is
 * also what makes the client-modules scan discover it and serve
 * `exports["./client"]` to the browser.
 */
export function apply() {}
