import { expect, test } from 'claude-code/testing'

import { BRANCHES, MOVE_SH, checkForUpdate } from '../hooks/updater'

// A stand-in for the engine: GitHub says `latest`, the CLI reports `installed`
// from a marketplace of `source`, and every command run is recorded.
function engine(o: { latest?: string; installed?: string; source?: string; ref?: string | null; env?: Record<string, string>; checkedAt?: number; updateExit?: number; addExit?: number; installFailsOnce?: boolean; installFails?: number; missingBinaries?: string[] } = {}) {
  const runs: string[][] = []
  const fetched: string[] = []
  let installed = o.installed ?? '0.5.0'
  let installFails = o.installFails ?? (o.installFailsOnce ? 1 : 0)
  const toasts: string[] = []
  const statuses: string[] = []
  const store = new Map<string, unknown>(o.checkedAt ? [['updateCheckedAt', o.checkedAt]] : [])
  const $ = {
    env: { get: async (name: string) => o.env?.[name] },
    clock: { now: async () => 10 * 24 * 60 * 60 * 1000 },
    store: { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => void store.set(k, v) },
    http: { fetch: async (url: string) => {
      fetched.push(url)
      return { ok: true, status: 200, headers: {}, text: JSON.stringify({ version: o.latest ?? '0.6.0' }) }
    } },
    ui: { toast: (t: string) => void toasts.push(t), status: (t: string | undefined) => void statuses.push(t ?? '') },
    process: {
      run: async (argv: string[]) => {
        if (o.missingBinaries?.includes(argv[0]!)) throw new Error('ENOENT')
        runs.push(argv)
        const args = argv.slice(1).join(' ')
        if (args === 'plugin marketplace list --json') return { exitCode: 0, stderr: '', stdout: JSON.stringify([{ name: 'thenoetrevino', source: o.source ?? 'git', url: 'https://github.com/TheNoeTrevino/claude-show-your-work.git', ref: o.ref === null ? undefined : o.ref ?? 'main' }]) }
        if (args === 'plugin list --json') return { exitCode: 0, stderr: '', stdout: JSON.stringify([{ id: 'show-your-work@thenoetrevino', scope: 'user', version: installed }]) }
        if (args.startsWith('plugin update')) return { exitCode: o.updateExit ?? 0, stderr: '', stdout: '' }
        if (args.startsWith('plugin marketplace add') && args.includes('#')) return { exitCode: o.addExit ?? 0, stderr: '', stdout: '' }
        if (args.startsWith('plugin install') && installFails > 0) {
          installFails -= 1
          return { exitCode: 1, stderr: '', stdout: '' }
        }
        if (args.startsWith('plugin install')) installed = o.latest ?? '0.6.0'
        return { exitCode: 0, stderr: '', stdout: '' }
      },
    },
  }

  return { $: $ as never, runs, toasts, statuses, store, fetched }
}
const args = (runs: string[][]) => runs.map(r => r.slice(1).join(' '))

test('a newer version on GitHub gets installed quietly, for the next session', async () => {
  const e = engine()
  await checkForUpdate(e.$, '0.5.0')
  expect(args(e.runs)).toEqual([
    'plugin marketplace list --json',
    'plugin list --json',
    'plugin marketplace update thenoetrevino',
    'plugin update show-your-work@thenoetrevino --scope user',
  ])
  expect(e.toasts.length).toBe(0)
  // Installed: a line under the prompt says a restart picks it up.
  expect(e.statuses).toEqual(['show-your-work 0.6.0 is ready. Restart Claude Code to use it.'])
})

test('nothing is installed when GitHub has the same version', async () => {
  const e = engine({ latest: '0.5.0' })
  await checkForUpdate(e.$, '0.5.0')
  expect(args(e.runs)).toEqual(['plugin marketplace list --json'])
})

test('it checks at most once a day', async () => {
  const e = engine({ checkedAt: 10 * 24 * 60 * 60 * 1000 - 60_000 })
  await checkForUpdate(e.$, '0.5.0')
  expect(e.runs.length).toBe(0)
})

test('SHOW_YOUR_WORK_AUTO_UPDATE=0 turns it off', async () => {
  const e = engine({ env: { SHOW_YOUR_WORK_AUTO_UPDATE: '0' } })
  await checkForUpdate(e.$, '0.5.0')
  expect(e.runs.length).toBe(0)
})

test('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC turns it off', async () => {
  const e = engine({ env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } })
  await checkForUpdate(e.$, '0.5.0')
  expect(e.runs.length).toBe(0)
})

test('an install pinned to a release tag stays on it', async () => {
  const e = engine({ source: 'git', ref: 'v0.5.15' })
  await checkForUpdate(e.$, '0.5.0')
  expect(args(e.runs)).toEqual(['plugin marketplace list --json'])
})

test('both channels read the fork\'s main branch', async () => {
  const stable = engine()
  await checkForUpdate(stable.$, '0.5.0')
  expect(stable.fetched[0]!.includes('TheNoeTrevino/claude-show-your-work/main/.claude-plugin/plugin.json')).toBe(true)
  const latest = engine()
  await checkForUpdate(latest.$, '0.5.0', BRANCHES.latest)
  expect(latest.fetched[0]!.includes('TheNoeTrevino/claude-show-your-work/main/.claude-plugin/plugin.json')).toBe(true)
  expect(args(latest.runs)).toContain('plugin update show-your-work@thenoetrevino --scope user')
})

test('an install on no branch counts as main and updates in place', async () => {
  const e = engine({ ref: null })
  await checkForUpdate(e.$, '0.5.0')
  expect(e.runs.some(r => r[0] === 'perl')).toBe(false)
  expect(args(e.runs)).toContain('plugin update show-your-work@thenoetrevino --scope user')
})

test('a plugin loaded from a folder is never updated', async () => {
  const e = engine({ source: 'directory' })
  await checkForUpdate(e.$, '0.5.0')
  expect(args(e.runs)).toEqual(['plugin marketplace list --json'])
})

test('already fetched but not restarted: nothing more is done', async () => {
  const e = engine({ installed: '0.6.0' })
  await checkForUpdate(e.$, '0.5.0')
  expect(args(e.runs)).toEqual(['plugin marketplace list --json', 'plugin list --json'])
  expect(e.toasts.length).toBe(0)
})

test('a failed update says nothing to the user', async () => {
  const e = engine({ updateExit: 1 })
  await checkForUpdate(e.$, '0.5.0')
  expect(e.toasts.length).toBe(0)
})

test('when claude is not on the PATH it is found where it is usually installed', async () => {
  const e = engine({ missingBinaries: ['claude'] })
  await checkForUpdate(e.$, '0.5.0')
  expect(e.runs[0]![0]!.endsWith('/claude')).toBe(true)
  expect(args(e.runs)).toContain('plugin update show-your-work@thenoetrevino --scope user')
})

test('an old no to updates (0.5.12, 0.5.16) no longer stops them', async () => {
  for (const [key, value] of [['updatesOff', true], ['consent', { updates: false, stats: true }]] as const) {
    const e = engine({ latest: '0.6.1' })
    e.store.set(key, value)
    await checkForUpdate(e.$, '0.6.0', BRANCHES.stable)
    expect(e.fetched.length).toBe(1)
  }
})
