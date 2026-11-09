// 原生 worker 派发的纯函数：解析主 agent 传来的 worker 列表、解析模型 route、
// 组装自包含 prompt。这里不碰 $，方便单测。

import type { CatalogEntry } from './models'

export type ModelDelivery = 'param' | 'hook' | 'registered'

export type ResolvedModel =
  | { ok: true; mode: 'route'; route: string; label: string }
  | { ok: true; mode: 'alias'; alias: string; label: string }
  | { ok: true; mode: 'inherit'; label: 'inherit' }
  | { ok: false; error: string }

export type DispatchWorker = {
  label: string
  /** 主 agent 写的模型：完整 route、catalog 子串、内置别名或 inherit */
  rawModel: string
  model: ResolvedModel
  /** 任务卡路径（绝对或项目根相对，由调用方规范化） */
  card: string
  description: string
  files: string[]
}

export type DispatchParse =
  | { ok: true; workers: DispatchWorker[] }
  | { ok: false; error: string }

export const DEFAULT_MAX_WORKERS = 20
export const BUILTIN_ALIASES = ['sonnet', 'opus', 'haiku', 'fable'] as const

/** 把完整 route、catalog 唯一子串、内置别名或 inherit 解析成可派发的模型。 */
export function resolveWorkerModel(raw: string, catalog: CatalogEntry[]): ResolvedModel {
  const want = raw.trim()
  if (!want) return { ok: false, error: 'model 为空' }
  if (want.toLowerCase() === 'inherit') return { ok: true, mode: 'inherit', label: 'inherit' }
  const alias = BUILTIN_ALIASES.find(a => a === want.toLowerCase())
  if (alias) return { ok: true, mode: 'alias', alias, label: alias }
  if (!catalog.length) return { ok: false, error: `没有读到 /model 名录，无法解析 ${want}` }

  const exact = catalog.find(c => c.route === want)
  if (exact) return { ok: true, mode: 'route', route: exact.route, label: exact.label }

  const lower = want.toLowerCase()
  const hits = catalog.filter(c =>
    c.route.toLowerCase().includes(lower) ||
    c.label.toLowerCase().includes(lower) ||
    c.description.toLowerCase().includes(lower),
  )
  if (hits.length === 1) {
    const hit = hits[0]!
    return { ok: true, mode: 'route', route: hit.route, label: hit.label }
  }
  if (hits.length > 1) {
    return { ok: false, error: `model 有 ${hits.length} 个匹配：${hits.map(h => h.label).join('、')}，请写完整 route` }
  }
  return { ok: false, error: `model 找不到匹配：${want}` }
}

/** 把 `files` 归一化成字符串数组；兼容数组和逗号/换行字符串。 */
export function normalizeFiles(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(x => String(x).trim()).filter(Boolean)
  if (typeof raw === 'string') {
    return raw.split(/[,，\n]/).map(x => x.trim()).filter(Boolean)
  }
  return []
}

/**
 * 解析 `workers`。既接受数组，也接受 JSON 字符串（方便手写调用）。
 * 超过 maxWorkers 就整批拒绝，不静默排队、不部分启动。
 */
export function parseDispatch(raw: unknown, catalog: CatalogEntry[], maxWorkers = DEFAULT_MAX_WORKERS): DispatchParse {
  let list: unknown = raw
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw)
    } catch {
      return { ok: false, error: 'workers 不是合法 JSON' }
    }
  }
  if (typeof list === 'object' && list !== null && !Array.isArray(list)) {
    list = [list]
  }
  if (!Array.isArray(list) || list.length === 0) return { ok: false, error: 'workers 必须是非空数组' }
  if (list.length > maxWorkers) {
    return {
      ok: false,
      error: `一次最多派发 ${maxWorkers} 个 worker（当前 ${list.length}）。需要更多请调高 CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS，或分批派发。`,
    }
  }

  const labels = new Set<string>()
  const workers: DispatchWorker[] = []
  for (let i = 0; i < list.length; i++) {
    const item = list[i]
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: `workers[${i}] 不是对象` }
    }
    const o = item as Record<string, unknown>
    const label = typeof o.label === 'string' ? o.label.trim() : ''
    if (!label) return { ok: false, error: `workers[${i}].label 为空` }
    if (labels.has(label)) return { ok: false, error: `label 重复：${label}` }
    labels.add(label)

    const rawModel = typeof o.model === 'string' ? o.model.trim() : ''
    if (!rawModel) return { ok: false, error: `${label}.model 为空` }
    const model = resolveWorkerModel(rawModel, catalog)
    if (!model.ok) return { ok: false, error: `${label}.model：${model.error}` }

    const rawCard = o.card_path ?? o.card
    const card = typeof rawCard === 'string' ? rawCard.trim() : ''
    if (!card) return { ok: false, error: `${label}.card_path 为空（传文件路径，不是正文）` }
    if (/[\r\n]/.test(card) || card.length > 4096) return { ok: false, error: `${label}.card_path 必须是单行文件路径` }

    const description = typeof o.description === 'string' && o.description.trim()
      ? o.description.trim().slice(0, 120)
      : label

    workers.push({ label, rawModel, model, card, description, files: normalizeFiles(o.files) })
  }
  return { ok: true, workers }
}

export type WorkerPromptInput = {
  label: string
  cardPath: string
  runId: string
  deadline?: string
  modelLabel?: string
  /** 隔离副本根目录；为空表示共享工作区 */
  workspace?: string
}

/** 自包含 prompt：子代理看不到主会话，必须让它先读任务卡。 */
export function buildWorkerPrompt(p: WorkerPromptInput): string {
  const lines = [
    `你是 ${p.label}，本次预算 run=${p.runId} 的原生子代理${p.modelLabel ? `（模型 ${p.modelLabel}）` : ''}。`,
    `先完整读取任务卡：${p.cardPath}`,
    '严格按卡执行；只改卡里「允许改动」的文件；不要使用 Skill 或 Agent 再派生子代理；不要运行 git 命令。',
    ...(p.workspace
      ? [`你的工作目录是隔离副本：${p.workspace}。Write/Edit 必须使用这个目录下的绝对路径，不要写主工作树的路径；完成后只回收声明文件。`]
      : []),
  ]
  if (p.deadline) {
    lines.push(`你的截止时间：${p.deadline}。做完手上这一小块就停，跑卡里的自检，然后按卡的格式汇报。`)
  }
  lines.push('汇报控制在 10 行以内：改了什么文件、关键决策、自检结果、遗留问题。')
  return lines.join('\n')
}

export type DispatchRow = { label: string; agentId?: string; model?: string; error?: string }

export function formatDispatchResult(rows: DispatchRow[]): string {
  return rows
    .map(r => r.error
      ? `- ${r.label}：失败（${r.error}）`
      : `- ${r.label}：agent=${r.agentId} · 模型=${r.model ?? '未知'}`)
    .join('\n')
}

/** 稳定、可读、不会撞保留名的 SendMessage 地址。 */
export function workerName(runId: string, label: string): string {
  const tail = runId.slice(-6).replace(/[^a-zA-Z0-9_-]/g, '')
  const clean = label.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || 'worker'
  return `orch-${tail}-${clean}`.slice(0, 64)
}

/** 模型 route 的短显示名，用于账本，控制 token。 */
export function shortModel(model: string): string {
  const noWindow = model.replace(/\[[0-9]+[mk]\]/gi, '')
  const parts = noWindow.split('/')
  return (parts[parts.length - 1] ?? noWindow).slice(0, 32)
}
