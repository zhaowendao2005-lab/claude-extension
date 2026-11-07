// orcheatractor-zhaowendao 的插件状态契约（$.state 的键）。

export type BudgetCadence = { kind: 'fraction'; step: number } | { kind: 'interval'; ms: number }

export type BudgetMark = { key: string; atMs: number; label: string; fraction: number }

export type BudgetWorkerEntry = {
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
}

export type BudgetPhaseLog = { name: string; atMs: number; wall: number }

export type BudgetRunState = {
  runId: string
  task: string
  startedAt: number
  workMs: number
  segmentStart: number
  budgetMs: number
  cadence: BudgetCadence
  extraMarksMs: number[]
  firedMarks: string[]
  marks: BudgetMark[]
  phase: string
  phases: BudgetPhaseLog[]
  preCapMs: number
  project: string
  deliverDir: string
  workers: BudgetWorkerEntry[]
  pendingSince: number | null
  staticCheck: { pass: boolean; sawEditAfter: boolean }
  gateWaived: string | null
  overdueAt: number | null
  plan: { estimates: Record<string, number>; atMs: number } | null
  externalRefs: { run: string; phrase: string; at: string }[]
}

export type BudgetCalibRecord = {
  project: string
  at: number
  budgetMs: number
  elapsedMs: number
  status: string
  phases: { name: string; ms: number; estimateMs?: number }[]
  workers: { model: string; lines: number; activeMs: number }[]
}

export type BudgetCmdStats = Record<string, { n: number; avgMs: number; at: number }>

declare module 'claude-code' {
  interface PluginState {
    'orcheatractor-zhaowendao': {
      runs: Shaped<Record<string, BudgetRunState>>
      workers: Shaped<Record<string, Record<string, BudgetWorkerEntry>>>
      phases: Shaped<Record<string, unknown>>
      calib: Shaped<{ records?: BudgetCalibRecord[]; [k: string]: unknown }>
      cmds: Shaped<BudgetCmdStats>
      query: string
    }
  }
}
