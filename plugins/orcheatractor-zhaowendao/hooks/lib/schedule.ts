// 提示点的计算和时间格式化。纯函数。
import type { Cadence } from './parse'

export type Mark = {
  /** 稳定的标识，用来记录是否已推送 */
  key: string
  /** 距离开始的工作时间（毫秒） */
  atMs: number
  /** 给人看的标签，例如 30% 或 第 8 分钟 */
  label: string
  /** 占预算的比例 */
  fraction: number
}

/** 生成全部提示点（升序），最后一个一定是 100%。 */
export function buildMarks(budgetMs: number, cadence: Cadence, extraMarksMs: number[]): Mark[] {
  const marks: Mark[] = []
  if (cadence.kind === 'fraction') {
    const n = Math.round(1 / cadence.step)
    const exact = Math.abs(n * cadence.step - 1) < 1e-9
    const count = exact ? n - 1 : Math.floor(1 / cadence.step)
    for (let k = 1; k <= count; k++) {
      const f = k * cadence.step
      if (f >= 1 - 1e-9) break
      marks.push({ key: `f${Math.round(f * 1000)}`, atMs: Math.round(f * budgetMs), label: `${Math.round(f * 100)}%`, fraction: f })
    }
  } else {
    for (let t = cadence.ms; t < budgetMs; t += cadence.ms) {
      marks.push({ key: `t${t}`, atMs: t, label: `${fmt(t)}`, fraction: t / budgetMs })
    }
  }
  for (const ms of extraMarksMs) {
    if (ms > 0 && ms < budgetMs) {
      marks.push({ key: `x${ms}`, atMs: ms, label: `第 ${fmt(ms)}（额外提醒）`, fraction: ms / budgetMs })
    }
  }
  marks.push({ key: 'end', atMs: budgetMs, label: '100%', fraction: 1 })
  return marks.sort((a, b) => a.atMs - b.atMs)
}

/** 毫秒 → m:ss 或 h:mm:ss */
export function fmt(ms: number): string {
  const neg = ms < 0
  const s = Math.floor(Math.abs(ms) / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const body = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
  return neg ? `-${body}` : body
}

/** 墙钟时间 → HH:MM:SS（本地时区） */
export function clockText(epochMs: number): string {
  const d = new Date(epochMs)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

/** run_id：20261105-162600-任务简称 */
export function makeRunId(epochMs: number, task: string): string {
  const d = new Date(epochMs)
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  const slug = task
    .replace(/[\\/:*?"<>|\s`'.,，。：；;！!？?（）()\[\]【】{}]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 16)
  return slug ? `${stamp}-${slug}` : stamp
}

export function cadenceText(c: Cadence): string {
  return c.kind === 'fraction' ? `每 ${Math.round(c.step * 1000) / 10}%` : `每 ${fmt(c.ms)}`
}
