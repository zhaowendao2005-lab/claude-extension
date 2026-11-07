import { expect, test } from 'claude-code/testing'
import { detectTimeRequirement, findDurations, parseBudgetArgs, parseDuration } from '../hooks/lib/parse'
import { buildMarks, fmt, makeRunId } from '../hooks/lib/schedule'

test('时长解析：常见写法', () => {
  expect(parseDuration('10m')).toBe(600_000)
  expect(parseDuration('10分钟')).toBe(600_000)
  expect(parseDuration('半小时')).toBe(1_800_000)
  expect(parseDuration('1h30m')).toBe(5_400_000)
  expect(parseDuration('1小时30分钟')).toBe(5_400_000)
  expect(parseDuration('90')).toBe(5_400_000)
  expect(parseDuration('十分钟')).toBe(600_000)
  expect(findDurations('先 5 分钟探索，再用 20 分钟写').map(h => h.ms)).toEqual([300_000, 1_200_000])
})

test('/budget 参数', () => {
  const a = parseBudgetArgs('10m 每5% 修复登录 bug')
  expect(a.action).toBe('start')
  if (a.action !== 'start') throw new Error('x')
  expect(a.budgetMs).toBe(600_000)
  expect(a.cadence).toEqual({ kind: 'fraction', step: 0.05 })
  expect(a.task).toBe('修复登录 bug')

  const b = parseBudgetArgs('20分钟 4分位')
  if (b.action !== 'start') throw new Error('x')
  expect(b.cadence).toEqual({ kind: 'fraction', step: 0.25 })

  const c = parseBudgetArgs('30m 每2分钟 第15分钟')
  if (c.action !== 'start') throw new Error('x')
  expect(c.cadence).toEqual({ kind: 'interval', ms: 120_000 })
  expect(c.extraMarksMs).toEqual([900_000])

  expect(parseBudgetArgs('状态').action).toBe('status')
  expect(parseBudgetArgs('延时 5m')).toEqual({ action: 'extend', ms: 300_000 })
  expect(parseBudgetArgs('关闭').action).toBe('stop')
  expect(parseBudgetArgs('').action).toBe('help')
})

test('提示词里的时间要求', () => {
  const hit = detectTimeRequirement('请在 10 分钟内完成登录改造')
  expect(hit?.ms).toBe(600_000)
  expect(detectTimeRequirement('给你半小时，修一下这个 bug')?.ms).toBe(1_800_000)
  expect(detectTimeRequirement('把超时时间改成 5 分钟')).toBeUndefined()
  expect(detectTimeRequirement('这段代码在 `timeout 3m` 里')).toBeUndefined()
})

test('提示点：默认十分位 + 额外提示点 + 终点', () => {
  const marks = buildMarks(600_000, { kind: 'fraction', step: 0.1 }, [510_000])
  expect(marks.filter(m => m.key !== 'end').map(m => m.label)).toEqual([
    '10%', '20%', '30%', '40%', '50%', '60%', '70%', '80%', '第 8:30（额外提醒）', '90%',
  ])
  expect(marks[marks.length - 1]!.atMs).toBe(600_000)
  const few = buildMarks(600_000, { kind: 'fraction', step: 0.25 }, [])
  expect(few.map(m => m.label)).toEqual(['25%', '50%', '75%', '100%'])
})

test('格式化与 run_id', () => {
  expect(fmt(65_000)).toBe('1:05')
  expect(fmt(3_725_000)).toBe('1:02:05')
  // makeRunId 用本地时间格式化；用本地时间构造，避免假设运行环境是 UTC+8。
  expect(makeRunId(new Date(2026, 10, 5, 16, 26, 0).getTime(), '修复 登录/bug')).toBe('20261105-162600-修复-登录-bug')
})
