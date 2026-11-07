// 从 /model 名录（~/.claude/settings.json 的 modelPicker.options）解析 model-agent skill 名称。
// 派发必须走现有 model-agents 生成的 m-* skill 通道；本插件不注册第二套 agent 类型。

export type CatalogEntry = { route: string; label: string; description: string; effort?: string }

export function parseCatalog(settingsText: string): CatalogEntry[] {
  let d: any
  try {
    d = JSON.parse(settingsText)
  } catch {
    return []
  }
  const options: any[] = d?.modelPicker?.options ?? []
  const modelSettings: Record<string, any> = d?.modelSettings ?? {}
  const seen = new Set<string>()
  const out: CatalogEntry[] = []
  for (const o of options) {
    const route = typeof o?.model === 'string' ? o.model.trim() : ''
    if (!route || seen.has(route)) continue
    seen.add(route)
    const base = route.split('[')[0]
    const effort = (modelSettings[route] ?? modelSettings[base] ?? {}).effortLevel
    out.push({ route, label: o.label || base, description: o.description || '', effort: typeof effort === 'string' ? effort : undefined })
  }
  return out
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/\[1m\]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/** 和 model-agents 的命名一致：模型--供应商，前面加 m-，这是实际派发通道。
 *  必须与 model-agents/bin/sync.py 的 skill_name() 保持同一规则（两边各有实现）。 */
export function workerSkillName(route: string): string {
  let base: string
  if (route.startsWith('ccs-claude-') && route.includes('--')) {
    const [provider, model] = route.slice('ccs-claude-'.length).split(/--(.*)/s, 2)
    base = `${slug(model ?? '')}--${slug(provider ?? '')}`
  } else {
    base = slug(route)
  }
  return `m-${base}`.slice(0, 64).replace(/-+$/, '')
}

export function modelAgentInstructions(): string {
  return `派发必须走 model-agents 通道：用 Skill 工具调用下面列出的 m-* skill，并把完整任务卡作为 skill 参数传入；不要用 Agent 工具、不要用 subagent_type、不要调用本插件自己注册的 agent。每个 m-* skill 会在后台启动一个独立子代理，主 agent 继续工作；用 SendMessage 按返回的 agent ID 中途询问和干预。`
}
