// 解析 /orcheatractor-zhaowendao 参数、时长表达式、提示节奏，以及识别提示词里的时间要求。纯函数，便于测试。

export type Cadence =
  | { kind: 'fraction'; step: number } // 每 step（0~1）提示一次
  | { kind: 'interval'; ms: number } // 每 ms 毫秒提示一次

export type BudgetCommand =
  | { action: 'help' }
  | { action: 'status' }
  | { action: 'stop' }
  | { action: 'clean' }
  | { action: 'extend'; ms: number }
  | {
      action: 'start'
      budgetMs: number
      cadence?: Cadence
      extraMarksMs: number[]
      task: string
    }
  | { action: 'error'; message: string }

const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}

/** 「十五」「二十」「二十五」「三」→ 数字；不认识返回 NaN。 */
export function cnToNumber(s: string): number {
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s)
  if (s === '十') return 10
  const ten = s.indexOf('十')
  if (ten >= 0) {
    const hi = ten === 0 ? 1 : CN_DIGITS[s.slice(0, ten)]
    const loStr = s.slice(ten + 1)
    const lo = loStr === '' ? 0 : CN_DIGITS[loStr]
    if (hi === undefined || lo === undefined) return NaN
    return hi * 10 + lo
  }
  if (s.length === 1 && s in CN_DIGITS) return CN_DIGITS[s]!
  return NaN
}

const NUM = String.raw`(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十]+)`
const UNIT = String.raw`(小时|钟头|hours?|hrs?|h|分钟|分|minutes?|mins?|m|秒钟?|seconds?|secs?|s)`
// 一个时长片段：数字 +（个）+（半）+ 单位 +（半），或单独的「半小时 / 半个钟头」
const DURATION_RE = new RegExp(
  String.raw`(?:${NUM}\s*个?\s*(半)?\s*${UNIT}(半)?(?![a-z])|半\s*个?\s*(小时|钟头))`,
  'gi',
)

function unitMs(unit: string): number {
  const u = unit.toLowerCase()
  if (/^(小时|钟头|hours?|hrs?|h)$/.test(u)) return 3_600_000
  if (/^(分钟|分|minutes?|mins?|m)$/.test(u)) return 60_000
  return 1000
}

export type DurationHit = { ms: number; index: number; length: number; text: string }

/** 找出文本里所有时长片段。相邻片段（1小时30分钟、1h30m）合并成一个。 */
export function findDurations(text: string): DurationHit[] {
  const hits: DurationHit[] = []
  for (const m of text.matchAll(DURATION_RE)) {
    let ms: number
    if (m[5]) {
      ms = unitMs(m[5]) / 2
    } else {
      const n = cnToNumber(m[1] ?? '')
      if (!Number.isFinite(n)) continue
      const unit = unitMs(m[3]!)
      ms = n * unit + (m[2] || m[4] ? unit / 2 : 0)
    }
    const hit = { ms, index: m.index ?? 0, length: m[0].length, text: m[0] }
    const prev = hits[hits.length - 1]
    if (prev && hit.index - (prev.index + prev.length) <= 1 && hit.ms < prev.ms) {
      prev.ms += hit.ms
      prev.length = hit.index + hit.length - prev.index
      prev.text = text.slice(prev.index, prev.index + prev.length)
    } else {
      hits.push(hit)
    }
  }
  return hits
}

/** 「10m」「10分钟」「1h30m」「1.5小时」「半小时」「10」（纯数字按分钟）→ 毫秒。 */
export function parseDuration(s: string): number | undefined {
  const t = s.trim()
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t) * 60_000
  const hits = findDurations(t)
  return hits.length ? hits[0]!.ms : undefined
}

