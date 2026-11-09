import type { Register } from 'claude-code'

import { register as registerModelSearch } from './model-search'
import { register as registerBudget } from './register'

// hooks.json 每个插件只允许一个模块：这里是唯一入口，把两套 register 串起来。
// - register.ts   ：编排 / 时间预算（/orcheatractor-zhaowendao，budget 工具）
// - model-search.tsx：模糊搜索切换模型（/model-search）
export const register: Register = (on, options) => {
  registerBudget(on, options)
  registerModelSearch(on, options)
}
