// 从 /model 名录（~/.claude/settings.json 的 modelPicker.options）解析可选模型。
// 派发统一走原生 $.agent.spawn；这里只负责读取名录，不生成任何 skill。

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
