import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

const PANE = 'model-search'

type ModelOption = { model: string; label: string; description: string }

/** 输入栏里的过滤词。空串表示不过滤，列出全部。 */
const query = atom({ plugin: 'orcheatractor-zhaowendao', key: 'query' } as const, '')

/**
 * 打分规则：
 *   1. 连续子串命中，词首再加分（`deep` → `deepseek/...`）
 *   2. 否则退化为子序列，但只接受很紧凑的匹配（允许 2 个字符的空隙）
 * 不做更松的模糊，否则长模型名里东拼西凑的子序列会全部命中。
 * 不命中返回 -1。
 */
function matchScore(needle: string, haystack: string, weight: number): number {
  if (needle === '') return 0
  const h = haystack.toLowerCase()
  const n = needle.toLowerCase()

  const at = h.indexOf(n)
  if (at >= 0) {
    const atWordStart = at === 0 || /[\s/_\-·（(]/.test(h.charAt(at - 1))
    return weight * (10 + (atWordStart ? 5 : 0)) - at * 0.01
  }

  let from = 0
  let first = -1
  let last = -1
  for (let i = 0; i < n.length; i += 1) {
    const found = h.indexOf(n.charAt(i), from)
    if (found === -1) return -1
    if (first === -1) first = found
    last = found
    from = found + 1
  }
  const slack = last - first + 1 - n.length
  if (slack > 2) return -1
  return weight * (3 - slack)
}

/** 标签优先于模型 id；描述不参与匹配。 */
function rank(needle: string, options: ModelOption[]): ModelOption[] {
  const q = needle.trim()
  if (q === '') return options
  const scored: { option: ModelOption; score: number }[] = []
  for (const option of options) {
    const byLabel = matchScore(q, option.label, 1.3)
    const byId = matchScore(q, option.model, 1)
    const best = Math.max(byLabel, byId)
    if (best >= 0) scored.push({ option, score: best })
  }
  scored.sort((x, y) => y.score - x.score)
  return scored.map(entry => entry.option)
}

/** 由唯一的 session.start 调用：注册 /model-search 命令。 */
export async function registerModelSearchCommand($: any): Promise<void> {
  await $.command.register({
    name: 'model-search',
    description: '模糊搜索并切换模型',
    argumentHint: '[关键词]',
  })
}

export const register: Register = on => {
  // 模型表缓存在模块变量里：热重载会重置，正好跟着 settings 重新读。
  let cache: ModelOption[] | undefined

  on('command.run', { command: 'model-search' }, async $ => {
    await update($, query, () => '')
    // focus: 打开即把键盘交给面板，配合 Input 的 autoFocus 直接落在输入行。
    // closeOnEscape: 面板持有键盘时 Esc 直接关闭，和底部提示一致。
    // rows: 带它就以 inline 形式开在输入框上方；不带的话，全屏/宽终端会 dock 到右侧。
    await $.ui.open({
      id: PANE,
      title: '模型搜索',
      focus: true,
      closeOnEscape: true,
      rows: 14,
    })
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Input, Button } = $.ui.resolve(e)

    if (cache === undefined) {
      const picker = (await $.settings.read({ key: 'modelPicker' })) as
        | { options?: readonly Partial<ModelOption>[] }
        | undefined
      const list = Array.isArray(picker?.options) ? picker.options : []
      const seen = new Set<string>()
      const loaded: ModelOption[] = []
      for (const row of list) {
        if (typeof row?.model !== 'string' || row.model === '') continue
        if (seen.has(row.model)) continue
        seen.add(row.model)
        loaded.push({
          model: row.model,
          label: typeof row.label === 'string' ? row.label : row.model,
          description: typeof row.description === 'string' ? row.description : '',
        })
      }
      cache = loaded
    }

    const models = cache
    const typed = await read($, query)
    const current = (await $.settings.read({ key: 'model' })) as string | undefined
    // 面板分到的行数：输入行、底部提示各占一行，剩下的给列表。
    const bodyRows = e.props.scroll?.bodyRows ?? ((e.viewport?.rows ?? 24) - 2)
    const room = Math.max(3, bodyRows - 3)
    const matched = rank(typed, models)
    const visible = matched.slice(0, room)

    const pick = async (model: string): Promise<void> => {
      // 面板可能已经被 Esc 关掉；关不上不影响切换。
      try {
        await $.ui.close({ id: PANE })
      } catch {
        // 没有可关的面板
      }
      try {
        await $.command.run({ command: 'model', args: model })
      } catch (error) {
        $.ui.toast(`切换失败：${String(error)}`)
      }
    }

    return (
      <Box flexDirection="column">
        <Input
          key="query"
          autoFocus
          placeholder="输入关键词过滤模型…"
          value={typed}
          submitLabel="切换"
          onInput={value => {
            void update($, query, () => value)
          }}
          onSubmit={() => {
            const top = visible[0]
            if (top !== undefined) void pick(top.model)
          }}
        />
        {models.length === 0 && (
          <Text dimColor>settings.json 里没有 modelPicker.options，先在设置里配置模型表。</Text>
        )}
        {models.length > 0 && visible.length === 0 && (
          <Text dimColor>没有匹配 “{typed}” 的模型</Text>
        )}
        {visible.map(option => (
          <Button key={`m:${option.model}`} plain onPress={() => void pick(option.model)}>
            {option.label}
            {option.model === current ? <Text dimColor>（当前）</Text> : null}
          </Button>
        ))}
        {matched.length > visible.length && (
          <Text dimColor>还有 {matched.length - visible.length} 个匹配，继续输入缩小范围</Text>
        )}
        <Text dimColor>↑↓ 选择 · Enter 切换 · Esc 关闭</Text>
      </Box>
    )
  })
}
