/**
 * Interception of the chat's file-open funnel. DSH 0.1.2-alpha.3 resolves
 * chat-side paths against the current session cwd, then calls
 * `ctx.remote.session.openWorkspacePath({ path })` for tool-row path links,
 * the produced-files row, and prose file mentions alike. Wrapping that one
 * Remote method reroutes those opens into the sidebar editor instead of the
 * Host OS — no DSH modification needed.
 *
 * The wrapper is dependency-free by design (no React / ui-primitives), so
 * the takeover logic is unit-testable and the file stays importable from the
 * test runtime.
 */

/** The request accepted by DSH's `session.openWorkspacePath` Remote method. */
export interface OpenWorkspacePathRequest {
  readonly path: string
}

/** The successful business value returned by the Host native opener. */
export interface OpenWorkspacePathValue {
  readonly opened: true
}

/** The generated Remote client envelope (carrier failures use the error arm). */
export type OpenWorkspacePathResult =
  | { readonly ok: true; readonly value: OpenWorkspacePathValue }
  | { readonly ok: false; readonly error: unknown }

/** The one Remote method the wrapper replaces. */
export interface OpenWorkspacePathService {
  openWorkspacePath(request: OpenWorkspacePathRequest): Promise<OpenWorkspacePathResult>
}

/** Per-call decisions the wrapper needs (wired to the store + ctx in the client half). */
export interface OpenPathInterceptDeps {
  /**
   * Whether to take over this call: the `interceptOpenPath` pref AND the
   * editor tab's own enable switch must both be on (an editor that cannot
   * open must not swallow opens — they fall through to the Host).
   */
  takeoverEnabled(): boolean
  /** The session whose scope the sidebar editor loads the file in (current session). */
  currentSessionId(): string | undefined
  /** Route the open into the sidebar editor (the established openSidebarFile). */
  openInSidebar(path: string, sessionId: string): void
  /** Route a folder-reveal gesture ("Show in folder" passes '.') into the sidebar explorer. */
  revealInExplorer(path: string, sessionId: string): void
}

/**
 * Whether a path is the "Show in folder" folder-reveal gesture. The stock
 * ui-deliverables row passes `'.'` (the session workspace root, resolved by
 * the chat view to `"<cwd>/."`); any path whose final segment is `.` is the
 * same gesture. A directory has no editor content, so these opens must reach
 * the explorer instead of an editor tab.
 */
export function isFolderRevealPath(path: string): boolean {
  if (path === '.' || path === './') return true
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed === '.' || /[\\/]\.$/.test(trimmed)
}

/**
 * Wrap `remote.session.openWorkspacePath`: intercepted calls open the file in
 * the sidebar editor instead of the Host OS and resolve with the same success
 * envelope the generated Remote client returns. Anything that declines falls
 * through to the original method untouched. The one exception is the
 * folder-reveal gesture, which is routed to
 * {@link OpenPathInterceptDeps.revealInExplorer} instead.
 * @param sessionRemote - the generated `remote.session` namespace to wrap.
 * @param deps - per-call takeover decisions.
 * @returns the disposer restoring the original method (HMR-safe).
 */
export function wrapOpenWorkspacePath(
  sessionRemote: OpenWorkspacePathService,
  deps: OpenPathInterceptDeps,
): () => void {
  // Keep the raw method reference (rather than a bound copy), so disposal can
  // restore the exact function that was present when this wrapper registered.
  const original = sessionRemote.openWorkspacePath
  sessionRemote.openWorkspacePath = (request): Promise<OpenWorkspacePathResult> => {
    const { path } = request
    if (deps.takeoverEnabled()) {
      const sessionId = deps.currentSessionId()
      if (sessionId !== undefined) {
        if (isFolderRevealPath(path)) deps.revealInExplorer(path, sessionId)
        else deps.openInSidebar(path, sessionId)
        // ui-chat reads `result.ok` before it considers the open complete. A
        // void result would open the sidebar and then crash the caller.
        return Promise.resolve({ ok: true, value: { opened: true } })
      }
    }
    return original.call(sessionRemote, request)
  }
  return () => {
    sessionRemote.openWorkspacePath = original
  }
}
