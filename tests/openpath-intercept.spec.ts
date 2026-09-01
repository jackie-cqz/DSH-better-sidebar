import { describe, expect, it } from 'vitest'
import { registerOpenPathInterception } from '../src/client/intercept.tsx'
import {
  wrapOpenWorkspacePath,
  type OpenPathInterceptDeps,
  type OpenWorkspacePathRequest,
  type OpenWorkspacePathResult,
  type OpenWorkspacePathService,
} from '../src/client/openpath-intercept.ts'
import { createSidebarStore } from '../src/client/state.ts'
import type { Context } from '../src/context-types.ts'

describe('open-path interception', () => {
  /** A minimal fake of the generated remote.session namespace. */
  const service = (
    result: OpenWorkspacePathResult = { ok: true, value: { opened: true } },
  ): OpenWorkspacePathService & { calls: OpenWorkspacePathRequest[] } => {
    const calls: OpenWorkspacePathRequest[] = []
    return {
      calls,
      async openWorkspacePath(request) {
        calls.push(request)
        return result
      },
    }
  }

  const deps = (overrides: Partial<OpenPathInterceptDeps> = {}): OpenPathInterceptDeps & {
    sidebar: string[]
    revealed: string[]
  } => {
    const sidebar: string[] = []
    const revealed: string[] = []
    return {
      sidebar,
      revealed,
      takeoverEnabled: () => true,
      currentSessionId: () => 's1',
      openInSidebar: (path, sessionId) => { sidebar.push(`${sessionId}:${path}`) },
      revealInExplorer: (path, sessionId) => { revealed.push(`${sessionId}:${path}`) },
      ...overrides,
    }
  }

  it('routes an intercepted Remote open into the sidebar and returns a valid success envelope', async () => {
    const remote = service()
    const d = deps()
    const restore = wrapOpenWorkspacePath(remote, d)
    await expect(remote.openWorkspacePath({ path: '/abs/a.ts' }))
      .resolves.toEqual({ ok: true, value: { opened: true } })
    expect(remote.calls).toEqual([])
    expect(d.sidebar).toEqual(['s1:/abs/a.ts'])
    restore()
  })

  it('falls through with the exact request when the takeover is disabled', async () => {
    const remote = service()
    const d = deps({ takeoverEnabled: () => false })
    const restore = wrapOpenWorkspacePath(remote, d)
    const request = { path: '/abs/a.ts' }
    await expect(remote.openWorkspacePath(request))
      .resolves.toEqual({ ok: true, value: { opened: true } })
    expect(remote.calls).toHaveLength(1)
    expect(remote.calls[0]).toBe(request)
    expect(d.sidebar).toEqual([])
    restore()
  })

  it('falls through when no session is current (nothing to scope the editor load to)', async () => {
    const remote = service()
    const d = deps({ currentSessionId: () => undefined })
    const restore = wrapOpenWorkspacePath(remote, d)
    await remote.openWorkspacePath({ path: '/abs/a.ts' })
    expect(remote.calls).toEqual([{ path: '/abs/a.ts' }])
    expect(d.sidebar).toEqual([])
    restore()
  })

  it('reads the current session for every call', async () => {
    const remote = service()
    let current = 's1'
    const d = deps({ currentSessionId: () => current })
    const restore = wrapOpenWorkspacePath(remote, d)
    await remote.openWorkspacePath({ path: '/abs/a.ts' })
    current = 's2'
    await remote.openWorkspacePath({ path: '/abs/b.ts' })
    expect(d.sidebar).toEqual(['s1:/abs/a.ts', 's2:/abs/b.ts'])
    restore()
  })

  it('routes the show-in-folder gesture to the explorer and still returns Remote success', async () => {
    const remote = service()
    const d = deps()
    const restore = wrapOpenWorkspacePath(remote, d)
    await expect(remote.openWorkspacePath({ path: '/workspace/.' }))
      .resolves.toEqual({ ok: true, value: { opened: true } })
    expect(d.sidebar).toEqual([])
    expect(d.revealed).toEqual(['s1:/workspace/.'])
    expect(remote.calls).toEqual([])
    restore()
  })

  it('restores the original Remote method on dispose (HMR-safe)', async () => {
    const remote = service()
    const d = deps()
    const original = remote.openWorkspacePath
    const restore = wrapOpenWorkspacePath(remote, d)
    expect(remote.openWorkspacePath).not.toBe(original)
    restore()
    expect(remote.openWorkspacePath).toBe(original)
    await remote.openWorkspacePath({ path: '/abs/a.ts' })
    expect(remote.calls).toEqual([{ path: '/abs/a.ts' }])
  })

  it('preserves the original Remote failure envelope when interception declines', async () => {
    const failure: OpenWorkspacePathResult = {
      ok: false,
      error: { code: 'gateway/internal', message: 'host refused', details: {} },
    }
    const remote = service(failure)
    const d = deps({ takeoverEnabled: () => false })
    const restore = wrapOpenWorkspacePath(remote, d)
    await expect(remote.openWorkspacePath({ path: '/abs/a.ts' })).resolves.toBe(failure)
    restore()
  })
})

