// 编排与时间预算模式的全部 hooks。
//
// 设计：计时、账本、提示点判断全部在进程内完成，只有跨过提示点（或账本异常）时才把文字注入上下文，
// 控制 token 开销；所有向用户的提问由主 agent 用 AskUserQuestion 完成，插件只负责「什么时候该问」。
import { read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { buildMarks, cadenceText, clockText, fmt, makeRunId, type Mark } from './lib/schedule'
import { detectTimeRequirement, parseBudgetArgs, type BudgetCommand } from './lib/parse'
import { commandKey, recordCommand, summarize, type CalibRecord, type CmdStats, type PhaseName } from './lib/calib'
import { parseCatalog, workerSkillName, type CatalogEntry } from './lib/models'
import * as T from './lib/prompts'
import { agentMessages, listAgents, sendTo, stopAgent, type Caps } from './lib/runtime'
import { registerModelSearchCommand } from './model-search'

type Cadence = { kind: 'fraction'; step: number } | { kind: 'interval'; ms: number }

type WorkerEntry = {
  id: string
  type: string
  label: string
  startedAlive: number
  lastToolAt: number
  lastToolName: string
  lines: number
  files: number
  isWrappedUp: boolean
  isDone: boolean
  /** 任务卡里「允许改动」的文件（相对项目根或绝对路径）；空表示未登记，不做硬校验 */
  allowedFiles?: string[]
  /** 该 worker 自己再派生的子代理数量 */
  spawnedAgents?: number
}

type PhaseLog = { name: PhaseName; atMs: number; wall: number }

type RunState = {
  status: 'active' | 'closed' | 'expired'
  runId: string
  task: string
  startedAt: number
  workMs: number
  segmentStart: number
  budgetMs: number
  cadence: Cadence
  extraMarksMs: number[]
  firedMarks: string[]
  marks: Mark[]
  phase: PhaseName
  phases: PhaseLog[]
  preCapMs: number
  project: string
  deliverDir: string
  workers: WorkerEntry[]
  pendingSince: number | null
  staticCheck: { pass: boolean; sawEditAfter: boolean }
  gateWaived: string | null
  overdueAt: number | null
  plan: { estimates: Partial<Record<PhaseName, number>>; atMs: number } | null
  externalRefs: { run: string; phrase: string; at: string }[]
}

type WorkerMap = Record<string, WorkerEntry>
const RUNS = { plugin: 'orcheatractor-zhaowendao', key: 'runs' } as const
const WORKERS = { plugin: 'orcheatractor-zhaowendao', key: 'workers' } as const
const CALIB = { plugin: 'orcheatractor-zhaowendao', key: 'calib' } as const
const CMDS = { plugin: 'orcheatractor-zhaowendao', key: 'cmds' } as const

const CN_PHASE: Record<string, string> = {
  'pre-explore': '预探索',
  explore: '探索',
  implement: '落地',
  verify: '验收',
}

const CHECK_COMMAND =
  /\b(tsc|eslint|biome|mypy|pyright|ruff|go\s+(build|vet)|cargo\s+(check|build|clippy)|gradlew?\s+(check|build)|mvn\s+(test|verify)|dotnet\s+build|swift\s+build|rustc|flow|deno\s+(check|test)|(npm|pnpm|yarn|bun)\s+(run\s+)?(lint|typecheck|type-check|check|build|test))\b/i
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])
const RESERVED_TOOLS = new Set(['SendMessage'])

/** 会话绑定后才有的值 */
const bound = {
  sessionId: '',
  cwd: '',
  home: '',
  useHistory: true,
  step: 0.1,
  autoDetect: true,
  isInteractive: true,
  catalog: [] as CatalogEntry[],
  caps: { list: true, stop: true } as Caps,
}

/** 计时器想要的共享状态 */
const hub = {
  lastActivityAt: 0,
  lastIdleWakeAt: 0,
  lastOverduePingAt: 0,
  runId: '',
}

// ------------------------------------------------------------------ 纯函数

function workElapsed(run: RunState, now: number): number {
  return run.workMs + Math.max(0, now - run.segmentStart)
}

function nextMark(run: RunState, elapsed: number): Mark | undefined {
  return run.marks.find(m => !run.firedMarks.includes(m.key) && m.atMs <= elapsed)
}

function preCapElapsed(run: RunState): number {
  return run.phases.filter(p => p.name === 'pre-explore').reduce((s, p) => s + p.atMs, 0)
}

function planNote(run: RunState): string | undefined {
  const impl = run.plan?.estimates.implement
  if (impl === undefined) return undefined
  const left = run.budgetMs - workElapsed(run, Date.now())
  if (impl * 1000 > left) return `注意：计划里落地要 ${fmt(impl * 1000)}，现在只剩 ${fmt(left)}，已经不够，应准备延期或砍范围。`
  return undefined
}

function deadlineText(run: RunState): string {
  return clockText(Date.now() + Math.max(0, run.budgetMs - workElapsed(run, Date.now())))
}

function ledgerLines(run: RunState, now: number) {
  return run.workers
    .filter(w => !w.isDone)
    .map(w => ({
      id: w.id,
      label: w.label,
      status: w.isWrappedUp ? '已收尾' : '运行中',
      last: w.lastToolName || '刚派发',
      ago: Math.max(0, now - w.lastToolAt),
      lines: w.lines,
      files: w.files,
      deadline: clockText(now + Math.max(0, run.budgetMs - workElapsed(run, now))),
    }))
}

function workerTypeName(c: CatalogEntry): string {
  return workerSkillName(c.route)
}

