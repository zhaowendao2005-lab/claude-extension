// Host bridge only. All authoritative transitions go through the durable controller.
import type { Register } from 'claude-code'
import { RunController } from '../core/controller'
import { completionProblems, counts, elapsed, type Run, type Attempt } from '../core/state'
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
        await event('attempt-unknown', { attemptId: a.id, reason: '当前宿主列表不可见；未确认终止，不自动重派' })
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
    if (!controller || !store) throw new Error(startupError || '存储未初始化')
    if (await active()) throw new Error('当前已有未关闭 run；先完成或明确取消，不覆盖它。')
    const unfinished = (await store.list()).filter(r => !TERMINAL.has(r.status))
    if (unfinished.length) throw new Error(`项目仍有未关闭 run：${unfinished.map(r => `${r.id} owner=${r.ownerSessionId}`).join(', ')}。先恢复原 owner 并处理；不创建可能冲突的执行。`)
    const ms = typeof a.budgetMs === 'number' ? a.budgetMs : parseDuration(String(a.duration ?? '5m'))
    if (!ms || !Number.isFinite(ms) || ms <= 0) throw new Error('预算必须是正时长')
    const id = makeRunId(now(), String(a.task ?? '任务'))
    const r = await controller.create({ id, project: cwd, sessionId, task: String(a.task ?? ''), budgetMs: ms, now: now(), deliverDir: `${cwd}/.budget/runs/${id}` })
    selected = r.id
    const cadence = typeof a.cadence === 'object' ? a.cadence : extractCadence(String(a.cadence ?? '')).cadence
    await event('configure', { config: { step: cadence?.kind === 'fraction' ? cadence.step : Number(opt.default_step_percent ?? 10) / 100, cadenceMs: cadence?.kind === 'interval' ? cadence.ms : undefined, extraMarksMs: a.extraMarksMs ?? [] } })
    await $.fs.write(`${r.deliverDir}/cards/.gitkeep`, '')
    await $.fs.write(`${r.deliverDir}/.gitignore`, '*\n')
    await $.fs.write(`${r.deliverDir}/.ignore`, '*\n')
    return `已创建 ${r.id}，预算 ${fmt(ms)}。\n任务卡写入 ${r.deliverDir}/cards/，dispatch 的 card_path 传路径；每个 worker 必须声明独立 files。所有问题使用 AskUserQuestion。暂停预算不暂停 worker。\n${HELP}`
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
    if (a.action === 'list') return JSON.stringify(await store?.list() ?? [], null, 2)
    if (a.action === 'recover') {
      if (!controller || !a.run) throw new Error('recover 必须明确提供 run ID')
      const r = await controller.get(a.run)
      if (!r) throw new Error('run 不存在')
      owned(r)
      selected = r.id
      if (TERMINAL.has(r.status)) return `已选择关闭 run 供 probe/stop 清理；不会恢复任务执行。\n${status(r)}`
      await event('recover', { sessionId })
      timerFault = ''
      const note = await reconcile($, r)
      return `${note}\n${status((await current())!)}`
    }
    let r = a.run && a.action === 'status' ? await controller?.get(a.run) : await current()
    if (a.action === 'status') return r ? status(r) : `没有选中的 run。${startupError || '用 list 查询持久化记录。'}`
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
          if (Object.values(r.tasks).some(t => t.label === w.label)) throw new Error(`label 已存在：${w.label}；不静默重复执行`)
          w.card = path(w.card, cwd)
          if (!w.card.startsWith(`${r.deliverDir}/cards/`) || /[\r\n]/.test(w.card)) throw new Error('card_path 必须是本 run cards/ 下的文件路径，不是正文')
          const text = await $.fs.read(w.card)
          if (!text.trim()) throw new Error(`任务卡为空：${w.label}`)
          if (!w.files.length) throw new Error(`${w.label} 必须声明 files，不能默认无限制写入`)
          w.files = w.files.map(f => path(f, cwd))
          for (const f of w.files) {
            if (!f.startsWith(`${cwd}/`) || f === `${cwd}/.budget/state.sqlite3` || (f.includes('/.budget/') && !f.startsWith(`${r.deliverDir}/`))) throw new Error(`非法文件归属：${f}`)
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
            await event('attempt-created', { attempt: { id: attemptId, taskId, ownerSessionId: sessionId, name, requestedModel: model, status: 'creating', managed: true, createdAt: now(), updatedAt: now() } })
            if (w.model.mode === 'route') routes.set(name, w.model.route)
            try {
              const spawned = await spawnAgent($, {
                name, description: w.description, cwd,
                subagentType: 'general-purpose', model: w.model.mode === 'alias' ? w.model.alias : undefined,
                prompt: `${buildWorkerPrompt({ label: w.label, cardPath: w.card, runId: r.id, modelLabel: model })}\n稳定任务标识 ${taskId}，执行标识 ${attemptId}。只读取本卡，只写声明文件。预算由主控管理；如收到暂停/延长通知，以最新通知为准。`,
              })
              if (!spawned.ok) {
                await event('attempt-unknown', { attemptId, reason: `spawn 未确认成功：${spawned.note}；不能确定是否已创建，不自动重试` })
                results.push(`${w.label}：创建结果待确认 ${spawned.note}`)
              } else {
                await event('attempt-started', { attemptId, agentId: spawned.agentId, resolvedModel: spawned.model })
                const normalizedModel = (s: string) => s.toLowerCase().replace(/\[[0-9]+[mk]\]/g, '')
                if (w.model.mode === 'route' && normalizedModel(spawned.model) !== normalizedModel(w.model.route)) {
                  const stopped = await stopAgent($, spawned.agentId)
                  if (stopped.ok) await event('attempt-finished', { agentId: spawned.agentId, outcome: 'failed', reason: `模型不匹配：请求 ${w.model.route}，宿主解析 ${spawned.model}，已停止` })
                  else await event('attempt-unknown', { attemptId, reason: `模型不匹配且停止未确认：${spawned.model}` })
                  results.push(`${w.label}：模型不匹配，${stopped.ok ? '已停止' : '需人工处理'}；不自动重派`)
                } else results.push(`${w.label}：attempt=${attemptId} agent=${spawned.agentId} model=${spawned.model}`)
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
            await event('attempt-unknown',{attemptId,reason:`重试创建结果未确认：${spawned.note}`})
            return '重试创建结果未知，不会再次自动重试。'
          }
          await event('attempt-started',{attemptId,agentId:spawned.agentId,resolvedModel:spawned.model})
          if (w.model.mode === 'route' && spawned.model.toLowerCase().replace(/\[[0-9]+[mk]\]/g,'') !== w.model.route.toLowerCase().replace(/\[[0-9]+[mk]\]/g,'')) {
            const stopped = await stopAgent($,spawned.agentId)
            if (stopped.ok) await event('attempt-finished',{agentId:spawned.agentId,outcome:'failed',reason:'重试模型不匹配，宿主确认停止'})
            else await event('attempt-unknown',{attemptId,reason:'重试模型不匹配且停止未确认'})
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
    selected = undefined; controller = undefined; store = undefined; startupError = ''
    routes.clear(); asks.clear(); toolChecks.clear(); toolEdits.clear()
    try {
      store = await createRunStore($, cwd, $.plugin.root)
      controller = new RunController(store)
      const prior = (await store.list()).filter(r => r.ownerSessionId === sessionId && !TERMINAL.has(r.status)).sort((a,b) => b.updatedAt - a.updatedAt)[0]
      if (prior) {
        selected = prior.id
        const r = (await current())!
        if (r.status === 'interrupted') {
          await $.ui.status(`发现中断 run=${r.id}。先 probe，再用 recover 明确恢复；不自动重新派发。`)
        } else {
          // A new process for the same owner session: do not count the offline gap and
          // do not invent completion. Execution that was in flight becomes unknown until probe.
          let fresh = await controller.dispatch(r.id, { type: 'checkpoint', now: r.updatedAt } as any)
          for (const a of Object.values(fresh.attempts)) {
            if (!a.managed || ['completed', 'failed'].includes(a.status) || a.status === 'unknown') continue
            fresh = await controller.dispatch(r.id, { type: 'attempt-unknown', attemptId: a.id, reason: '进程重新初始化；宿主状态待 probe 确认', now: fresh.updatedAt } as any)
          }
          await $.ui.status(`已接续 run=${r.id}（不重复执行）。先 probe 对账未确认的执行。`)
        }
      }
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
      if (cmd.action === 'start' && cmd.task) await $.prompt.submit({text:cmd.task})
      return {text,context:[text]}
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
    const r = await current()
    if (r && Object.values(r.attempts).some(a=>a.agentId === e.agent_id && !ATTEMPT_TERMINAL.has(a.status))) {
      // A stop hook alone is not success evidence. turn.complete supplies normal completion.
      await event('attempt-finished',{agentId:e.agent_id,outcome:'interrupted',reason:'宿主停止事件，尚无正常完成确认'})
    }
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
          if (typeof file !== 'string' || !allowed(file,r.tasks[a.taskId]?.allowedFiles ?? [],cwd)) return {deny:'写入目标不在当前任务明确声明的 files 内。'} as any
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
      if (Object.values(r.attempts).some(a=>a.agentId===e.agentId)) await event('attempt-finished',{agentId:e.agentId,outcome:'completed',actualModel:e.usage?.model,reason:'宿主 turn.complete 确认'})
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
  on('session.end', async ($, e: any, next) => {
    const r = await active()
    if (r) { const interrupted = await event('interrupt',{reason:`会话结束：${String(e.reason)}；不是用户取消任务`}); await writeManifest($,interrupted) }
    return next(e)
  })
}
