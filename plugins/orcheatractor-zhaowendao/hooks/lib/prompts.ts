// 注入给模型的所有中文文本。
import { cadenceText, fmt } from './schedule'
import type { Cadence } from './parse'
import { modelAgentInstructions } from './models'

export const TOOL = 'mcp__orcheatractor-zhaowendao__budget'

export const HELP = `编排与时间预算模式（默认关闭）
  /orcheatractor-zhaowendao 10m [任务]              开启，预算 10 分钟；时长后面的任务会直接交给模型
                                  （也可写 10分钟 / 半小时 / 1h30m / 纯数字按分钟；图片请在下一条消息发）
  /orcheatractor-zhaowendao 20m 每5% [任务]         改提示间隔：每5% / 4分位 / 每2分钟
  /orcheatractor-zhaowendao 20m 第15分钟 [任务]     额外加一个提示点（可写多个）
  /orcheatractor-zhaowendao 状态                    查看进度和 worker 账本
  /orcheatractor-zhaowendao 延时 5m                 延长预算
  /orcheatractor-zhaowendao 关闭                    结束本次预算
  /orcheatractor-zhaowendao 清理                    清理过期的历史 run
计时只算 agent 的工作时间：等你回答提问、会话空闲时自动停表。`

export function detectPrompt(phrase: string, budgetMs: number): string {
  return `[orcheatractor-zhaowendao] 用户这条消息里有时间要求「${phrase}」。在开始任何实际工作之前，先调用 AskUserQuestion 只问一个问题：是否开启「编排与时间预算模式」（预算 ${fmt(budgetMs)}，插件会定期推送剩余时间、管理阶段分配和到期延期申请；计时只算 agent 工作时间）。
选项：「开启（推荐）」/「不开启」/「本会话不再询问」。
- 选开启：用 ToolSearch 加载 ${TOOL}，然后调用 action=start, duration="${Math.round(budgetMs / 60_000)}m"（用户在提问里改了时长就用新的），再按工具返回的流程做。
- 选不开启：正常完成任务，不再提预算。
- 选本会话不再询问：调用 ${TOOL} action=decline，然后正常完成任务。`
}

export type ProtocolInput = {
  runId: string
  budgetMs: number
  cadence: Cadence
  extraMarks: string[]
  preCapMs: number
  deliverDir: string
  workers: { type: string; label: string }[]
  calibration: string
}

export function protocol(p: ProtocolInput): string {
  const workers = p.workers.length
    ? p.workers.map(w => `- ${w.type}  →  ${w.label}`).join('\n')
    : '- （没有读到 /model 名录，只能用内置的 general-purpose）'
  return `【编排与时间预算模式已开启】run=${p.runId} · 预算 ${fmt(p.budgetMs)} · 提示点 ${cadenceText(p.cadence)}${p.extraMarks.length ? ` + ${p.extraMarks.join('、')}` : ''}
计时只算 agent 工作时间（等用户回答 AskUserQuestion、会话空闲时停表）。插件会在提示点自动推送剩余时间和 worker 账本摘要：你不用自己查时间，也不要轮询 worker。
阶段切换都用 ${TOOL} 记录（没加载就先用 ToolSearch 加载）。所有向用户的提问只能用 AskUserQuestion，不要停下来用文字问。

0. 预探索（上限 ${fmt(p.preCapMs)}）：先调 action=phase phase=pre-explore。只看外形：目录结构、相关文件清单和行数、有没有 PRD/设计稿、构建和测试命令。禁止读实现细节、追调用链。
   结束时做预算计划：三阶段各多少时间、怎么并行、怎么验收。估算必须用下面的校准数据算，不要凭感觉。调 action=plan 记录（estimates 填各阶段秒数），然后只调一次 AskUserQuestion（最多 4 题，每题给选项，推荐项放第一）：
   ① 探索方向 / 可以排除的范围 ② worker 用什么模型（从下面的列表里给 2~3 个方案） ③ 验收方式：自动 / 手动回归包 / 混合 ④ 用户是否在场（不在场就不能出手动回归包）
   如果按计划算阶段 2 已经超预算，这次提问里就直接给出「延时 / 砍范围」的选项。
1. 探索：action=phase phase=explore。产出接口契约（类型、函数签名、文件归属）和任务卡，写到 ${p.deliverDir}/cards/。阶段结束时再估一次；超预算就立刻用 AskUserQuestion 申请延时或砍范围，不要等到 80% 才说。
2. 落地：action=phase phase=implement。按文件划分任务（不按功能，避免两个 worker 改同一个文件）。${modelAgentInstructions()}
   任务卡（就是 Skill 工具的参数）要写全：目标一句话；允许改动的文件；必读文件+行号范围；要遵守的约定（你摘录后贴进去，不让 worker 自己翻）；接口契约原文；禁止事项；自检命令；截止时间（绝对时刻 HH:MM:SS）；汇报节点；交付格式（≤10 行）。
   派发后立刻调 action=probe 确认 worker 已出现在 agent 列表里，再调 action=card worker=<agentId> files="a.ts,b.ts" 登记这张卡的「允许改动」——登记之后，worker 改卡外文件会被插件硬拦。
   Skill 返回后台子代理的 agent ID 后不要等待或轮询：看插件推送的账本。要纠偏或补需求用 action=say worker=<id> message="…"（等价于 SendMessage）；要看某个 worker 最近在干什么用 action=view worker=<id>；确定它跑偏了用 action=stop worker=<id>（硬停，失败会自动退化为发收尾消息）；全部收尾用 action=stop worker=all。worker 的问题会通过 SendMessage 发给你，合并后再统一问用户。你自己不要逐行读 worker 的改动，先跑静态检查，没过的地方再看。
3. 验收：action=phase phase=verify。底线：最后一次代码改动之后必须跑通编译 / 类型检查 / lint（插件会在你结束前检查，没跑会拦住你；项目确实没有任何静态检查时，调 action=gate 写明理由）。其余按改动类型选：
   视觉类（布局、样式、建模）→ 手动回归包；跨业务域、前后端联调 → 端到端手操步骤包 + 看日志；纯逻辑、数据转换 → 自动单测或用真实数据跑一遍；已有 e2e → 直接跑。不要过度测试。
   手动回归包写到 ${p.deliverDir}/regression.md：每一步的操作、预期结果、日志里 grep 什么关键字、出问题时截哪里发回来，目标是用户 2 分钟内能给出反馈。
4. 交付：action=close status=delivered summary="一句话"。
到期（100%）：插件已经通知所有运行中的 worker 收尾（做完手上这一小块就停、跑自检、交接）。你必须在 60 秒内调用 AskUserQuestion 发延期申请：2~3 个选项，推荐项放第一，每项写清做了能得到什么、不做有什么风险。例如 A. 延时 N 分钟完成 X　B. 现在交付 + 手动回归包　C. 砍掉 Y。用户选延时就调 action=extend minutes=N（插件会通知 worker 新的截止时间）；选交付就收尾，然后 action=close。
文件：本次的交付物写在 ${p.deliverDir}/。只读写本次 run 的文件；.budget/runs/ 下其它 run 是只读归档，除非用户明文指定（那时先调 action=ref 登记）。

可用的 model-agent skill（Skill 工具名 → 模型）：
${workers}

校准数据：
${p.calibration}`
}