function routeOfType(type: string): string {
  const name = type.replace(/^orcheatractor-zhaowendao:/, '')
  const found = bound.catalog.find(c => workerTypeName(c) === name)
  return found?.label ?? name
}

/** Git-Bash 的 /c/Users/x → C:/Users/x；统一用正斜杠。 */
function toEnginePath(p: string): string {
  const slashed = p.replace(/\\/g, '/')
  const m = slashed.match(/^\/([A-Za-z])\/(.*)$/)
  return m ? `${m[1]!.toUpperCase()}:/${m[2]}` : slashed
}

/** 把路径规范成 POSIX 风格的绝对路径，不依赖 node:path；Windows 下大小写归一。 */
function normalizePath(p: string, base: string): string {
  let raw = toEnginePath(p)
  if (raw === '~' || raw.startsWith('~/')) raw = toEnginePath(bound.home) + raw.slice(1)
  const isAbs = /^[A-Za-z]:\//.test(raw) || raw.startsWith('/')
  const abs = isAbs ? raw : `${toEnginePath(base).replace(/\/+$/, '')}/${raw}`
  const drive = abs.match(/^[A-Za-z]:/)?.[0] ?? ''
  const unc = abs.startsWith('//')
  const rest = drive ? abs.slice(drive.length) : abs
  const parts: string[] = []
  for (const seg of rest.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { parts.pop(); continue }
    parts.push(seg)
  }
  const joined = (drive ? `${drive}/` : unc ? '//' : '/') + parts.join('/')
  const isWin = /^[A-Za-z]:\//.test(toEnginePath(base)) || unc
  return isWin ? joined.toLowerCase() : joined
}

/** 解析可用 Python：CLAUDE_PYTHON/PYTHON 覆盖，其次探测；Windows 优先 python。 */
async function resolvePython($: any): Promise<string[] | undefined> {
  const override = (await $.env.get('CLAUDE_PYTHON')) || (await $.env.get('PYTHON'))
  if (override) return [override]
  const isWin = Boolean(await $.env.get('USERPROFILE'))
  const candidates: string[][] = isWin
    ? [['python', '--version'], ['python3', '--version'], ['py', '-3', '--version']]
    : [['python3', '--version'], ['python', '--version']]
  for (const argv of candidates) {
    try {
      const r: any = await $.process.run(argv, { timeoutMs: 3000 })
      const out = `${r?.stdout ?? ''}${r?.stderr ?? ''}`
      if (r?.exitCode === 0 && /Python\s+3\./.test(out)) {
        return argv[0] === 'py' ? ['py', '-3'] : [argv[0]!]
      }
    } catch {
      /* 不存在或超时，试下一个 */
    }
  }
  return undefined
}

/** worker 是否只能改卡里登记的文件 */
function checkAllowed(filePath: string, run: RunState, allowed: string[] | undefined): { ok: boolean; reason?: string } {
  if (!allowed || allowed.length === 0) return { ok: true }
  const target = normalizePath(filePath, run.project)
  for (const entry of allowed) {
    const want = normalizePath(entry, run.project)
    if (target === want) return { ok: true }
    if (target.startsWith(want + '/')) return { ok: true }
  }
  return { ok: false, reason: `不在任务卡「允许改动」内：${filePath}` }
}

function countWrittenLines(tool: string, input: Record<string, unknown>): { count: number; isNewFile: boolean } {
  if (tool === 'Write') {
    const content = typeof input.content === 'string' ? input.content : ''
    return { count: content.split('\n').length, isNewFile: true }
  }
  const text = typeof input.new_string === 'string' ? input.new_string : typeof input.new_source === 'string' ? input.new_source : ''
  return { count: text ? text.split('\n').length : 0, isNewFile: false }
}

function isErrorResponse(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false
  const r = response as Record<string, unknown>
  if (r.isError === true) return true
  if (typeof r.exitCode === 'number' && r.exitCode !== 0) return true
  const text = typeof response === 'string' ? response : JSON.stringify(response)
  return /"isError"\s*:\s*true|exit code [1-9]|Exit code: [1-9]/.test(text ?? '')
}

// ------------------------------------------------------------------ 存取

async function currentRun($: any): Promise<RunState | undefined> {
  const all = (await read($, RUNS as any)) as Record<string, RunState>
  const run = all?.[bound.sessionId]
  return run?.status === 'active' ? run : undefined
}

async function saveRun($: any, run: RunState): Promise<void> {
  hub.runId = run.runId
  await update($, RUNS as any, (all: any) => ({ ...(all ?? {}), [bound.sessionId]: run }))
}

async function workersOf($: any): Promise<WorkerMap> {
  const all = (await read($, WORKERS as any)) as Record<string, WorkerMap>
  return all?.[bound.sessionId] ?? {}
}

async function saveWorker($: any, entry: WorkerEntry): Promise<void> {
  await update($, WORKERS as any, (all: any) => {
    const mine = all?.[bound.sessionId] ?? {}
    return { ...(all ?? {}), [bound.sessionId]: { ...mine, [entry.id]: entry } }
  })
}

async function pauseRun($: any, run: RunState, now: number): Promise<void> {
  run.workMs = workElapsed(run, now)
  run.segmentStart = now
  run.pendingSince = now
  await saveRun($, run)
  await $.ui.status(`⏱ ${fmt(run.workMs)} / ${fmt(run.budgetMs)}（等待中·停表）`)
}

async function resumeRun($: any, run: RunState, now: number): Promise<void> {
  run.segmentStart = now
  run.pendingSince = null
  await saveRun($, run)
}