describe('open-path interception wiring', () => {
  it('registerOpenPathInterception wraps the real alpha.3 Remote face and honors every gate', async () => {
    const opened: Array<Record<string, unknown>> = []
    const calls: OpenWorkspacePathRequest[] = []
    const sessionRemote: OpenWorkspacePathService = {
      async openWorkspacePath(request) {
        calls.push(request)
        return { ok: true, value: { opened: true } }
      },
    }
    let current: string | undefined = 's1'
    const ctx = {
      sessions: {
        list: { getSnapshot: () => ({ current, byId: { s1: { cwd: '/w' } } }) },
      },
      remote: { session: sessionRemote },
      get: (name: string) => name === 'betterSidebar'
        ? { openTab: (seed: unknown) => { opened.push(seed as Record<string, unknown>) } }
        : undefined,
    } as unknown as Context
    const store = createSidebarStore()
    const original = ctx.remote.session.openWorkspacePath
    const restore = registerOpenPathInterception(ctx, store)

    // Default prefs: the takeover routes the already-resolved path into the
    // editor and returns the Remote success envelope ui-chat reads.
    await expect(ctx.remote.session.openWorkspacePath({ path: '/w/src/a.ts' }))
      .resolves.toEqual({ ok: true, value: { opened: true } })
    expect(opened).toEqual([{
      type: 'editor',
      title: 'a.ts',
      path: '/w/src/a.ts',
      id: 'editor:/w/src/a.ts',
    }])
    expect(calls).toEqual([])

    // Preference off, editor disabled, external provider suspension, and no
    // selected session all preserve the original Host RPC path.
    store.setPrefs({ ...store.getPrefs(), interceptOpenPath: false })
    await ctx.remote.session.openWorkspacePath({ path: '/w/src/b.ts' })

    store.setPrefs({ ...store.getPrefs(), interceptOpenPath: true, tabsEnabled: { editor: false } })
    await ctx.remote.session.openWorkspacePath({ path: '/w/src/c.ts' })

    store.setPrefs({ ...store.getPrefs(), tabsEnabled: {} })
    store.setSuspended(true)
    await ctx.remote.session.openWorkspacePath({ path: '/w/src/d.ts' })

    store.setSuspended(false)
    current = undefined
    await ctx.remote.session.openWorkspacePath({ path: '/w/src/e.ts' })

    expect(calls).toEqual([
      { path: '/w/src/b.ts' },
      { path: '/w/src/c.ts' },
      { path: '/w/src/d.ts' },
      { path: '/w/src/e.ts' },
    ])
    expect(opened).toHaveLength(1)

    restore()
    expect(ctx.remote.session.openWorkspacePath).toBe(original)
  })
})
