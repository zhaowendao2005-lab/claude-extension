// 校准：把每次运行的实际用时汇总成几个数字，下次做预算计划时交给主 agent。
// 只存数字，不存任何文档内容。

import { fmt } from './schedule'

export type PhaseName = 'pre-explore' | 'explore' | 'implement' | 'verify'

export type CalibRecord = {
  project: string
  at: number
  budgetMs: number
  elapsedMs: number
  status: string
  /** 各阶段实际用时和计划用时（毫秒） */
  phases: { name: PhaseName; ms: number; estimateMs?: number }[]
  /** 每个 worker：模型路由、写入行数、活跃时长 */
  workers: { model: string; lines: number; activeMs: number }[]
}

/** 命令耗时统计：key 是命令的前两个词 */
export type CmdStats = Record<string, { n: number; avgMs: number; at: number }>

export function commandKey(command: string): string | undefined {
  const first = command.trim().split(/\s*(?:&&|\|\||;|\|)\s*/)[0] ?? ''
  const words = first
    .split(/\s+/)
    .filter(w => w && !/^[A-Z_][A-Z0-9_]*=/.test(w) && w !== 'cd')
  if (!words.length) return undefined
  return words.slice(0, 2).join(' ').slice(0, 40)
}

export function recordCommand(stats: CmdStats, key: string, ms: number, now: number): CmdStats {
  const old = stats[key]
  const next: CmdStats = { ...stats }
  next[key] = old ? { n: old.n + 1, avgMs: old.avgMs + (ms - old.avgMs) / Math.min(old.n + 1, 10), at: now } : { n: 1, avgMs: ms, at: now }
  // 只留最近使用的 40 条
  const keys = Object.keys(next).sort((a, b) => next[b].at - next[a].at)
  for (const k of keys.slice(40)) delete next[k]
  return next
}

const PHASE_CN: Record<PhaseName, string> = {
  'pre-explore': '预探索',
  explore: '探索',
  implement: '落地',
  verify: '验收',
}

/** 越近的记录权重越高：半衰期 7 天 */
function weight(at: number, now: number): number {
  return Math.pow(0.5, (now - at) / (7 * 86_400_000))
}

export function summarize(records: CalibRecord[], cmds: CmdStats, project: string, models: string[], now: number): string {
  const lines: string[] = []
  const mine = records.filter(r => r.project === project)

  // 各阶段的偏差系数（实际 ÷ 计划）
  const bias: string[] = []
  for (const name of ['explore', 'implement', 'verify'] as PhaseName[]) {
    let w = 0
    let sum = 0
    for (const r of mine) {
      for (const p of r.phases) {
        if (p.name === name && p.estimateMs && p.estimateMs > 0) {
          const k = weight(r.at, now)
          w += k
          sum += k * (p.ms / p.estimateMs)
        }
      }
    }
    if (w > 0) bias.push(`${PHASE_CN[name]} ×${(sum / w).toFixed(2)}`)
  }

  // 各模型的写代码速度（行/分钟/worker），跨项目统计
  const speed: string[] = []
  for (const model of models) {
    let lines_ = 0
    let ms = 0
    for (const r of records) {
      const k = weight(r.at, now)
      for (const wk of r.workers) {
        if (wk.model === model && wk.activeMs > 30_000) {
          lines_ += k * wk.lines
          ms += k * wk.activeMs
        }
      }
    }
    if (ms > 0) speed.push(`${model}：约 ${Math.round(lines_ / (ms / 60_000))} 行/分钟/worker`)
  }

  // 并行效率：同一次运行里 worker 数 ≥2 时，总产出 ÷ 落地阶段时长 ÷ 单 worker 平均速度
  const par: string[] = []
  for (const r of mine.slice(-10)) {
    const impl = r.phases.find(p => p.name === 'implement')
    const ws = r.workers.filter(w => w.activeMs > 30_000)
    if (!impl || ws.length < 2 || impl.ms <= 0) continue
    const total = ws.reduce((s, w) => s + w.lines, 0)
    const single = ws.reduce((s, w) => s + w.lines / (w.activeMs / 60_000), 0) / ws.length
    if (single > 0) par.push(`${ws.length} 个并行 → ${(total / (impl.ms / 60_000) / single).toFixed(1)} 倍`)
  }

  const slow = Object.entries(cmds)
    .filter(([, v]) => v.avgMs >= 3000)
    .sort((a, b) => b[1].avgMs - a[1].avgMs)
    .slice(0, 8)
    .map(([k, v]) => `${k} ${fmt(v.avgMs)}`)

  if (!mine.length && !speed.length && !slow.length) return '（暂无校准数据：按保守估计做计划，留 30% 余量，并在计划里标注「未校准」）'
  lines.push(`本项目历史运行 ${mine.length} 次（近 7 天权重更高）`)
  if (bias.length) lines.push(`阶段偏差（实际 ÷ 计划，估算时乘上它）：${bias.join(' · ')}`)
  if (speed.length) lines.push(...speed)
  if (par.length) lines.push(`并行效率：${par.slice(-3).join('；')}`)
  if (slow.length) lines.push(`本项目命令耗时：${slow.join(' · ')}`)
  if (!bias.length) lines.push('阶段偏差：暂无，留 30% 余量')
  return lines.join('\n')
}