// ------------------------------------------------------------------ 注入与会话

async function insertRow($: any, agentId: string | undefined, text: string): Promise<void> {
  try {
    const message = { type: 'user' as const, content: [{ type: 'text', text }] }
    await $.session.append(agentId ? { message, agentId } : { message })
  } catch {
    /* 忽略 */
  }
}

/** 让空闲的主 agent 开始一轮，读刚插入的那行 */
async function wakeMain($: any): Promise<void> {
  try {
    await $.prompt.submit({ text: '（时间预算插件的计时提醒）请查看最近一条计时提示，按其中指示行事；不要向用户复述这条消息。' })
  } catch {
    /* 用户正在输入或会话忙时可能失败，下一轮会看到 */
  }
}

async function awake($: any, text: string): Promise<void> {
  await insertRow($, undefined, text)
  await wakeMain($)
}

async function notifyWorkers($: any, message: string): Promise<void> {
  const map = await workersOf($)
  for (const w of Object.values(map)) {
    if (w.isDone) continue
    try {
      await $.tool.call({ tool: 'SendMessage', to: w.id, message } as any)
    } catch {
      /* 已结束 */
    }
  }
}

// ------------------------------------------------------------------ 多目录

async function ensureDeliverDir($: any, run: RunState): Promise<void> {
  try {
    await $.fs.write(`${run.deliverDir}/.gitignore`, '*\n')
    await $.fs.write(`${run.deliverDir}/.ignore`, '*\n')
    await $.fs.write(`${run.deliverDir}/cards/.gitkeep`, '')
  } catch {
    /* 目录建不出来不影响计时 */
  }
}

async function calibrationText($: any, now: number): Promise<string> {
  if (!bound.useHistory) return '（用户关闭了历史校准：按保守估计，留 30% 余量，并在计划里标注「未校准」）'
  const all = (await read($, CALIB as any)) as any
  const cmds = ((await read($, CMDS as any)) ?? {}) as CmdStats
  return summarize(all?.records ?? [], cmds, bound.cwd, bound.catalog.map(c => c.label), now)
}

async function writeManifest($: any, run: RunState, status: string, summary: string): Promise<void> {
  const manifest = {
    run_id: run.runId,
    task: run.task,
    project: run.project,
    budget_ms: run.budgetMs,
    work_ms: run.workMs,
    valid_from: new Date(run.startedAt).toISOString(),
    valid_until: new Date().toISOString(),
    status,
    summary,
    phase: run.phase,
    phases: run.phases.map(p => ({ name: p.name, ms: p.atMs })),
    plan: run.plan,
    workers: run.workers.map(w => ({ id: w.id, type: w.type, lines: w.lines, files: w.files, done: w.isDone })),
    static_check: run.staticCheck,
    gate_waived: run.gateWaived,
    external_refs: run.externalRefs,
  }
  try {
    await $.fs.write(`${run.deliverDir}/manifest.json`, JSON.stringify(manifest, null, 2))
  } catch {
    /* 忽略 */
  }
}

// ------------------------------------------------------------------ run 生命周期

async function startRun($: any, cmd: Extract<BudgetCommand, { action: 'start' }>, now: number) {
  const task = cmd.task || '未命名任务'
  const run: RunState = {
    status: 'active',
    runId: makeRunId(now, task),
    task,
    startedAt: now,
    workMs: 0,
    segmentStart: now,
    budgetMs: cmd.budgetMs,
    cadence: cmd.cadence ?? { kind: 'fraction', step: bound.step },
    extraMarksMs: cmd.extraMarksMs,
    firedMarks: [],
    marks: [],
    phase: 'pre-explore',
    phases: [{ name: 'pre-explore', atMs: 0, wall: now }],
    preCapMs: Math.min(120_000, Math.max(30_000, Math.round(cmd.budgetMs * 0.05))),
    project: bound.cwd,
    deliverDir: `${bound.cwd}/.budget/runs/${runIdOf(now, task)}`,
    workers: [],
    pendingSince: null,
    staticCheck: { pass: false, sawEditAfter: false },
    gateWaived: null,
    overdueAt: null,
    plan: null,
    externalRefs: [],
  }
  run.marks = buildMarks(run.budgetMs, run.cadence, run.extraMarksMs)
  await update($, WORKERS as any, (all: any) => ({ ...(all ?? {}), [bound.sessionId]: {} }))
  await saveRun($, run)
  await ensureDeliverDir($, run)
  hub.lastActivityAt = now
  hub.lastIdleWakeAt = now
  hub.lastOverduePingAt = 0

  const text = T.protocol({
    runId: run.runId,
    budgetMs: run.budgetMs,
    cadence: run.cadence,
    extraMarks: run.extraMarksMs.map(ms => `第 ${fmt(ms)}`),
    preCapMs: run.preCapMs,
    deliverDir: run.deliverDir,
    workers: bound.catalog.map(c => ({ type: workerTypeName(c), label: c.label })),
    calibration: await calibrationText($, now),
  })
  await $.ui.status(`⏱ 0:00 / ${fmt(run.budgetMs)}`)
  return {
    text: `编排与时间预算模式已开启：run=${run.runId}，预算 ${fmt(run.budgetMs)}，${cadenceText(run.cadence)}。交付物目录：${run.deliverDir}`,
    context: [text],
  }
}

function runIdOf(now: number, task: string): string {
  return makeRunId(now, task)
}