export type WorkerLine = { id: string; label: string; status: string; last: string; ago: number; lines: number; files: number; deadline?: string }

export function ledgerText(workers: WorkerLine[]): string {
  if (!workers.length) return '（还没有派发 worker）'
  return workers
    .map(w => {
      const stuck = w.status === '运行中' && w.ago > 120_000 ? ' ⚠️ 超过 2 分钟没有动作' : ''
      return `- ${w.label} [${w.id}] ${w.status} · 最后：${w.last}（${fmt(w.ago)} 前）· 写入 ${w.lines} 行 / ${w.files} 个文件${w.deadline ? ` · 截止 ${w.deadline}` : ''}${stuck}`
    })
    .join('\n')
}

export function checkpointText(o: {
  label: string
  elapsedMs: number
  budgetMs: number
  phase: string
  ledger: string
  fraction: number
  planNote?: string
  idleWake: boolean
}): string {
  const head = `[orcheatractor-zhaowendao] ⏱ ${o.label}｜已用 ${fmt(o.elapsedMs)} / ${fmt(o.budgetMs)}｜剩 ${fmt(o.budgetMs - o.elapsedMs)}｜阶段：${o.phase}`
  const parts = [head]
  if (o.planNote) parts.push(o.planNote)
  if (o.ledger) parts.push(`worker 账本：\n${o.ledger}`)
  if (o.fraction >= 0.9) parts.push('只剩不到 10%：不要开新任务卡，准备好到期时的延期申请（每个选项的收益和风险）。')
  else if (o.fraction >= 0.8) parts.push('进入收敛：不再开启新的探索或新任务，优先保证已改的部分能编译、能交付。')
  if (o.idleWake) parts.push('这是一次巡查：账本没有异常就只回一句「继续等待」结束本轮；有异常（卡住、偏题、超时风险）再用 SendMessage 干预。')
  return parts.join('\n')
}

export function overdueText(o: { elapsedMs: number; budgetMs: number; ledger: string; again: boolean }): string {
  return `[orcheatractor-zhaowendao] ⏰ 预算${o.again ? '已超出' : '已到'}（已用 ${fmt(o.elapsedMs)} / ${fmt(o.budgetMs)}）。插件已通知所有运行中的 worker 收尾。
${o.again ? '你还没有发延期申请。' : ''}现在立即调用 AskUserQuestion 发延期申请（60 秒内）：2~3 个选项，推荐项放第一，每项写清做了得到什么、不做的风险（例如：延时 N 分钟完成 X / 现在交付 + 手动回归包 / 砍掉 Y）。
worker 账本：
${o.ledger}`
}

export const WRAP_UP_WORKER = '[orcheatractor-zhaowendao] 收尾：预算已到。把手上这一小块做完（当前文件改完、保持能编译），不要开始新的改动，跑一次任务卡里的自检，然后按格式交付。'

export function workerTick(o: { label: string; remainMs: number; deadline?: string }): string {
  return `[orcheatractor-zhaowendao] ⏱ 全局 ${o.label}，剩 ${fmt(o.remainMs)}${o.deadline ? `；你的截止时间 ${o.deadline}` : ''}。`
}

export function subagentStartText(o: { remainMs: number; budgetMs: number }): string {
  return `[orcheatractor-zhaowendao] 当前处于编排与时间预算模式：全局预算 ${fmt(o.budgetMs)}，剩 ${fmt(o.remainMs)}。按任务卡里的截止时间安排工作；收到 main 的消息就是任务变更；收到「收尾」通知就做完手上这一小块后交付。`
}

export function preCapText(capMs: number): string {
  return `[orcheatractor-zhaowendao] 预探索已经用满上限 ${fmt(capMs)}。立即停止探索，输出预算计划（action=plan），然后用一次 AskUserQuestion 确认。`
}

export function gateText(): string {
  return `[orcheatractor-zhaowendao] 质量底线：最后一次代码改动之后，还没有看到编译 / 类型检查 / lint 通过的记录。请先运行项目的静态检查（例如 tsc --noEmit、eslint、cargo check、go build、mypy 等）并修到通过，再结束。项目确实没有任何可用的静态检查时，调用 ${TOOL} action=gate reason="…" 说明理由。`
}
