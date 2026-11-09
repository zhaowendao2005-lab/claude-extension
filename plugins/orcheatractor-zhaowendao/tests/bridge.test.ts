import { expect, test } from 'claude-code/testing'
import { register } from '../hooks/register'

function harness() {
  const hooks: { name: string; filter: any; fn: any }[] = []
  const on: any = (name: string, filter: any, fn?: any) => {
    hooks.push({ name, filter: fn ? filter : undefined, fn: fn ?? filter })
    return { catch: () => {} }
  }
  register(on, {} as any)
  const db = new Map<string, any>(), files = new Map<string, string>()
  let submitted = 0, serial = 0, session = 'session-a'
  const pathOf = (k: string) => k
  const $: any = {
    plugin: { root: '/plugin' },
    session: { id: async () => session, append: async () => {}, messages: async () => [] },
    env: { get: async (k: string) => k === 'HOME' ? '/home/test' : '' },
    fs: {
      read: async (p: string) => files.get(pathOf(p)) ?? '',
      write: async (p: string, s: string) => { files.set(pathOf(p), s) },
      exists: async (p: string) => files.has(pathOf(p)) || [...files.keys()].some(k => k.startsWith(`${p}/`)),
      list: async (d: string) => [...new Set([...files.keys()].filter(k => k.startsWith(`${d}/`)).map(k => k.slice(d.length + 1).split('/')[0]!))]
        .map(name => ({ name })),
    },
    command: { register: async () => {} },
    tool: { register: async () => {}, call: async () => ({ success: true }) },
    ui: { status: async () => {} },
    clock: { every: () => {} },
    prompt: { submit: async () => { submitted++ } },
    agent: { list: async () => [], spawn: async () => ({ agentId: `agent-${++serial}`, model: 'sonnet' }) },
    process: {
      run: async (args: string[]) => {
        if (args[0] === 'git') return { exitCode: 1, stdout: '', stderr: 'no repo' }
        if (args.includes('-c')) return { exitCode: 0, stdout: '', stderr: '' }
        const value = (k: string) => args[args.indexOf(k) + 1]
        const action = value('--action'), id = value('--id')
        if (action === 'list') return { exitCode: 0, stdout: JSON.stringify([...db.values()].map(r => ({ id: r.id, ownerSessionId: r.ownerSessionId, status: r.status, updatedAt: r.updatedAt, deliverDir: r.deliverDir }))), stderr: '' }
        if (action === 'load') return { exitCode: 0, stdout: JSON.stringify(db.get(id) ?? null), stderr: '' }
        if (action === 'save') {
          const old = db.get(id), expected = value('--expected'), r = JSON.parse(value('--data'))
          if ((expected === 'new' && old) || (expected !== 'new' && old?.revision !== Number(expected))) return { exitCode: 1, stdout: '', stderr: 'store: revision conflict' }
          db.set(id, r); return { exitCode: 0, stdout: 'null', stderr: '' }
        }
        throw new Error(`unexpected process ${args.join(' ')}`)
      },
    },
  }
  const emit = async (name: string, e: any = {}) => {
    let result: any
    for (const h of hooks.filter(h => h.name === name && (!h.filter || Object.entries(h.filter).every(([k, v]) => e[k] === v)))) result = await h.fn($, e, async () => ({}))
    return result
  }
  const budget = async (a: any) => {
    const raw = await hooks.find(h => h.name === 'tool.call' && h.filter)?.fn($, { ...a }, async () => ({}))
    return { text: String(raw?.result?.[0]?.text ?? ''), isError: raw?.isError, raw }
  }
  const run = () => [...db.values()][0]
  const cards = () => { const d = run().deliverDir; files.set(`${d}/cards/a.md`, 'task a'); return `${d}/cards/a.md` }
  return { $, emit, budget, run, db, files, hooks, cards, submitted: () => submitted, setSession: (s: string) => { session = s } }
}

test('start creates a timestamped task directory at the workspace root', async () => {
  const h = harness(); await h.emit('session.start', { cwd: '/ws' })
  const text = await h.budget({ action: 'start', duration: '5m', task: '修登录' })
  expect(text.text).toContain('/ws/')
  expect(h.run().deliverDir.startsWith('/ws/')).toBe(true)
  expect(h.files.has(`${h.run().deliverDir}/cards/.gitkeep`)).toBe(true)
  expect(h.run().status).toBe('running')
})

test('Ask holds the clock through next(); worker activity does not resume it', async () => {
  const h = harness(); await h.emit('session.start', { cwd: '/ws' }); await h.budget({ action: 'start', duration: '5m' })
  const hook = h.hooks.find(x => x.name === 'tool.call' && !x.filter)!
  try {
    await hook.fn(h.$, { tool: 'AskUserQuestion', toolUseId: 'ask1' }, async () => {
      expect(h.run().pauses['waiting_user:ask1']).toBe(1)
      await h.emit('tool.call', { tool: 'Read', agentId: 'external', toolUseId: 'r' })
      expect(Object.keys(h.run().pauses).length).toBe(1)
      throw new Error('cancelled')
    })
  } catch {}
  expect(Object.keys(h.run().pauses).length).toBe(0)
})