/** 从参数里取出节奏设置，返回设置和去掉这些片段后的剩余文本。 */
export function extractCadence(input: string): {
  cadence?: Cadence
  extraMarksMs: number[]
  rest: string
} {
  let rest = input
  let cadence: Cadence | undefined
  const extraMarksMs: number[] = []

  rest = rest.replace(/每\s*(\d+(?:\.\d+)?)\s*[%％]/, (_, n) => {
    const step = Number(n) / 100
    if (step > 0 && step < 1) cadence = { kind: 'fraction', step }
    return ' '
  })
  rest = rest.replace(/(\d+)\s*(?:分位|等分|段)/, (_, n) => {
    const k = Number(n)
    if (k >= 2) cadence = { kind: 'fraction', step: 1 / k }
    return ' '
  })
  rest = rest.replace(
    new RegExp(String.raw`每\s*(${NUM}\s*个?\s*${UNIT})`, 'i'),
    (_, d) => {
      const ms = parseDuration(d)
      if (ms && ms >= 10_000) cadence = { kind: 'interval', ms }
      return ' '
    },
  )
  rest = rest.replace(
    new RegExp(String.raw`(?:额外|另外|再)?\s*(?:在)?\s*第\s*(${NUM}\s*${UNIT})\s*(?:时)?\s*(?:提醒|提示)?`, 'gi'),
    (_, d) => {
      const ms = parseDuration(d)
      if (ms) extraMarksMs.push(ms)
      return ' '
    },
  )
  return { cadence, extraMarksMs, rest: rest.replace(/\s+/g, ' ').trim() }
}

/** 解析 `/orcheatractor-zhaowendao` 后面的参数。 */
export function parseBudgetArgs(args: string): BudgetCommand {
  const a = args.trim()
  if (a === '' || /^(帮助|help|\?|？)$/i.test(a)) return { action: 'help' }
  if (/^(状态|status|进度)$/i.test(a)) return { action: 'status' }
  if (/^(关闭|停止|结束|取消|off|stop|cancel)$/i.test(a)) return { action: 'stop' }
  if (/^(清理|clean)$/i.test(a)) return { action: 'clean' }
  const ext = a.match(/^(?:延时|延长|延期|extend|\+)\s*(.+)$/i)
  if (ext) {
    const ms = parseDuration(ext[1]!)
    return ms ? { action: 'extend', ms } : { action: 'error', message: `看不懂延时长度：${ext[1]}` }
  }

  const { cadence, extraMarksMs, rest } = extractCadence(a)
  // 预算时长：剩余文本开头的时长片段（允许纯数字，按分钟）
  const lead = rest.match(/^(\d+(?:\.\d+)?)(?=\s|$)/)
  let budgetMs: number | undefined
  let task = rest
  if (lead) {
    budgetMs = Number(lead[1]) * 60_000
    task = rest.slice(lead[0].length)
  } else {
    const hit = findDurations(rest)[0]
    if (hit && hit.index <= 2) {
      budgetMs = hit.ms
      task = rest.slice(0, hit.index) + rest.slice(hit.index + hit.length)
    }
  }
  if (!budgetMs) return { action: 'error', message: '没有找到预算时长，例如：/orcheatractor-zhaowendao 10m 或 /orcheatractor-zhaowendao 半小时 每5% 修复登录 bug' }
  if (budgetMs < 60_000) return { action: 'error', message: '预算至少 1 分钟' }
  return { action: 'start', budgetMs, cadence, extraMarksMs, task: task.replace(/^[\s,，:：]+/, '').trim() }
}

const PRE_KEYWORDS = /(给你|限时|预算|只有|最多|控制在|要求|需要在|请在|务必在|within|in|under)\s*$/i
const POST_KEYWORDS = /^\s*(内|之内|以内|完成|搞定|做完|做好|弄完|写完|交付|跑完|结束)/

/** 识别提示词里的时间要求（如「10分钟内完成」「给你半小时」）。返回命中的片段和时长。 */
export function detectTimeRequirement(text: string): { phrase: string; ms: number } | undefined {
  // 忽略代码块和行内代码里的内容
  const clean = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ')
  for (const hit of findDurations(clean)) {
    if (hit.ms < 60_000 || hit.ms > 24 * 3_600_000) continue
    const before = clean.slice(Math.max(0, hit.index - 8), hit.index)
    const after = clean.slice(hit.index + hit.length, hit.index + hit.length + 6)
    if (PRE_KEYWORDS.test(before) || POST_KEYWORDS.test(after)) {
      const start = PRE_KEYWORDS.test(before) ? hit.index - (before.match(PRE_KEYWORDS)?.[0].length ?? 0) : hit.index
      const postLen = after.match(POST_KEYWORDS)?.[0].length ?? 0
      return { phrase: clean.slice(start, hit.index + hit.length + postLen).trim(), ms: hit.ms }
    }
  }
  return undefined
}