async function closeRun($: any, run: RunState, status: string, summary: string, now: number): Promise<void> {
  const record: CalibRecord = {
    project: run.project,
    at: now,
    budgetMs: run.budgetMs,
    elapsedMs: run.workMs,
    status,
    phases: run.phases.map(p => ({
      name: p.name,
      ms: p.atMs,
      estimateMs: run.plan?.estimates[p.name] !== undefined ? run.plan.estimates[p.name]! * 1000 : undefined,
    })),
    workers: run.workers.map(w => ({ model: routeOfType(w.type), lines: w.lines, activeMs: Math.max(30_000, now - run.startedAt) })),
  }
  await update($, CALIB as any, (all: any) => {
    const records: CalibRecord[] = (all?.records as CalibRecord[]) ?? []
    return { ...(all ?? {}), records: [...records, record].slice(-200) }
  })
  await writeManifest($, run, status, summary)
  run.overdueAt = null
  run.status = status === 'expired' ? 'expired' : 'closed'
  run.pendingSince = now
  await saveRun($, run)
  await $.ui.status(undefined)
}

function closeSummary(run: RunState): string {
  const phases = run.phases.map(p => `${CN_PHASE[p.name] ?? p.name} ${fmt(p.atMs)}`).join(' · ')
  return `阶段用时：${phases}；worker ${run.workers.length} 个。`
}

async function statusText($: any, run: RunState, now: number): Promise<string> {
  const elapsed = workElapsed(run, now)
  return [
    `run=${run.runId}（${run.task}）`,
    `阶段：${CN_PHASE[run.phase] ?? run.phase} · 已用 ${fmt(elapsed)} / ${fmt(run.budgetMs)} · 剩 ${fmt(Math.max(0, run.budgetMs - elapsed))}`,
    `worker：\n${T.ledgerText(ledgerLines(run, now))}`,
    planNote(run) ?? '',
  ]
    .filter(Boolean)
    .join('\n')
}

async function switchPhase($: any, run: RunState, phase: PhaseName, now: number): Promise<void> {
  const elapsed = workElapsed(run, now)
  const doneSum = run.phases.reduce((s, p) => s + p.atMs, 0)
  const last = run.phases[run.phases.length - 1]
  if (last) last.atMs = Math.max(0, elapsed - doneSum)
  run.phases.push({ name: phase, atMs: 0, wall: now })
  run.phase = phase
  await saveRun($, run)
}

// ------------------------------------------------------------------ 定时器

async function tick($: any): Promise<void> {
  const now = Date.now()
  const run = await currentRun($)
  if (!run) return
  if (run.pendingSince !== null) return

  const elapsed = workElapsed(run, now)

  // 到期
  if (elapsed >= run.budgetMs) {
    if (run.overdueAt === null) {
      run.overdueAt = now
      run.firedMarks = [...new Set([...run.firedMarks, 'end'])]
      const map = await workersOf($)
      for (const w of Object.values(map)) {
        if (w.isDone || w.isWrappedUp) continue
        try {
          await $.tool.call({ tool: 'SendMessage', to: w.id, message: T.WRAP_UP_WORKER } as any)
          w.isWrappedUp = true
          await saveWorker($, w)
        } catch {
          /* 已结束 */
        }
      }
      const runWorkers = run.workers.map(w => (map[w.id] ? { ...w, isWrappedUp: map[w.id]!.isWrappedUp } : w))
      const text = T.overdueText({ elapsedMs: elapsed, budgetMs: run.budgetMs, ledger: T.ledgerText(ledgerLines({ ...run, workers: runWorkers }, now)), again: false })
      run.workers = runWorkers
      await saveRun($, run)
      await awake($, text)
      hub.lastOverduePingAt = now
      return
    }
    if (now - hub.lastOverduePingAt > 30_000 && now - run.overdueAt < 3_600_000) {
      hub.lastOverduePingAt = now
      await awake($, T.overdueText({ elapsedMs: elapsed, budgetMs: run.budgetMs, ledger: T.ledgerText(ledgerLines(run, now)), again: true }))
      return
    }
    await $.ui.status(`⏰ 已超出 ${fmt(elapsed - run.budgetMs)}`)
    return
  }

  // 预探索超时：从进入该阶段的墙钟时刻算
  const preStart = run.phases.find(p => p.name === 'pre-explore')?.wall ?? run.startedAt
  if (run.phase === 'pre-explore' && now - preStart >= run.preCapMs) {
    run.phases[0]!.atMs = elapsed
    run.phase = 'explore'
    run.phases.push({ name: 'explore', atMs: 0, wall: now })
    await saveRun($, run)
    await awake($, T.preCapText(run.preCapMs))
    return
  }

  // 提示点
  const mark = nextMark(run, elapsed)
  if (mark) {
    run.firedMarks = [...run.firedMarks, mark.key]
    await saveRun($, run)
    hub.lastIdleWakeAt = now
    await insertRow(
      $,
      undefined,
      T.checkpointText({
        label: mark.label,
        elapsedMs: elapsed,
        budgetMs: run.budgetMs,
        phase: CN_PHASE[run.phase] ?? run.phase,
        ledger: T.ledgerText(ledgerLines(run, now)),
        fraction: mark.fraction,
        planNote: planNote(run),
        idleWake: false,
      }),
    )
    await $.ui.status(`⏱ ${fmt(elapsed)} / ${fmt(run.budgetMs)}`)
    return
  }

  // 空闲巡查：主 agent 2 分钟没有动作、还有 worker 在跑 → 唤醒一次
  const hasRunning = run.workers.some(w => !w.isDone)
  if (hasRunning && now - hub.lastActivityAt > 120_000 && now - hub.lastIdleWakeAt > 120_000) {
    hub.lastIdleWakeAt = now
    await awake($, T.checkpointText({
      label: '巡查',
      elapsedMs: elapsed,
      budgetMs: run.budgetMs,
      phase: CN_PHASE[run.phase] ?? run.phase,
      ledger: T.ledgerText(ledgerLines(run, now)),
      fraction: elapsed / run.budgetMs,
      planNote: planNote(run),
      idleWake: true,
    }))
    return
  }
  await $.ui.status(`⏱ ${fmt(elapsed)} / ${fmt(run.budgetMs)}`)
}

