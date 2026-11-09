import { expect, test } from 'claude-code/testing'
import {
  buildWorkerPrompt,
  formatDispatchResult,
  normalizeFiles,
  parseDispatch,
  resolveWorkerModel,
  shortModel,
  workerName,
} from '../hooks/lib/dispatch'
import type { CatalogEntry } from '../hooks/lib/models'

const catalog: CatalogEntry[] = [
  { route: 'ccs-claude-openrouter--deepseek/deepseek-v4.1-flash[1M]', label: 'deepseek-flash', description: '' },
  { route: 'ccs-claude-openrouter--z-ai/glm-5.3-flash[1M]', label: 'glm-flash', description: '' },
  { route: 'ccs-claude-antigravity-2--gemini-4-argon[1m]', label: 'gemini-argon', description: '' },
]

test('resolveWorkerModel：完整 route / 唯一子串 / alias / inherit', () => {
  expect(resolveWorkerModel('ccs-claude-openrouter--z-ai/glm-5.3-flash[1M]', catalog)).toEqual({
    ok: true, mode: 'route', route: 'ccs-claude-openrouter--z-ai/glm-5.3-flash[1M]', label: 'glm-flash',
  })
  expect(resolveWorkerModel('deepseek', catalog)).toEqual({
    ok: true, mode: 'route', route: 'ccs-claude-openrouter--deepseek/deepseek-v4.1-flash[1M]', label: 'deepseek-flash',
  })
  expect(resolveWorkerModel('sonnet', catalog)).toEqual({ ok: true, mode: 'alias', alias: 'sonnet', label: 'sonnet' })
  expect(resolveWorkerModel('inherit', catalog)).toEqual({ ok: true, mode: 'inherit', label: 'inherit' })
  expect(resolveWorkerModel('no-such-model', catalog).ok).toBe(false)
})

test('parseDispatch：数组、JSON 字符串、files 归一化、错误', () => {
  const one = parseDispatch([{
    label: 'W1',
    model: 'glm',
    card: '.budget/runs/x/cards/W1.md',
    description: 'tilestore',
    files: ['src/a.ts', 'src/b.ts'],
  }], catalog)
  expect(one.ok).toBe(true)
  if (!one.ok) throw new Error('x')
  expect(one.workers[0]!.label).toBe('W1')
  expect(one.workers[0]!.model.mode).toBe('route')
  expect(one.workers[0]!.files).toEqual(['src/a.ts', 'src/b.ts'])

  const fromString = parseDispatch(JSON.stringify([{ label: 'W2', model: 'inherit', card: 'c.md', files: 'a.ts, b.ts\nc.ts' }]), catalog)
  expect(fromString.ok).toBe(true)
  if (!fromString.ok) throw new Error('x')
  expect(fromString.workers[0]!.files).toEqual(['a.ts', 'b.ts', 'c.ts'])

  const dup = parseDispatch([
    { label: 'W1', model: 'glm', card: 'a.md' },
    { label: 'W1', model: 'glm', card: 'b.md' },
  ], catalog)
  expect(dup.ok).toBe(false)

  const badJson = parseDispatch('{oops', catalog)
  expect(badJson.ok).toBe(false)
})

test('parseDispatch：超过上限整批拒绝', () => {
  const many = Array.from({ length: 3 }, (_, i) => ({ label: `W${i}`, model: 'glm', card: `c${i}.md` }))
  expect(parseDispatch(many, catalog, 2).ok).toBe(false)
  expect(parseDispatch(many, catalog, 3).ok).toBe(true)
})

test('normalizeFiles：数组和逗号/换行字符串', () => {
  expect(normalizeFiles([' a ', '', 'b'])).toEqual(['a', 'b'])
  expect(normalizeFiles('a，b\nc')).toEqual(['a', 'b', 'c'])
  expect(normalizeFiles(undefined)).toEqual([])
})

test('buildWorkerPrompt：自包含、含截止时间和汇报格式', () => {
  const text = buildWorkerPrompt({
    label: 'W1',
    cardPath: 'D:/proj/.budget/runs/x/cards/W1.md',
    runId: 'run-1',
    deadline: '10:30:00',
    modelLabel: 'deepseek-flash',
  })
  expect(text).toContain('W1')
  expect(text).toContain('D:/proj/.budget/runs/x/cards/W1.md')
  expect(text).toContain('10:30:00')
  expect(text).toContain('不要使用 Skill 或 Agent')
  expect(text).toContain('10 行以内')
})

test('workerName：稳定、合法、带 run 短尾', () => {
  const name = workerName('20261109-013507-测试', 'W1')
  expect(name.startsWith('orch-')).toBe(true)
  expect(name).toContain('W1')
  expect(name.length).toBeLessThanOrEqual(64)
  expect(/[^a-zA-Z0-9_-]/.test(name)).toBe(false)
})

test('shortModel / formatDispatchResult', () => {
  expect(shortModel('ccs-claude-openrouter--z-ai/glm-5.3-flash[1M]')).toBe('glm-5.3-flash')
  const text = formatDispatchResult([
    { label: 'W1', agentId: 'a1', model: 'glm-5.3-flash' },
    { label: 'W2', error: '没卡' },
  ])
  expect(text).toContain('W1')
  expect(text).toContain('失败')
})
