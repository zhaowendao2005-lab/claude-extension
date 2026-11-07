import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'orcheatractor-zhaowendao',
  component: 'Pane',
  requestId: 'model-search',
  props: {
    title: '模型搜索',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const DEEPSEEK = 'ccs-claude-openrouter--deepseek/deepseek-v4.1-flash[1M]'
const OPUS = 'ccs-claude-claude--anthropic/claude-opus-5-5[1M]'
const SOL = 'ccs-claude-openai-2--openai/gpt-6.1-sol[1M]'

const SETTINGS = {
  model: OPUS,
  modelPicker: {
    options: [
      {
        model: DEEPSEEK,
        label: 'deepseek/deepseek-v4.1-flash（360-ds-glm-kimi）',
        description: '360-ds-glm-kimi · deepseek/deepseek-v4.1-flash · 1M',
      },
      {
        model: OPUS,
        label: 'anthropic/claude-opus-5-5（360-claude）',
        description: '360-claude · anthropic/claude-opus-5-5 · 1M',
      },
      {
        model: SOL,
        label: 'openai/gpt-6.1-sol（360-codex）',
        description: '360-codex · openai/gpt-6.1-sol · 1M',
      },
    ],
  },
}

test('没输入关键词时列出全部模型', async ($, on) => {
  on('settings.read', () => ({ value: SETTINGS }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const labels = (await ui.findAll({ type: 'Button' })).map(row => row.text)

  expect(labels).toHaveLength(3)
  expect(labels.some(text => text?.includes('deepseek'))).toBe(true)
  expect(labels.some(text => text?.includes('opus'))).toBe(true)
  expect(labels.some(text => text?.includes('gpt-6.1-sol'))).toBe(true)
})

test('输入关键词后只留匹配项，按行切换', async ($, on) => {
  const submitted: string[] = []
  const toasts: string[] = []
  on('settings.read', () => ({ value: SETTINGS }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('command.run', { command: 'model' }, (_, e) => {
    submitted.push(`${e.command} ${e.args}`)
    return { text: undefined }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.input({ key: 'query', text: 'deep', kind: 'change' })

  const rows = await ui.findAll({ type: 'Button' })
  expect(rows).toHaveLength(1)
  expect(rows[0]?.text).toContain('deepseek')

  await ui.press({ key: `m:${DEEPSEEK}` })

  expect(toasts).toEqual([])
  expect(submitted).toEqual([`model ${DEEPSEEK}`])
})

test('没有匹配时给出空态，不画任何行', async ($, on) => {
  on('settings.read', () => ({ value: SETTINGS }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'query', text: 'zzzzzz', kind: 'change' })

  const empty = await ui.find({ type: 'Text', text: /没有匹配/ })
  expect(empty?.text).toContain('zzzzzz')
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
})

test('执行命令时打开面板并请求焦点，Esc 直接关闭', async ($, on) => {
  on('settings.read', () => ({ value: SETTINGS }))
  const opened: { id?: string; focus?: boolean; closeOnEscape?: boolean; rows?: number }[] = []
  on('ui.open', (_, e) => {
    opened.push(e)
    return { value: { isPlaced: true } }
  })

  // 测试里的 $ 是引擎本体：这里的 command.run 收的是完整事件输入，
  // origin / presentation 由引擎填，插件侧签名是 CommandRunArgs。
  const runCommand = $.command.run as unknown as (input: {
    command: string
  }) => Promise<unknown>
  await runCommand({ command: 'model-search' })

  expect(opened).toHaveLength(1)
  expect(opened[0]?.id).toBe('model-search')
  expect(opened[0]?.focus).toBe(true)
  expect(opened[0]?.closeOnEscape).toBe(true)
  // rows 是让它 inline 开在输入框上方的开关；缺了它，宽终端会 dock 到右侧。
  expect(opened[0]?.rows).toBe(14)
})

test('settings 里没有模型表时提示去配置', async ($, on) => {
  on('settings.read', () => ({ value: { model: OPUS } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  const notice = await ui.find({ type: 'Text', text: /modelPicker\.options/ })
  expect(notice).toBeDefined()
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
})