// ------------------------------------------------------------------ 注册

export const register: Register = (on, options) => {
  const opt = (options ?? {}) as Record<string, unknown>

  on('session.start', async ($, e, next) => {
    bound.sessionId = await $.session.id()
    bound.cwd = toEnginePath(e.cwd)
    bound.isInteractive = e.isInteractive
    bound.useHistory = opt.use_history !== false
    bound.autoDetect = opt.auto_detect !== false
    bound.step = typeof opt.default_step_percent === 'number' ? (opt.default_step_percent as number) / 100 : 0.1
    hub.lastActivityAt = Date.now()
    try {
      const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
      const configDir = toEnginePath((await $.env.get('CLAUDE_CONFIG_DIR')) || (home ? `${home}/.claude` : ''))
      bound.home = toEnginePath(home)
      const text = configDir ? await $.fs.read(`${configDir}/settings.json`) : ''
      bound.catalog = text ? parseCatalog(text) : []
    } catch {
      bound.catalog = []
    }
    // 二合一：同步现有 model-agents 通道，实际派发仍由 m-* Skill 完成。
    try {
      const py = await resolvePython($)
      if (py) {
        await $.process.run(
          [...py, '-I', `${toEnginePath($.plugin.root)}/model-agents/bin/sync.py`, 'sync', '--quiet'],
          { timeoutMs: 30_000 },
        )
      }
    } catch {
      /* 名录同步失败不阻塞主会话 */
    }

    await $.command.register({
      name: 'orcheatractor-zhaowendao',
      description: '编排与时间预算模式（默认关闭）：/orcheatractor-zhaowendao 10m 开启，/orcheatractor-zhaowendao 状态，/orcheatractor-zhaowendao 延时 5m，/orcheatractor-zhaowendao 关闭',
      argumentHint: '10m [任务] | 状态 | 延时 5m | 关闭',
    })
    await registerModelSearchCommand($)

    await $.tool.register({
      name: 'budget',
      description:
        '编排与时间预算模式的状态操作。action: start（开启预算）、decline（本会话不再询问）、status（查看进度）、phase（切阶段）、plan（记录预算计划）、extend（延时）、close（结束）、gate（登记静态检查豁免）、ref（登记用户明文指定的历史 run）、help。',
      isDeferred: true,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'decline', 'status', 'phase', 'plan', 'extend', 'close', 'gate', 'ref', 'card', 'say', 'stop', 'view', 'probe', 'help'] },
          worker: { type: 'string', description: 'worker 的 agentId，或 last / all' },
          files: { type: 'string', description: 'card 用：允许改动的文件，逗号分隔' },
          message: { type: 'string', description: 'say 用：发给 worker 的内容' },
          limit: { type: 'string', description: 'view 用：读最近多少行' },
          duration: { type: 'string', description: '预算时长，例如 10m / 半小时（start 用）' },
          task: { type: 'string', description: '任务简称（可选）' },
          cadence: { type: 'string', description: '提示节奏（可选）：每5% / 4分位 / 每2分钟' },
          extra_marks: { type: 'string', description: '额外提示点（可选），逗号分隔，例如 第15分钟' },
          phase: { type: 'string', enum: ['pre-explore', 'explore', 'implement', 'verify'] },
          estimates: { type: 'string', description: 'JSON：各阶段秒数，例如 {"explore":60,"implement":300,"verify":60}' },
          minutes: { type: 'string', description: '延时分钟数' },
          status: { type: 'string', description: 'close 用：delivered / cancelled / expired', },
          summary: { type: 'string' },
          reason: { type: 'string' },
          run: { type: 'string', description: 'ref 用：历史 run_id' },
          phrase: { type: 'string', description: 'ref 用：用户原话' },
        },
        required: ['action'],
      },
    } as any)

    $.clock.every(1000, () => void tick($))
    return next(e)
  })

  on('command.run', { command: 'orcheatractor-zhaowendao' }, async ($, e) => {
    const now = Date.now()
    const cmd = parseBudgetArgs(e.args)
    const run = await currentRun($)

    if (cmd.action === 'help') return { text: T.HELP, context: [T.HELP] }
    if (cmd.action === 'error') return { text: cmd.message }
    if (cmd.action === 'decline') {
      await update($, CALIB as any, (all: any) => ({ ...(all ?? {}), [`declined:${bound.sessionId}`]: true }))
      return { text: '本会话不再询问是否开启预算模式。' }
    }
    if (cmd.action === 'start') {
      if (run && run.overdueAt === null) {
        return { text: `已有进行中的预算（${run.runId}，剩 ${fmt(Math.max(0, run.budgetMs - workElapsed(run, now)))}）。先用 /orcheatractor-zhaowendao 关闭 再开新的。` }
      }
      const started = await startRun($, cmd, now)
      if (cmd.task) {
        // 斜杠命令本身不产生模型回合：把命令后面跟的任务重新提交给模型
        try {
          await $.prompt.submit({ text: cmd.task })
        } catch {
          /* 提交失败时用户会看到命令输出，可以再发一次任务 */
        }
        return { text: `${started.text}\n已把任务交给模型：${cmd.task.slice(0, 60)}`, context: started.context }
      }
      return { text: `${started.text}\n把任务发给我就开始计时。`, context: started.context }
    }
    if (!run) return { text: '当前没有进行中的预算。先 /orcheatractor-zhaowendao 10m 开启。' }

    if (cmd.action === 'status') {
      const text = await statusText($, run, now)
      return { text, context: [text] }
    }
    if (cmd.action === 'stop') {
      await pauseRun($, run, now)
      await closeRun($, run, 'cancelled', '用户关闭', now)
      return { text: `预算已关闭，实际用时 ${fmt(run.workMs)}。` }
    }
    if (cmd.action === 'extend') {
      run.budgetMs += cmd.ms
      run.marks = buildMarks(run.budgetMs, run.cadence, run.extraMarksMs)
      if (run.overdueAt !== null) {
        run.overdueAt = null
        run.segmentStart = now
      }
      await saveRun($, run)
      await notifyWorkers($, `[orcheatractor-zhaowendao] 预算已延长 ${fmt(cmd.ms)}，新的剩余时间 ${fmt(Math.max(0, run.budgetMs - workElapsed(run, now)))}。继续按原计划做。`)
      return { text: `已延长 ${fmt(cmd.ms)}，新预算 ${fmt(run.budgetMs)}。已通知 worker。` }
    }
    if (cmd.action === 'clean') {
      return { text: '清理功能：删除本项目 .budget/runs 下超过 14 天或第 21 个以后的 run 需要你确认后再做，目前未实现自动删除。' }
    }
    return { text: T.HELP }
  })

  on('tool.call', { tool: 'mcp__orcheatractor-zhaowendao__budget' }, async ($, e: any) => {
    const now = Date.now()
    const a = e as Record<string, string>
    const run = await currentRun($)
    const ok = (text: string, context?: string[]) => ({
      result: [{ type: 'text', text }],
      ...(context ? { context } : {}),
    })
    const err = (text: string) => ({ result: [{ type: 'text', text: `错误：${text}` }] })

    switch (a.action) {
      case 'start': {
        if (run && run.overdueAt === null) return ok(`已有进行中的预算 ${run.runId}`)
        const cmd = parseBudgetArgs([a.duration, a.cadence, a.extra_marks, a.task].filter(Boolean).join(' '))
        if (cmd.action !== 'start') return err('参数不完整：需要 duration，例如 action=start duration=10m')
        const started = await startRun($, cmd, now)
        return ok(started.text, started.context)
      }
      case 'decline':
        await update($, CALIB as any, (all: any) => ({ ...(all ?? {}), [`declined:${bound.sessionId}`]: true }))
        return ok('已记录：本会话不再询问是否开启预算模式。')
      case 'status':
        return ok(run ? await statusText($, run, now) : '当前没有进行中的预算。')
      case 'phase': {
        if (!run) return err('没有进行中的预算')
        const phase = (a.phase as PhaseName) ?? 'implement'
        await switchPhase($, run, phase, now)
        if (phase === 'implement' && run.phase !== 'verify') {
          hub.lastActivityAt = now
        }
        return ok(`已切换到阶段：${CN_PHASE[phase] ?? phase}`)
      }
      case 'plan': {
        if (!run) return err('没有进行中的预算')
        let estimates: Partial<Record<PhaseName, number>> = {}
        try {
          estimates = JSON.parse(a.estimates || '{}')
        } catch {
          return err('estimates 不是合法 JSON')
        }
        run.plan = { estimates, atMs: workElapsed(run, now) }
        await saveRun($, run)
        const total = Object.values(estimates).reduce((s: number, v) => s + (typeof v === 'number' ? v : 0), 0)
        return ok(`计划已记录，合计 ${fmt(total * 1000)} / 预算 ${fmt(run.budgetMs)}。${planNote(run) ?? ''}`)
      }
      case 'extend': {
        if (!run) return err('没有进行中的预算')
        const ms = (Number(a.minutes) || 0) * 60_000
        if (ms <= 0) return err('minutes 不合法')
        run.budgetMs += ms
        run.marks = buildMarks(run.budgetMs, run.cadence, run.extraMarksMs)
        if (run.overdueAt !== null) {
          run.overdueAt = null
          run.segmentStart = now
        }
        await saveRun($, run)
        await notifyWorkers($, `[orcheatractor-zhaowendao] 预算已延长 ${fmt(ms)}，新的剩余时间 ${fmt(Math.max(0, run.budgetMs - workElapsed(run, now)))}。继续按原计划做。`)
        return ok(`已延长 ${fmt(ms)}，新预算 ${fmt(run.budgetMs)}；已通知 worker。`)
      }
      case 'close': {
        if (!run) return err('没有进行中的预算')
        await pauseRun($, run, now)
        await closeRun($, run, a.status || 'delivered', a.summary || '', now)
        return ok(`已结束：${fmt(run.workMs)} / ${fmt(run.budgetMs)}。${closeSummary(run)}`)
      }
      case 'gate': {
        if (!run) return err('没有进行中的预算')
        run.gateWaived = a.reason || ''
        await saveRun($, run)
        return ok('已登记静态检查豁免。')
      }
      case 'card': {
        if (!run) return err('没有进行中的预算')
        const map = await workersOf($)
        const target = a.worker === 'last' || !a.worker
          ? run.workers.filter(w => !w.isDone).slice(-1)[0]
          : map[a.worker]
        if (!target) return err('找不到对应的 worker')
        const files = String(a.files || '').split(/[,，\n]/).map(x => x.trim()).filter(Boolean)
        target.allowedFiles = files
        await saveWorker($, target)
        run.workers = run.workers.map(w => (w.id === target.id ? target : w))
        await saveRun($, run)
        return ok(files.length ? `已登记 ${target.id.slice(0, 8)} 允许改动的文件：${files.join('、')}` : '已清空该 worker 的文件白名单')
      }
      case 'say': {
        if (!run) return err('没有进行中的预算')
        const map = await workersOf($)
        const target = a.worker === 'all' ? undefined : (map[a.worker] ?? (a.worker ? undefined : run.workers.filter(w => !w.isDone).slice(-1)[0]))
        if (!a.worker && !target) return err('没有运行中的 worker')
        if (a.worker === 'all') {
          const list = run.workers.filter(w => !w.isDone)
          let sent = 0
          for (const w of list) {
            const r = await sendTo($, w.id, a.message ?? '')
            if (r.ok) sent++
          }
          return ok(`已给 ${sent}/${list.length} 个 worker 发消息`)
        }
        if (!target) return err('找不到对应的 worker')
        const r = await sendTo($, target.id, a.message ?? '')
        return r.ok ? ok(`已发给 ${target.id.slice(0, 8)}`) : err(`发送失败：${r.note ?? ''}`)
      }
      case 'stop': {
        if (!run) return err('没有进行中的预算')
        const list = a.worker === 'all' ? run.workers.filter(w => !w.isDone) : run.workers.filter(w => w.id === a.worker)
        if (!list.length) return err('找不到对应的 worker')
        const lines: string[] = []
        for (const w of list) {
          const hard = await stopAgent($, w.id)
          if (!hard.ok) {
            const soft = await sendTo($, w.id, T.WRAP_UP_WORKER)
            lines.push(`${w.label}: 硬停止失败（${hard.note ?? '未知'}），已改为发收尾消息${soft.ok ? '' : '（也失败）'}`)
          } else {
            w.isDone = true
            w.isWrappedUp = true
            await saveWorker($, w)
            lines.push(`${w.label}: 已停止`)
          }
        }
        run.workers = run.workers.map(x => (list.some(l => l.id === x.id && l.isDone) ? { ...x, isDone: true, isWrappedUp: true } : x))
        await saveRun($, run)
        return ok(lines.join('\n'))
      }
      case 'view': {
        if (!run) return err('没有进行中的预算')
        const map = await workersOf($)
        const target = a.worker && a.worker !== 'last' ? map[a.worker] : run.workers.filter(w => !w.isDone).slice(-1)[0]
        if (!target) return err('找不到对应的 worker')
        const rows = await agentMessages($, target.id, Number(a.limit) || 10)
        if (!rows.length) return ok(`${target.label}：读不到对话（可能已结束或引擎不开放）`)
        const body = rows.map(r => `${r.role === 'assistant' ? '→' : '←'} ${r.tools.length ? `[${r.tools.join(',')}] ` : ''}${r.text.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n')
        return ok(`${target.label} 最近 ${rows.length} 行：\n${body}`)
      }
      case 'probe': {
        const rows = await listAgents($)
        if (rows === undefined) {
          bound.caps = { ...bound.caps, list: false }
          return ok('能力探测：$.agent.list() 不可用，账本改为只靠 hook 事件自报。')
        }
        const mine = run ? rows.filter(r => run.workers.some(w => w.id === r.id)) : []
        return ok(`能力探测：agent.list 可用（共 ${rows.length} 个，本 run 命中 ${mine.length} 个）。\n` +
          rows.slice(0, 12).map(r => `- ${r.id.slice(0, 8)} ${r.type} ${r.status}${r.parentId ? ` ← ${r.parentId.slice(0, 8)}` : ''}`).join('\n'))
      }
      case 'ref': {
        if (!run) return err('没有进行中的预算')
        run.externalRefs.push({ run: a.run || '', phrase: a.phrase || '', at: clockText(now) })
        await saveRun($, run)
        return ok(`已登记历史 run 引用：${a.run}`)
      }
      default:
        return ok(T.HELP, [T.HELP])
    }
  }).catch(($, e: any, next: any) =>
    next.called ? next(e) : { result: [{ type: 'text', text: 'orcheatractor-zhaowendao 工具内部出错，请改用命令。' }] },
  )

  on('turn.start', async ($, e, next) => {
    const run = await currentRun($)
    if (run && run.pendingSince !== null) await resumeRun($, run, Date.now())
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const run = await currentRun($)
    // 用户正在补充需求或回答提问时停表；插件自己的唤醒消息不计作用户等待。
    if (run && !e.isMeta && e.origin?.kind !== 'plugin' && run.pendingSince === null) {
      await pauseRun($, run, Date.now())
    }
    if (!bound.autoDetect || !bound.isInteractive) return next(e)
    if (run) return next(e)
    const calib = ((await read($, CALIB as any)) ?? {}) as Record<string, unknown>
    if (calib[`declined:${bound.sessionId}`]) return next(e)
    const hit = detectTimeRequirement(e.text)
    if (!hit) return next(e)
    return next({ ...e, context: [...(e.context ?? []), T.detectPrompt(hit.phrase, hit.ms)] })
  }).catch(($, e, next) => next(e))

  on('classic.SubagentStart', async ($, e: any, next) => {
    const run = await currentRun($)
    if (!run) return next(e)
    const now = Date.now()
    hub.lastActivityAt = now
    const entry: WorkerEntry = {
      id: e.agent_id,
      type: e.agent_type,
      label: e.agent_type.replace(/^orcheatractor-zhaowendao:/, ''),
      startedAlive: workElapsed(run, now),
      lastToolAt: now,
      lastToolName: '刚派发',
      lines: 0,
      files: 0,
      isWrappedUp: false,
      isDone: false,
    }
    // 账本里发现「worker 又派了子代理」：工具集管不了，只能记账并提醒 main
    const rows = await listAgents($)
    const self = rows?.find(r => r.id === e.agent_id)
    const parent = self?.parentId ? run.workers.find(x => x.id === self.parentId) : undefined
    if (parent) {
      parent.spawnedAgents = (parent.spawnedAgents ?? 0) + 1
      const pm = (await workersOf($))[parent.id]
      if (pm) {
        pm.spawnedAgents = parent.spawnedAgents
        await saveWorker($, pm)
      }
      entry.label = `${entry.label}（由 ${parent.label} 派生）`
      await insertRow($, undefined, `[orcheatractor-zhaowendao] 注意：worker ${parent.label} 自己派生了子代理 ${e.agent_id.slice(0, 8)}。这条通道的工具集无法禁止，预算外的开销不会进账本，建议 SendMessage 让它收回。`)
    }
    await saveWorker($, entry)
    run.workers = [...run.workers, entry]
    await saveRun($, run)
    const rest = await next(e)
    const text = T.subagentStartText({ remainMs: Math.max(0, run.budgetMs - workElapsed(run, now)), budgetMs: run.budgetMs })
    return { ...(rest as any), additionalContext: [...((rest as any)?.additionalContext ?? []), text] }
  }).catch(($, e, next) => next(e))

  on('classic.SubagentStop', async ($, e: any, next) => {
    const map = await workersOf($)
    const w = map[e.agent_id]
    if (w) {
      w.isDone = true
      w.isWrappedUp = true
      await saveWorker($, w)
    }
    const run = await currentRun($)
    if (run) {
      run.workers = run.workers.map(x => (x.id === e.agent_id ? { ...x, isDone: true, isWrappedUp: true } : x))
      await saveRun($, run)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e: any, next) => {
    const now = Date.now()
    const agentId: string | undefined = e.agentId
    const run = await currentRun($)
    if (!run) return next(e)
    hub.lastActivityAt = now
    if (run.pendingSince !== null) await resumeRun($, run, now)

    if (!agentId) return next(e)

    const map = await workersOf($)
    const w = map[agentId]

    // 越界改文件：卡里登记了「允许改动」就硬拦
    if (w && WRITE_TOOLS.has(String(e.tool ?? ''))) {
      const target = (e as any).file_path ?? (e as any).notebook_path
      if (typeof target === 'string') {
        const verdict = checkAllowed(target, run, w.allowedFiles)
        if (!verdict.ok) {
          return { deny: `[${'orcheatractor-zhaowendao'}] ${verdict.reason}。如确需改动，请向 main 申请并在任务卡里补充。` } as any
        }
      }
    }
    if (w) {
      w.lastToolAt = now
      w.lastToolName = String(e.tool ?? '')
      if (RESERVED_TOOLS.has(w.lastToolName)) w.isDone = true
      await saveWorker($, w)
    }
    hub.lastActivityAt = now
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUse', async ($, e: any, next) => {
    const run = await currentRun($)
    if (!run) return next(e)
    const tool = String(e.tool_name ?? '')
    const agentId: string | undefined = e.agent_id

    if (WRITE_TOOLS.has(tool)) {
      const counted = countWrittenLines(tool, (e.tool_input ?? {}) as Record<string, unknown>)
      run.staticCheck.sawEditAfter = true
      run.staticCheck.pass = false
      if (agentId) {
        const map = await workersOf($)
        const w = map[agentId]
        if (w) {
          w.lines += counted.count
          w.files += counted.isNewFile ? 1 : 0
          w.lastToolAt = Date.now()
          await saveWorker($, w)
        }
      }
      await saveRun($, run)
      return next(e)
    }

    if (tool === 'Bash') {
      const command = String((e.tool_input as any)?.command ?? '')
      const response = e.tool_response as any
      const durationMs = typeof response?.durationMs === 'number' ? response.durationMs : undefined
      if (durationMs && durationMs > 500) {
        const key = commandKey(command)
        if (key) await update($, CMDS as any, (all: any) => recordCommand(all ?? {}, key, durationMs, Date.now()))
      }
      if (CHECK_COMMAND.test(command)) {
        run.staticCheck.pass = !isErrorResponse(response)
        run.staticCheck.sawEditAfter = run.staticCheck.pass ? false : true
        await saveRun($, run)
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e: any, next) => {
    const run = await currentRun($)
    if (!run) return next(e)
    const now = Date.now()
    if (run.staticCheck.sawEditAfter && !run.staticCheck.pass && !run.gateWaived) {
      return { block: T.gateText() }
    }
    if (run.pendingSince === null) await pauseRun($, run, now)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e: any, next) => {
    const run = await currentRun($)
    if (run && e.agentId === undefined && run.phase === 'verify' && run.workers.every(w => w.isDone)) {
      const now = Date.now()
      if (run.pendingSince === null) await pauseRun($, run, now)
      await closeRun($, run, 'delivered', '主 agent 在验收阶段完成任务，自动结束预算。', now)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    const run = await currentRun($)
    if (run) {
      const now = Date.now()
      await pauseRun($, run, now)
      await closeRun($, run, 'cancelled', `会话结束（${String(e.reason)}）`, now)
    }
    return next(e)
  })
}
