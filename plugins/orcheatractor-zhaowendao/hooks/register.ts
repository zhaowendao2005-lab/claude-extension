// Host bridge only. All authoritative transitions go through the durable controller.
import type { Register } from 'claude-code'
import { RunController } from '../core/controller'
import { completionProblems, counts, elapsed, taskDone, type Run, type Attempt } from '../core/state'
import { createRunStore } from '../storage/run-store'
import { parseBudgetArgs, parseDuration, extractCadence, detectTimeRequirement } from './lib/parse'
import { fmt, makeRunId } from './lib/schedule'
import { parseCatalog, type CatalogEntry } from './lib/models'
import { parseDispatch, buildWorkerPrompt, workerName } from './lib/dispatch'
import { listAgents, spawnAgent, sendTo, stopAgent, agentMessages } from './lib/runtime'
import { registerModelSearchCommand } from './model-search'

const TERMINAL = new Set(['completed', 'cancelled'])
const ATTEMPT_TERMINAL = new Set(['completed', 'failed'])
const WRITES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const CHECK = /^(tsc|eslint|biome|mypy|pyright|ruff|go\s+(build|vet)|cargo\s+(check|build|clippy)|gradlew?\s+(check|build)|mvn\s+(test|verify)|dotnet\s+build|swift\s+build|deno\s+(check|test)|(npm|pnpm|yarn|bun)\s+(run\s+)?(lint|typecheck|type-check|check|build|test))\b/i
function isCheckCommand(command: string): boolean {
  return CHECK.test(command.trim()) && !/[;&|<>`$\r\n]/.test(command)
}
const HELP = '编排内核 v2：start / status / list / dispatch / retry / probe / recover / resume / phase / plan / extend / gate / close / cancel / card / say / stop / view / ref。card_path 是文件路径。跨 session 记录只读，不自动接管、不自动重试。Ask 等待暂停主预算，不停止 worker 或模型费用。'
function path(value: string, cwd: string): string {
  const raw = value.replace(/\\/g, '/')
  const absolute = /^(\/|[A-Za-z]:\/)/.test(raw) ? raw : `${cwd}/${raw}`
  const prefix = absolute.startsWith('/') ? '/' : ''
  const parts: string[] = []
  for (const part of absolute.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length && !/^[A-Za-z]:$/.test(parts[parts.length - 1]!)) parts.pop()
    } else parts.push(part)
  }
  return prefix + parts.join('/')
}
function allowed(file: string, files: string[], cwd: string): boolean {
  const target = path(file, cwd)
  return files.some(f => target === path(f, cwd))
}
function responseFailed(r: any): boolean {
  return !r || r.isError === true || r.deny !== undefined || (typeof r.exitCode === 'number' && r.exitCode !== 0)
}
function status(run: Run): string {
  const c = counts(run)
  const managed = Object.values(run.attempts).filter(a => a.managed)
  return [
    `run=${run.id} · ${run.status} · 阶段=${run.phase} · revision=${run.revision}`,
    `创建 session=${run.createdSessionId} · owner=${run.ownerSessionId}`,
    `预算 ${fmt(elapsed(run, Date.now()))} / ${fmt(run.budgetMs)}${Object.keys(run.pauses).length ? ` · 停表：${Object.keys(run.pauses).join(', ')}` : ''}`,
    managed.length ? `登记 ${managed.length} 次执行 · ${Object.entries(c).map(([k,v]) => `${k}=${v}`).join(' · ')}` : '本 run 尚未派发 managed worker。',
    ...Object.values(run.attempts).map(a => `- ${a.managed ? 'managed' : 'observed'} ${a.id} agent=${a.agentId ?? '尚未确认'} ${a.status}${a.reason ? `：${a.reason}` : ''}`),
  ].join('\n')
}

/** 继续时的基线说明：已完成的不重做，未完成的重新派发。 */
function brief(run: Run): string {
  const done: string[] = [], todo: string[] = []
  for (const task of Object.values(run.tasks)) {
    if (taskDone(run, task)) {
      done.push(`✓ ${task.label} — ${task.allowedFiles.join(', ')}`)
    } else {
      const last = task.attemptIds.map(id => run.attempts[id]).filter(Boolean).pop()
      todo.push(`· ${task.label} — ${last ? `${last.status}${last.reason ? `（${last.reason}）` : ''}` : '未派发'}`)
    }
  }
  const salvaged = Object.values(run.attempts).filter(a => a.salvage)
  return [
    done.length ? `已完成任务（继续时跳过，不重做）：\n${done.join('\n')}` : '已完成任务：无',
    todo.length ? `待办任务（继续时重新派发）：\n${todo.join('\n')}` : '待办任务：无',
    salvaged.length ? `打断时抢救的产物：${salvaged.map(a => `${a.id} → ${a.salvage!.dir}`).join('；')}` : '',
  ].filter(Boolean).join('\n')
}

// The host instantiates this module per session. State here is only a binding/cache;
// durable run state lives exclusively in RunStore, never in these variables.
let opt: Record<string, unknown> = {}
  let sessionId = '', cwd = '', selected: string | undefined
  let store: Awaited<ReturnType<typeof createRunStore>> | undefined
  let controller: RunController | undefined
  let startupError = '', timerFault = ''
  let catalog: CatalogEntry[] = []
  let maxWorkers = 20, timerBusy = false, lastCheckpoint = 0, sequence = 0, dispatchBusy = false
  let declined = false
  let actionTail: Promise<unknown> = Promise.resolve()
  const runAction = ($: any, args: any): Promise<string> => {
    const operation = actionTail.then(() => act($, args))
    actionTail = operation.catch(() => undefined)
    return operation
  }
  const routes = new Map<string, string>()
  const toolEdits = new Map<string, number>()
  const toolChecks = new Map<string, number>()
  const asks = new Set<string>()
  const now = () => Date.now()
  /** 当前选中任务目录（绝对路径）；run 按目录寻址 */
  let selectedDir = ''
  const taskDirOf = (r: Run) => r.deliverDir
  const openTask = async ($: any, dir: string) => {
    store = await createRunStore($, dir, $.plugin.root)
    controller = new RunController(store)
    selectedDir = dir
  }
  /** 接受绝对路径、相对 cwd 的路径、或任务目录 basename */
  const resolveTaskDir = async ($: any, ref: string): Promise<string> => {
    const raw = ref.trim()
    if (!raw) throw new Error('需要任务目录路径')
    const candidates = raw.startsWith('/') ? [raw] : [path(raw, cwd), `${cwd}/${raw}`]
    for (const candidate of candidates) {
      if (await $.fs.exists(`${candidate}/state.sqlite3`)) return candidate
    }
    // basename：在工作区根下按前缀匹配唯一任务目录
    const entries = await $.fs.list(cwd).catch(() => [])
    const hits = (entries as any[])
      .map(x => String(x?.name ?? x?.path ?? ''))
      .filter(name => name === raw || name.startsWith(`${raw}-`))
      .map(name => `${cwd}/${name}`)
    if (hits.length === 1 && await $.fs.exists(`${hits[0]}/state.sqlite3`)) return hits[0]!
    throw new Error(`找不到任务目录：${ref}（需要包含 state.sqlite3 的目录）`)
  }
  const toolKey = (e: any) => String(e.toolUseId ?? e.tool_use_id ?? e.id ?? `${e.agentId ?? e.agent_id ?? 'main'}:${e.tool ?? e.tool_name ?? ''}`)
  const current = async () => selected && controller ? controller.get(selected) : undefined
  const event = async (type: string, fields: Record<string, unknown> = {}) => {
    if (!controller || !selected) throw new Error(startupError || '没有选中的 run；先 start 或 recover run=<id>')
    return controller.dispatch(selected, { type, ...fields, now: now() } as any)
  }
  const active = async () => {
    const r = await current()
    return r && !TERMINAL.has(r.status) ? r : undefined
  }
  const owned = (r: Run) => { if (r.ownerSessionId !== sessionId) throw new Error('当前会话不是 run owner；历史状态只读，不能绕过宿主归属验证。') }
  const tell = async ($: any, message: string) => {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: message }] } })
    await $.ui.status(message.slice(0, 180))
    // Deliberately do not submit another prompt: notifications cannot create a new execution session.
  }
  const writeManifest = async ($: any, r: Run) => {
    try { await $.fs.write(`${r.deliverDir}/manifest.json`, JSON.stringify(r, null, 2)) }
    catch { await $.ui.status('run 已事务保存；manifest 导出失败，可用 status 查询。') }
  }
  // ---- 临时 worktree：每个 attempt 一个，结束后只回收声明的文件 ----
  const repoRoot = async ($: any): Promise<string> => {
    const res = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: 5000 }).catch(() => undefined)
    return res && res.exitCode === 0 ? path(String(res.stdout).trim(), '') : ''
  }
  const makeWorkspace = async ($: any, dir: string, attemptId: string): Promise<string> => {
    const root = await repoRoot($)
    if (!root) return ''
    const ws = `${dir}/workspaces/${attemptId}`
    const res = await $.process.run(['git', 'worktree', 'add', '--detach', ws, 'HEAD'], { cwd: root, timeoutMs: 60000 }).catch(() => undefined)
    return res && res.exitCode === 0 ? ws : ''
  }
  const dropWorkspace = async ($: any, ws: string): Promise<void> => {
    if (!ws) return
    await $.process.run(['git', 'worktree', 'remove', '--force', ws], { cwd, timeoutMs: 60000 }).catch(() => undefined)
    const parent = ws.slice(0, ws.lastIndexOf('/'))
    if (parent && parent.endsWith('/workspaces')) await $.process.run(['rmdir', parent], { cwd, timeoutMs: 5000 }).catch(() => undefined)
  }
  /** 把声明文件从 worktree 抄到 dest（默认项目路径），返回抄了哪些 */
  const copyDeclared = async ($: any, r: Run, attempt: Attempt, dest?: string): Promise<{ files: string[]; complete: boolean }> => {
    const task = r.tasks[attempt.taskId]
    if (!task) return { files: [], complete: false }
    if (!attempt.workspace) return { files: [], complete: true }
    const root = await repoRoot($)
    const files: string[] = []
    for (const file of task.allowedFiles) {
      const rel = root && file.startsWith(`${root}/`) ? file.slice(root.length + 1) : ''
      if (!rel) continue
      const src = `${attempt.workspace}/${rel}`
      if (!(await $.fs.exists(src))) continue
      const text = await $.fs.read(src).catch(() => undefined)
      if (text === undefined) continue
      await $.fs.write(dest ? `${dest}/${rel}` : file, text)
      files.push(rel)
    }
    return { files, complete: files.length === task.allowedFiles.filter(f => root && f.startsWith(`${root}/`)).length && files.length > 0 }
  }
  /** 打断/结束时收敛：停 worker → 抢救产物 → attempt-ended */
  const shutdown = async ($: any, r: Run, reason: string) => {
    let latest = r
    for (const attempt of Object.values(latest.attempts)) {
      if (!attempt.managed || ATTEMPT_TERMINAL.has(attempt.status)) continue
      const stopped = attempt.agentId ? await stopAgent($, attempt.agentId) : { ok: true }
      if (attempt.workspace) {
        const salvageDir = `${latest.deliverDir}/salvage/${attempt.id}`
        const copied = await copyDeclared($, latest, attempt, salvageDir).catch(() => ({ files: [], complete: false }))
        await $.fs.write(`${salvageDir}/README.md`, `attempt ${attempt.id}\n状态：${attempt.status}\n原因：${reason}\n已抢救：${copied.files.join(', ') || '无'}\n`)
        latest = await event('salvage', { attemptId: attempt.id, dir: salvageDir, files: copied.files, complete: copied.complete })
        await dropWorkspace($, attempt.workspace)
      }
      latest = await event('attempt-ended', { attemptId: attempt.id, reason, stopConfirmed: stopped.ok })
    }
    return latest
  }

  const reconcile = async ($: any, r: Run) => {
    const rows = await listAgents($)
    if (rows === undefined) return '宿主列表查询失败；保留原状态，不推断失败。'
    for (const a of Object.values(r.attempts)) {
      if (!a.managed || ATTEMPT_TERMINAL.has(a.status)) continue
      const hit = rows.find(x => x.id === a.agentId || (!a.agentId && x.name === a.name))
      if (hit && !a.agentId) {
        // Reconcile the durable creation intent even when the recovered worker has
        // already finished. Completion must reference a bound identity.
        await event('attempt-started', { attemptId: a.id, agentId: hit.id, resolvedModel: a.resolvedModel ?? a.requestedModel })
      }
      if (!hit) {
        await event('attempt-ended', { attemptId: a.id, reason: '宿主已不可见；按会话结束收敛', stopConfirmed: false })
      } else if (/^(running|pending|queued)$/.test(hit.status)) {
        await event('attempt-reconciled', { attemptId: a.id, status: 'running' })
      } else if (/^(completed|done)$/.test(hit.status)) {
        await event('attempt-finished', { agentId: hit.id, outcome: 'completed', reason: '宿主列表明确报告完成' })
      } else if (/^(failed|cancelled|stopped)$/.test(hit.status)) {
        await event('attempt-finished', { agentId: hit.id, outcome: 'failed', reason: `宿主状态 ${hit.status}` })
      }
    }
    return `宿主当前可见 ${rows.length} 个；列表为空不等于从未启动或失败。`
  }
  const start = async ($: any, a: any) => {
    const ms = typeof a.budgetMs === 'number' ? a.budgetMs : parseDuration(String(a.duration ?? '5m'))
    if (!ms || !Number.isFinite(ms) || ms <= 0) throw new Error('预算必须是正时长')
    const id = makeRunId(now(), String(a.task ?? '任务'))
    const dir = `${cwd}/${id}`
    await $.fs.write(`${dir}/cards/.gitkeep`, '')
    // 任务目录是本地副产物：只在本地排除，不改动受版本控制的 .gitignore
    const gitDir = await $.process.run(['git', 'rev-parse', '--git-path', 'info/exclude'], { cwd, timeoutMs: 5000 }).catch(() => undefined)
    if (gitDir && gitDir.exitCode === 0) {
      const target = path(String(gitDir.stdout).trim(), cwd)
      const existing = await $.fs.read(target).catch(() => '')
      if (!existing.includes(`${id}/`)) await $.fs.write(target, `${existing}${existing.endsWith('\n') || !existing ? '' : '\n'}${id}/\n`)
    }
    await openTask($, dir)
    const r = await controller!.create({ id, project: cwd, sessionId, task: String(a.task ?? ''), budgetMs: ms, now: now(), deliverDir: dir })
    selected = r.id
    const cadence = typeof a.cadence === 'object' ? a.cadence : extractCadence(String(a.cadence ?? '')).cadence
    await event('configure', { config: { step: cadence?.kind === 'fraction' ? cadence.step : Number(opt.default_step_percent ?? 10) / 100, cadenceMs: cadence?.kind === 'interval' ? cadence.ms : undefined, extraMarksMs: a.extraMarksMs ?? [] } })
    return `已创建任务目录 ${dir}，预算 ${fmt(ms)}。\n任务卡放 ${dir}/cards/ 或任意路径；dispatch 的 card_path 传路径。每个 worker 声明独立 files（会跑在临时 worktree 里）。所有问题使用 AskUserQuestion；暂停预算不暂停 worker。\n${HELP}`
  }
  const targets = (r: Run, name: string | undefined) => {
    const managed = Object.values(r.attempts).filter(a => a.managed && !ATTEMPT_TERMINAL.has(a.status))
    return name === 'all' ? managed : name === 'last' || !name ? managed.slice(-1) : managed.filter(a => a.id === name || a.agentId === name)
  }
  const act = async ($: any, a: any): Promise<string> => {
    if (timerFault && !['status', 'list', 'recover', 'cancel', 'help'].includes(a.action)) throw new Error(`存储熔断：${timerFault.slice(0, 150)}。先恢复存储并 recover。`)
    if (a.action === 'help') return HELP
    if (a.action === 'decline') { declined = true; return '本会话不再提示开启预算。' }
    if (a.action === 'start') return start($, a)
    if (a.action === 'list') {
      const entries = await $.fs.list(cwd).catch(() => [])
      const dirs: string[] = []
      for (const entry of entries as any[]) {
        const name = String(entry?.name ?? entry?.path ?? '')
        if (name && await $.fs.exists(`${cwd}/${name}/state.sqlite3`)) dirs.push(`${cwd}/${name}`)
      }
      const rows: any[] = []
      for (const dir of dirs.sort().reverse()) {
        try {
          const probe = await createRunStore($, dir, $.plugin.root)
          for (const row of await probe.list()) rows.push({ ...row, taskDir: dir })
        } catch { rows.push({ taskDir: dir, error: '状态库不可读' }) }
      }
      return JSON.stringify(rows, null, 2)
    }
    if (a.action === 'recover') {
      if (!a.run) throw new Error('recover 需要任务目录路径（或目录名）')
      const dir = await resolveTaskDir($, a.run)
      await openTask($, dir)
      selected = dir.split('/').pop()!
      const found = await controller!.get(selected)
      if (!found) throw new Error(`${dir} 里没有可识别的 run`)
      if (TERMINAL.has(found.status)) return `已关闭的任务，仅可查看。\n${status(found)}`
      await event('recover', { sessionId })
      const resumed = await event('cycle-start')
      timerFault = ''
      const note = await reconcile($, resumed)
      return `${note}\n\n继续：cycle=${resumed.cycle ?? 0}，阶段已重置为 ${resumed.phase}。\n${brief(resumed)}`
    }
    let r = await current()
    if (a.action === 'status' && a.run) {
      const dir = await resolveTaskDir($, a.run)
      await openTask($, dir)
      selected = dir.split('/').pop()!
      r = await current()
    }
    if (a.action === 'status') return r ? status(r) : `没有选中的任务。${startupError || '给一个任务目录路径，或先 start。'}`
    if (!r) throw new Error(startupError || '没有选中的 run')
    owned(r)
    if (TERMINAL.has(r.status) && !['probe','stop','view'].includes(a.action)) throw new Error('run 已关闭；仅允许查询或清理未结束的执行，不恢复工作')
    // idle 只是"上一轮结束、暂无工作"的常态，不是需要用户决策的阻塞原因。
    if (!['status','list','help','recover','cancel','probe','view','say','stop'].includes(a.action)) {
      if (r.status === 'interrupted') throw new Error('run 已中断：先 probe 对账，再用 recover 明确恢复')
      const blocking = Object.keys(r.pauses).filter(x => x !== 'idle')
      if (blocking.length) throw new Error(`run 处于等待：${blocking.join(', ')}，先处理该原因`)
      if (r.pauses.idle) r = await event('resume', { reason: 'idle' })
    }
    switch (a.action) {
      case 'resume':
        if (!a.reason || !r.pauses[a.reason]) throw new Error('必须指定 status 中实际存在的暂停原因')
        if (asks.has(a.reason)) throw new Error('提问仍在等待用户，不能提前解除')
        return status(await event('resume', { reason: a.reason }))
      case 'phase':
        if (!['pre-explore', 'explore', 'implement', 'verify'].includes(a.phase)) throw new Error('无效阶段')
        return status(await event('phase', { phase: a.phase }))
      case 'plan': {
        const estimates = typeof a.estimates === 'string' ? JSON.parse(a.estimates) : a.estimates
        if (!estimates || Object.values(estimates).some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0)) throw new Error('estimates 必须是阶段到非负秒数的对象')
        await event('plan', { estimates }); return '预算计划已事务保存。'
      }
      case 'extend': {
        const ms = Number(a.minutes) * 60000
        if (!Number.isFinite(ms) || ms <= 0) throw new Error('minutes 必须为正数')
        const next = await event('extend', { ms })
        for (const w of targets(next, 'all')) if (w.agentId) await sendTo($, w.agentId, `预算延长，剩余工作预算 ${fmt(Math.max(0, next.budgetMs - elapsed(next, now())))}。主预算暂停不停止你的执行；旧卡绝对截止时间已失效。`)
        return status(next)
      }
      case 'gate':
        if (!String(a.reason ?? '').trim()) throw new Error('豁免必须说明原因')
        await event('waive', { reason: a.reason }); return '已为当前修改版本登记豁免；后续修改会使豁免失效。'
      case 'close':
      case 'cancel': {
        const cancelled = a.action === 'cancel' || a.status === 'cancelled'
        if (!cancelled && a.status && a.status !== 'delivered') throw new Error('超时不是关闭；请延期或明确取消。')
        if (cancelled) {
          for (const w of targets(r, 'all')) if (w.agentId) {
            const stopped = await stopAgent($, w.agentId)
            if (stopped.ok) await event('attempt-finished', { agentId: w.agentId, outcome: 'failed', reason: '用户取消，宿主确认停止' })
            else await sendTo($, w.agentId, '用户取消本 run，请停止工作并汇报。')
          }
        }
        if (!cancelled && dispatchBusy) throw new Error('派发批次尚未结束，不能完成交付')
        const next = await event(cancelled ? 'cancel' : 'complete', { reason: String(a.summary ?? (cancelled ? '用户取消' : '完成交付')) })
        await writeManifest($, next); await $.ui.status(undefined)
        return status(next)
      }
      case 'dispatch': {
        if (dispatchBusy) throw new Error('另一个派发批次正在处理；不要重复派发')
        if (!['running', 'verifying'].includes(r.status)) throw new Error('run 暂停或中断，先解除暂停或恢复')
        const raw = typeof a.workers === 'string' ? JSON.parse(a.workers) : a.workers
        const normalized = Array.isArray(raw) ? raw.map(w => ({ ...w, card: w.card_path ?? w.card })) : raw
        const parsed = parseDispatch(normalized, catalog, maxWorkers)
        if (!parsed.ok) throw new Error(parsed.error)
        const live = Object.values(r.attempts).filter(w => w.managed && !ATTEMPT_TERMINAL.has(w.status))
        if (live.length + parsed.workers.length > maxWorkers) throw new Error('并发或状态待确认任务超过上限；先处理现有执行')
        const occupied = new Set(live.flatMap(w => r.tasks[w.taskId]?.allowedFiles ?? []))
        // Entire batch preflight before any spawn or side-effecting task registration.
        for (const w of parsed.workers) {
          if (Object.values(r.tasks).some(t => t.label === w.label && !taskDone(r, t))) throw new Error(`label 已存在且未完成：${w.label}；已完成任务请用 redo=true 显式重做`)
          w.card = path(w.card, cwd)
          if (/[\r\n]/.test(w.card) || !(await $.fs.exists(w.card))) throw new Error(`card_path 必须是一个存在的文件路径，不是正文：${w.card}`)
          const text = await $.fs.read(w.card)
          if (!text.trim()) throw new Error(`任务卡为空：${w.label}`)
          if (!w.files.length) throw new Error(`${w.label} 必须声明 files，不能默认无限制写入`)
          w.files = w.files.map(f => path(f, cwd))
          for (const f of w.files) {
            if (!f.startsWith(`${cwd}/`) || f.startsWith(`${r.deliverDir}/`)) throw new Error(`非法文件归属：${f}`)
            if (occupied.has(f)) throw new Error(`文件与其他执行冲突：${f}`)
            occupied.add(f)
          }
        }
        dispatchBusy = true
        const results: string[] = []
        try {
          for (const w of parsed.workers) {
            const taskId = `task-${++sequence}-${now()}`
            const attemptId = `${taskId}-a1`
            const name = `${workerName(r.id, w.label).slice(0, 40)}-${now().toString(36)}-${sequence}`
            const model = w.model.mode === 'route' ? w.model.route : w.model.mode === 'alias' ? w.model.alias : 'inherit'
            await event('task-added', { task: { id: taskId, label: w.label, cardPath: w.card, allowedFiles: w.files, attemptIds: [] } })
            const workspace = await makeWorkspace($, r.deliverDir, attemptId)
            await event('attempt-created', { attempt: { id: attemptId, taskId, ownerSessionId: sessionId, name, requestedModel: model, status: 'creating', managed: true, createdAt: now(), updatedAt: now(), cycle: r.cycle ?? 0, workspace } })
            if (w.model.mode === 'route') routes.set(name, w.model.route)
            try {
              const spawned = await spawnAgent($, {
                name, description: w.description, cwd: workspace || cwd,
                subagentType: 'general-purpose', model: w.model.mode === 'alias' ? w.model.alias : undefined,
                prompt: `${buildWorkerPrompt({ label: w.label, cardPath: w.card, runId: r.id, modelLabel: model, workspace })}\n稳定任务标识 ${taskId}，执行标识 ${attemptId}。工作目录是隔离副本；只读取本卡，只写声明文件。预算由主控管理；如收到暂停/延长通知，以最新通知为准。`,
              })
              if (!spawned.ok) {
                await event('attempt-ended', { attemptId, reason: `spawn 未确认成功：${spawned.note}`, stopConfirmed: false })
                await dropWorkspace($, workspace)
                results.push(`${w.label}：创建失败 ${spawned.note}`)
              } else {
                await event('attempt-started', { attemptId, agentId: spawned.agentId, resolvedModel: spawned.model })
                const normalizedModel = (s: string) => s.toLowerCase().replace(/\[[0-9]+[mk]\]/g, '')
                if (w.model.mode === 'route' && normalizedModel(spawned.model) !== normalizedModel(w.model.route)) {
                  const stopped = await stopAgent($, spawned.agentId)
                  await event('attempt-finished', { agentId: spawned.agentId, outcome: 'failed', reason: `模型不匹配：请求 ${w.model.route}，宿主解析 ${spawned.model}` })
                  if (workspace) await dropWorkspace($, workspace)
                  results.push(`${w.label}：模型不匹配，${stopped.ok ? '已停止' : '停止未确认'}；不自动重派`)
                } else results.push(`${w.label}：attempt=${attemptId} agent=${spawned.agentId} model=${spawned.model}${workspace ? '（worktree）' : '（共享工作区）'}`)
              }
            } finally { routes.delete(name) }
          }
        } finally { dispatchBusy = false }
        return results.join('\n')
      }
      case 'retry': {
        if (!['running','verifying'].includes(r.status)) throw new Error('先恢复运行状态再重试')
        const previous = Object.values(r.attempts).find(w => w.id === a.worker || w.agentId === a.worker)
        if (!previous?.managed || previous.status !== 'failed') throw new Error('只允许显式重试宿主已确认结束的 failed attempt；unknown/interrupted 不能重试')
        const task = r.tasks[previous.taskId]
        if (!task) throw new Error('任务契约缺失')
        const parsed = parseDispatch([{label:task.label,model:previous.requestedModel,card:task.cardPath,files:task.allowedFiles}],catalog,maxWorkers)
        if (!parsed.ok) throw new Error(parsed.error)
        const w = parsed.workers[0]!
        if (!(await $.fs.read(task.cardPath)).trim()) throw new Error('任务卡不存在或为空')
        const live = targets(r,'all')
        if (live.length >= maxWorkers) throw new Error('并发上限已满')
        if (live.some(x => x.taskId === task.id || (r.tasks[x.taskId]?.allowedFiles ?? []).some(f => task.allowedFiles.includes(f)))) throw new Error('原任务或文件仍被未结束执行占用')
        const attemptId = `${task.id}-retry-${now()}-${++sequence}`
        const name = `orch-retry-${now().toString(36)}-${sequence}`
        await event('attempt-created',{attempt:{id:attemptId,taskId:task.id,ownerSessionId:sessionId,name,requestedModel:previous.requestedModel,status:'creating',managed:true,createdAt:now(),updatedAt:now()}})
        dispatchBusy = true
        if (w.model.mode === 'route') routes.set(name,w.model.route)
        try {
          const spawned = await spawnAgent($,{name,description:`重试 ${task.label}`,cwd,subagentType:'general-purpose',model:w.model.mode === 'alias' ? w.model.alias : undefined,prompt:buildWorkerPrompt({label:task.label,cardPath:task.cardPath,runId:r.id,modelLabel:previous.requestedModel}) + `\n这是显式重试 attempt=${attemptId}，原执行已确认失败。先检查现有产物，避免重复副作用。`})
          if (!spawned.ok) {
            await event('attempt-ended',{attemptId,reason:`重试创建失败：${spawned.note}`,stopConfirmed:false})
            return '重试创建失败；任务仍待办，可在下次继续时重派。'
          }
          await event('attempt-started',{attemptId,agentId:spawned.agentId,resolvedModel:spawned.model})
          if (w.model.mode === 'route' && spawned.model.toLowerCase().replace(/\[[0-9]+[mk]\]/g,'') !== w.model.route.toLowerCase().replace(/\[[0-9]+[mk]\]/g,'')) {
            await stopAgent($,spawned.agentId)
            await event('attempt-finished',{agentId:spawned.agentId,outcome:'failed',reason:'重试模型不匹配'})
            return '重试模型不匹配，未继续宣称成功。'
          }
          return `新执行 attempt=${attemptId} agent=${spawned.agentId}；保留原失败记录。`
        } finally { routes.delete(name);dispatchBusy=false }
      }
      case 'probe': return `${await reconcile($, r)}\n${status((await current())!)}`
      case 'card': {
        const target = targets(r, a.worker)[0]
        if (!target) throw new Error('未找到 managed worker')
        const files = (Array.isArray(a.files) ? a.files : String(a.files ?? '').split(/[,\n]/)).map((f: string) => path(f.trim(), cwd))
        if (!files.length || files.some((f: string) => !f.startsWith(`${cwd}/`) || f.includes('/.budget/'))) throw new Error('扩展files须为项目内非预算存储文件')
        const others = targets(r, 'all').filter(w => w.taskId !== target.taskId).flatMap(w => r.tasks[w.taskId]?.allowedFiles ?? [])
        if (files.some((f: string) => others.includes(f))) throw new Error('与其他运行任务文件冲突')
        await event('allow-files', { taskId: target.taskId, files }); return '已更新文件契约。'
      }
      case 'say':
      case 'stop': {
        const selectedTargets = targets(r, a.worker)
        if (!selectedTargets.length) throw new Error('未找到匹配的未结束 managed worker')
        const lines: string[] = []
        for (const w of selectedTargets) {
          if (!w.agentId) { lines.push(`${w.id}：宿主身份未确认，不能操作`); continue }
          if (a.action === 'say') {
            const sent = await sendTo($, w.agentId, String(a.message ?? ''))
            lines.push(`${w.id}：${sent.ok ? '消息已提交，非完成确认' : sent.note}`)
          } else {
            const stopped = await stopAgent($, w.agentId)
            if (stopped.ok) await event('attempt-finished', { agentId: w.agentId, outcome: 'failed', reason: '宿主确认停止' })
            else await sendTo($, w.agentId, '请停止执行并汇报，主控正在请求收尾。')
            lines.push(`${w.id}：${stopped.ok ? '已停止' : '硬停止未确认，已请求收尾；不标记完成'}`)
          }
        }
        return lines.join('\n')
      }
      case 'view': {
        const w = Object.values(r.attempts).find(w => w.agentId === a.worker || w.id === a.worker)
        if (!w?.agentId) throw new Error('worker 不存在或尚无宿主ID')
        return JSON.stringify(await agentMessages($, w.agentId, Math.min(30, Number(a.limit) || 10)))
      }
      case 'ref': await event('ref', { run: String(a.run ?? ''), phrase: String(a.phrase ?? '') }); return '已登记历史引用，不转移执行权限。'
      default: throw new Error('未知 action；使用 help')
    }
  }

  const tick = async ($: any) => {
    if (timerBusy || timerFault) return
    timerBusy = true
    try {
      let r = await active()
      if (!r || r.ownerSessionId !== sessionId || r.status === 'interrupted' || Object.keys(r.pauses).length) return
      if (now() - lastCheckpoint > 5000) { r = await event('checkpoint'); lastCheckpoint = now() }
      const used = elapsed(r, now())
      const interval = r.config?.cadenceMs || Math.max(1000, r.budgetMs * (r.config?.step ?? 0.1))
      const key = used >= r.budgetMs ? 'overdue' : `interval:${Math.floor(used / interval)}`
      if ((used >= r.budgetMs || used >= interval) && !r.firedMarks.includes(key)) {
        await event('mark', { key })
        if (used >= r.budgetMs) {
          for (const w of targets(r, 'all')) if (w.agentId) await sendTo($, w.agentId, '预算已耗尽，请收尾并报告。不要开启新的工作块；等待明确延期。')
        }
        await tell($, `${status((await current())!)}${used >= r.budgetMs ? '\n预算耗尽但 run 未关闭。主 agent 应用 AskUserQuestion 请求延期或取消，不自动重派。' : ''}`)
      } else await $.ui.status(`⏱ ${fmt(used)} / ${fmt(r.budgetMs)}`)
    } catch (e) { timerFault = String(e); await $.ui.status(`编排状态保存失败：${timerFault.slice(0, 160)}；停止自动调度，修复后显式 recover`) }
    finally { timerBusy = false }
  }

export const register: Register = (on, options) => {
  opt = options as Record<string, unknown>
  on('session.start', async ($, e, next) => {
    sessionId = await $.session.id(); cwd = path(e.cwd, '')
    selected = undefined; selectedDir = ''; controller = undefined; store = undefined; startupError = ''
    routes.clear(); asks.clear(); toolChecks.clear(); toolEdits.clear()
    // Storage is opened lazily against a task directory: a task is addressed by its
    // path, so nothing is bound to this session until start or recover names one.
    try {
      const home = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${await $.env.get('HOME') || await $.env.get('USERPROFILE')}/.claude`
      catalog = parseCatalog(await $.fs.read(`${home}/settings.json`))
    } catch (e) { startupError = String(e); await $.ui.status(`编排初始化：${startupError.slice(0, 180)}`) }
    const rawCap = Number(await $.env.get('CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS'))
    const envCap = Number.isFinite(rawCap) && rawCap > 0 ? Math.floor(rawCap) : 20
    const configured = Number(opt.max_concurrent_workers)
    maxWorkers = Math.max(1, Math.min(envCap, Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : envCap))
    await $.command.register({ name: 'orcheatractor-zhaowendao', description: '持久化编排与预算状态机', argumentHint: '10m 任务 | 状态 | 延时 5m | 关闭' })
    await registerModelSearchCommand($)
    await $.tool.register({ name: 'budget', description: HELP, isDeferred: true, inputSchema: {
      type: 'object', properties: {
        action: { type: 'string', enum: ['start','status','list','recover','resume','dispatch','retry','probe','phase','plan','extend','gate','close','cancel','card','say','stop','view','ref','decline','help'] },
        duration:{type:'string'}, cadence:{type:'string'}, task:{type:'string'}, run:{type:'string'}, worker:{type:'string'}, phase:{type:'string'}, estimates:{type:'string'}, minutes:{type:'string'}, reason:{type:'string'}, summary:{type:'string'}, status:{type:'string'}, files:{type:'string'}, message:{type:'string'}, limit:{type:'string'}, phrase:{type:'string'},
        workers:{type:'array',items:{type:'object',properties:{label:{type:'string'},model:{type:'string'},card_path:{type:'string',description:'本run cards目录下的任务卡文件路径，绝不是任务正文'},card:{type:'string',description:'兼容旧card_path别名'},description:{type:'string'},files:{type:'array',items:{type:'string'}}},required:['label','model','files']}},
      }, required:['action'],
    }} as any)
    $.clock.every(1000, () => void tick($))
    return next(e)
  })
  on('agent.spawn', async ($, e: any, next) => {
    const route = routes.get(String(e.name ?? ''))
    return next(route ? { ...e, model: route } : e)
  })
  on('command.run', {command:'orcheatractor-zhaowendao'}, async ($, e) => {
    try {
      const cmd = parseBudgetArgs(e.args)
      if (cmd.action === 'error') return {text:cmd.message}
      const a = cmd.action === 'stop' ? {action:'cancel'} : cmd.action === 'extend' ? {action:'extend',minutes:String(cmd.ms / 60000)} : cmd
      const text = await runAction($, a)
      // 不能在 command.run 里 prompt.submit（会等自己占着的这一轮）。任务通过
      // context 交给主 agent，同一条命令结果里就能读到并开始执行。
      const task = cmd.action === 'start' && cmd.task ? String(cmd.task) : ''
      return { text, context: task ? [text, `用户交给你的任务：${task}`] : [text] }
    } catch (e) { return {text:`编排操作失败：${String(e).slice(0,500)}`} }
  })
  on('tool.call', {tool:'mcp__orcheatractor-zhaowendao__budget'}, async ($, e: any) => {
    try { return {result:[{type:'text',text:await runAction($,e)}]} }
    catch (err) { return {result:[{type:'text',text:`编排操作失败：${String(err).slice(0,600)}`}],isError:true} }
  })

  on('turn.start', async ($, e: any, next) => {
    const r = await active()
    if (r && !e.agentId && r.status !== 'interrupted') await event('resume',{reason:'idle'})
    return next(e)
  })
  on('prompt.submit', async ($, e: any, next) => {
    if (!declined && opt.auto_detect !== false && !await active() && !e.isMeta && e.origin?.kind !== 'plugin' && e.origin?.kind !== 'task-notification') {
      const hit = detectTimeRequirement(String(e.text ?? ''))
      if (hit) await tell($,'发现时间要求。先用 AskUserQuestion 确认是否开启持久化预算；不要自动启动。')
    }
    return next(e)
  })
  on('classic.SubagentStart', async ($, e: any, next) => {
    const r = await active()
    if (!r) return next(e)
    const rows = await listAgents($)
    const self = rows?.find(w => w.id === e.agent_id)
    const intent = Object.values(r.attempts).find(a => a.agentId === e.agent_id || (self?.name && a.name === self.name))
    if (intent && !intent.agentId) await event('attempt-started',{attemptId:intent.id,agentId:e.agent_id,resolvedModel:intent.requestedModel})
    else if (!intent && !dispatchBusy) await event('attempt-observed',{attempt:{id:`observed-${e.agent_id}`,taskId:'',agentId:e.agent_id,name:self?.name ?? e.agent_type,ownerSessionId:sessionId,requestedModel:'unknown',status:'running',managed:false,createdAt:now(),updatedAt:now()}})
    // During dispatch an unidentified start is resolved by spawn's returned ID, never treated as managed implicitly.
    return next(e)
  })
  on('classic.SubagentStop', async ($, e: any, next) => {
    // Host stop is not success evidence and not an interruption of the task:
    // turn.complete decides success, shutdown decides ended. Nothing to record here.
    return next(e)
  })
  on('tool.call', async ($, e: any, next) => {
    const r = await current()
    if (!r) return next(e)
    const tool = String(e.tool ?? ''), key = toolKey(e), agentId = e.agentId
    const attempt = agentId ? Object.values(r.attempts).find(a => a.agentId === agentId) : undefined
    if (attempt?.managed && (TERMINAL.has(r.status) || r.status === 'interrupted' || ATTEMPT_TERMINAL.has(attempt.status)) && (WRITES.has(tool) || ['Bash','Agent','Skill'].includes(tool))) {
      return {deny:'run 已关闭/中断或执行已结束，禁止继续写入或运行命令；先由主控确认恢复。'} as any
    }
    if (TERMINAL.has(r.status)) return next(e)
    if (tool === 'AskUserQuestion' && !agentId) {
      const reason = `waiting_user:${key}`
      asks.add(reason); await event('pause',{reason})
      try { return await next(e) }
      finally { asks.delete(reason); if (await active()) await event('resume',{reason}) }
    }
    if (agentId) {
      const a = Object.values(r.attempts).find(a=>a.agentId===agentId)
      // Observed agents are not controlled, counted as edits, or stopped by this run.
      if (!a && dispatchBusy && (WRITES.has(tool) || ['Agent','Skill','Bash'].includes(tool))) return {deny:'派发身份尚在登记，暂不能执行写入或命令；等待宿主ID绑定后重试。'} as any
      if (!a?.managed) return next(e)
      if (a.managed) {
        if (['Agent','Skill'].includes(tool)) return {deny:'managed worker 不得派生代理。'} as any
        if (WRITES.has(tool)) {
          const file = e.file_path ?? e.notebook_path
          if (typeof file !== 'string') return {deny:'写入目标不明确。'} as any
          const declared = r.tasks[a.taskId]?.allowedFiles ?? []
          const base = a.workspace || cwd
          const target = path(file, base)
          if (a.workspace) {
            // 隔离副本里的相对路径映射回项目声明路径再校验
            if (!target.startsWith(`${a.workspace}/`)) return { deny: `这是隔离副本；请用相对路径写入，不要写主工作树路径：${file}` } as any
            const mapped = `${cwd}/${target.slice(a.workspace.length + 1)}`
            if (!allowed(mapped, declared, cwd)) return { deny: '写入目标不在当前任务明确声明的 files 内。' } as any
          } else if (!allowed(target, declared, cwd)) return {deny:'写入目标不在当前任务明确声明的 files 内。'} as any
        }
      }
    }
    // Shell commands may write without a Write/Edit event. Conservatively invalidate
    // verification for every non-check shell command; files is not a shell sandbox.
    if (WRITES.has(tool) || (tool === 'Bash' && !isCheckCommand(String(e.command ?? '')))) {
      const updated = await event('edit')
      toolEdits.set(key,updated.check.editRevision)
    }
    if (tool === 'Bash' && isCheckCommand(String(e.command ?? ''))) toolChecks.set(key,r.check.editRevision)
    return next(e)
  })
  on('classic.PostToolUse', async ($, e: any, next) => {
    const r = await active()
    if (!r) return next(e)
    const key = toolKey(e)
    if (toolChecks.has(key)) {
      const revision = toolChecks.get(key)
      toolChecks.delete(key)
      await event('check',{passed:!responseFailed(e.tool_response),revision})
    }
    toolEdits.delete(key)
    return next(e)
  })
  on('turn.complete', async ($, e: any, next) => {
    const r = await current()
    if (!r) return next(e)
    if (e.agentId) {
      const attempt = Object.values(r.attempts).find(a => a.agentId === e.agentId)
      if (attempt) {
        // 回收声明文件 → 记录 merge → 才算完成
        let after = r
        const copied = await copyDeclared($, r, attempt).catch(() => ({ files: [], complete: false }))
        const task = r.tasks[attempt.taskId]
        const status = !attempt.workspace ? 'skipped' as const
          : copied.complete ? 'done' as const
          : copied.files.length ? 'partial' as const : 'conflict' as const
        after = await event('merge', { attemptId: attempt.id, status, detail: copied.files.join(',') || (task ? '未回收任何声明文件' : '') })
        await event('attempt-finished', { agentId: e.agentId, outcome: 'completed', actualModel: e.usage?.model, reason: `宿主完成；回收 ${copied.files.length} 个文件` })
        if (attempt.workspace) await dropWorkspace($, attempt.workspace)
      }
    } else if (!r.pauses.idle) await event('pause',{reason:'idle'})
    return next(e)
  })
  on('classic.Stop', async ($, e: any, next) => {
    const r = await active()
    if (!r || e.agent_id || e.agentId) return next(e)
    if (r.phase === 'verify') {
      const problems = completionProblems(r)
      if (problems.length) return {block:`交付条件未满足：${problems.join('；')}。可明确取消，不能伪报完成。`}
      const closed = await event('complete',{reason:'验收完成，统一交付门禁通过'})
      await writeManifest($,closed)
    } else if (!r.pauses.idle) await event('pause',{reason:'idle'})
    return next(e)
  })
  on('turn.abort', async ($, e: any, next) => {
    const r = await active()
    if (r) await shutdown($, r, '主回合被中止（用户打断）：worker 随会话终止').catch(() => undefined)
    return next(e)
  })
  on('session.end', async ($, e: any, next) => {
    const r = await active()
    if (r) {
      // worker 的生命周期跟随主会话：收敛为 ended，抢救产物，再标记任务中断
      const settledRun = await shutdown($, r, `会话结束（${String(e.reason)}）：worker 随会话终止`).catch(() => r)
      const interrupted = await event('interrupt', { reason: `会话结束：${String(e.reason)}` })
      await writeManifest($, interrupted)
      void settledRun
    }
    return next(e)
  })
}