test('interrupt settles workers to ended instead of pretending success', async () => {
  const h = harness(); await h.emit('session.start', { cwd: '/ws' }); await h.budget({ action: 'start', duration: '5m' })
  const dir = h.run().deliverDir; h.files.set(`${dir}/cards/a.md`, 'task')
  await h.budget({ action: 'dispatch', workers: [{ label: 'a', model: 'sonnet', card_path: `${dir}/cards/a.md`, files: ['/ws/out/a.json'] }] })
  expect(Object.values(h.run().attempts)[0].status).toBe('running')
  await h.emit('turn.abort')
  const attempt: any = Object.values(h.run().attempts)[0]
  expect(attempt.status).toBe('ended')
  expect(attempt.stopConfirmed).toBe(true) // fake host confirms stop
  expect((await h.budget({ action: 'close' })).isError).toBe(true)
})

test('delivery gate blocks unverified edits and accepts an explicit waiver', async () => {
  const h = harness(); await h.emit('session.start', { cwd: '/ws' }); await h.budget({ action: 'start', duration: '5m' })
  await h.emit('tool.call', { tool: 'Write', file_path: '/ws/a.ts', toolUseId: 'w1' })
  expect((await h.budget({ action: 'close' })).isError).toBe(true)
  await h.emit('tool.call', { tool: 'Bash', command: 'tsc --noEmit', toolUseId: 'c1' })
  await h.emit('classic.PostToolUse', { tool_name: 'Bash', toolUseId: 'c1', tool_response: { exitCode: 0 } })
  const closed = await h.budget({ action: 'close' })
  expect(closed.isError).toBe(undefined)
  expect(h.run().status).toBe('completed')
  expect(h.files.has(`${h.run().deliverDir}/manifest.json`)).toBe(true)
})

test('a new session continues by path: cycle restarts, finished work is kept', async () => {
  const h = harness(); await h.emit('session.start', { cwd: '/ws' }); await h.budget({ action: 'start', duration: '5m' })
  const dir = h.run().deliverDir; h.files.set(`${dir}/cards/a.md`, 'task')
  await h.budget({ action: 'dispatch', workers: [{ label: 'a', model: 'sonnet', card_path: `${dir}/cards/a.md`, files: ['/ws/out/a.json'] }] })
  await h.emit('turn.complete', { agentId: 'agent-1', usage: { model: 'actual' } })
  await h.emit('session.end', { reason: 'other' })
  expect(h.run().status).toBe('interrupted')
  const finished: any = Object.values(h.run().attempts)[0]
  expect(finished.status).toBe('completed')
  const completedAttempts = Object.keys(h.run().attempts).length

  h.files.set(`${dir}/state.sqlite3`, '')
  h.setSession('session-b')
  await h.emit('session.start', { cwd: '/ws' })
  const text = await h.budget({ action: 'recover', run: dir })
  expect(text.text).toContain('已完成任务')
  expect(text.text).toContain('cycle=1')
  expect(h.run().ownerSessionId).toBe('session-b')
  expect(h.run().phase).toBe('pre-explore')
  expect(Object.keys(h.run().attempts).length).toBe(completedAttempts)
  // completed task is not re-dispatched when the same label is offered again
  const again = await h.budget({ action: 'dispatch', workers: [{ label: 'a', model: 'sonnet', card_path: `${dir}/cards/a.md`, files: ['/ws/out/a.json'] }] })
  expect(again.isError).toBe(true)
})

test('dispatch preflights the batch before spawning anything', async () => {
  const h = harness(); await h.emit('session.start', { cwd: '/ws' }); await h.budget({ action: 'start', duration: '5m' })
  let spawned = 0; h.$.agent.spawn = async () => ({ agentId: `x-${++spawned}`, model: 'sonnet' })
  const dir = h.run().deliverDir; h.files.set(`${dir}/cards/a.md`, 'task')
  const bad = await h.budget({ action: 'dispatch', workers: [
    { label: 'a', model: 'sonnet', card_path: `${dir}/cards/a.md`, files: ['/ws/shared'] },
    { label: 'b', model: 'sonnet', card_path: `${dir}/cards/a.md`, files: ['/ws/shared'] },
  ] })
  expect(bad.isError).toBe(true); expect(spawned).toBe(0)
  const missing = await h.budget({ action: 'dispatch', workers: [{ label: 'a', model: 'sonnet', card_path: `${dir}/cards/nope.md`, files: ['/ws/out/a.json'] }] })
  expect(missing.isError).toBe(true); expect(spawned).toBe(0)
})
