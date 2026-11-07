// 官方能力的唯一入口：所有对 Claude Code 运行时的调用都收敛在这里。
// 官方插件 API 是 early access，形状会变；变的时候只改这个文件，
// 其余代码只认本文件导出的语义化函数。

export type AgentInfoLite = {
  id: string
  type: string
  description: string
  status: string
  parentId?: string
}

export type Caps = {
  /** $.agent.list() 可用，且能看到启动中的子代理 */
  list: boolean
  /** TaskStop 认得 agentId */
  stop: boolean
}

/** 读一次子代理列表；失败返回 undefined（不代表空）。 */
export async function listAgents($: any): Promise<AgentInfoLite[] | undefined> {
  try {
    const rows = await $.agent.list()
    if (!Array.isArray(rows)) return undefined
    return rows.map((r: any) => ({
      id: String(r?.id ?? ''),
      type: String(r?.type ?? ''),
      description: String(r?.description ?? ''),
      status: String(r?.status ?? ''),
      parentId: r?.parentId ? String(r.parentId) : undefined,
    }))
  } catch {
    return undefined
  }
}

/** 一个子代理的对话行（官方 transcript 视图）。 */
export async function agentMessages($: any, agentId: string, limit = 12): Promise<{ role: string; text: string; tools: string[] }[]> {
  try {
    const rows = await $.session.messages({ agentId })
    if (!Array.isArray(rows)) return []
    return rows.slice(-limit).map((r: any) => ({
      role: String(r?.role ?? ''),
      text: String(r?.text ?? '').slice(0, 400),
      tools: Array.isArray(r?.toolUses) ? r.toolUses.map((t: any) => String(t?.name ?? '')) : [],
    }))
  } catch {
    return []
  }
}

/** 给子代理发消息（主 agent 的 btw）。返回是否投递成功。 */
export async function sendTo($: any, agentId: string, message: string): Promise<{ ok: boolean; note?: string }> {
  try {
    await $.tool.call({ tool: 'SendMessage', to: agentId, message })
    return { ok: true }
  } catch (e) {
    return { ok: false, note: String((e as any)?.message ?? e).slice(0, 160) }
  }
}

/** 硬停止一个子代理。不成则返回原因，由调用方退化为软停止。 */
export async function stopAgent($: any, agentId: string): Promise<{ ok: boolean; note?: string }> {
  try {
    const r: any = await $.tool.call({ tool: 'TaskStop', task_id: agentId })
    const failed = r?.isError === true || r?.deny !== undefined
    return failed ? { ok: false, note: String(r?.text ?? r?.deny ?? '').slice(0, 160) } : { ok: true }
  } catch (e) {
    return { ok: false, note: String((e as any)?.message ?? e).slice(0, 160) }
  }
}

/** 会话启动时做一次能力探测；探测失败按「不支持」处理，UI 不画对应按钮。 */
export async function probeCaps($: any): Promise<Caps> {
  const rows = await listAgents($)
  return { list: rows !== undefined, stop: true }
}
