# orcheatractor-zhaowendao（编排与时间预算模式）

给主 agent 和它派发的子 agent 一个时间预算：插件按提示点推送剩余时间、维护 worker 账本、管理三阶段的时间分配、到期时推动主 agent 向你申请延时，并在结束前守住编译和静态检查的底线。

默认关闭。只有你主动执行 `/orcheatractor-zhaowendao 10m`，或者你的提示词里出现「10 分钟内完成」之类的时间要求（此时主 agent 会先问你）才会开启，不影响日常使用。

## 用法

```
/orcheatractor-zhaowendao 10m 修复登录 bug         开启，10 分钟预算；后面的任务会直接交给模型
                                 （图片、附件请在下一条消息里发，斜杠命令里的不会展开）
/orcheatractor-zhaowendao 20m 每5% ...             每跨过 5% 提示一次（也可写 4分位、每2分钟）
/orcheatractor-zhaowendao 20m 第15分钟 ...         额外加一个提示点
/orcheatractor-zhaowendao 状态                     查看进度和 worker 账本
/orcheatractor-zhaowendao 延时 5m                  延长预算并通知 worker
/orcheatractor-zhaowendao 关闭                     结束本次预算
```

计时只算 agent 的工作时间：等你在提问框里作答、会话空闲时自动停表。

## 它会做什么

- 阶段 0 预探索：只用预算的 5%（30 秒到 2 分钟）摸清代码外形，产出一份带估算的预算计划。
- 阶段 1 探索、阶段 2 落地、阶段 3 验收：按计划分配时间；落地阶段用便宜模型并行跑 worker，主 agent 通过账本和消息中途干预。
- 到期：通知所有 worker 收尾，并要求主 agent 在 60 秒内用提问工具给你延期选项（延时 / 交付 + 手动回归包 / 砍范围）。
- 质量底线：最后一次代码改动之后没有跑通编译或静态检查，就不允许结束。

## 交付物与归档

每次运行在项目的 `.budget/runs/<run_id>/` 下写预算计划、任务卡、手动回归包和 `manifest.json`（含起止时间和有效期）。目录自带 `.gitignore` 和 `.ignore`。除非你明文引用，插件不会读取其它 run 的归档。

## 依赖

读取 `~/.claude/settings.json` 里的 `/model` 名录来注册 worker 类型；名录为空时退回内置的 general-purpose。

## 安装

```
/plugin marketplace add zhaowendao2005/claude-extension
/plugin install orcheatractor-zhaowendao@zhaowendao-claude-extension
```

## 模型搜索（/model-search）

本插件同时提供输入即过滤的模型切换面板：

```
/model-search        打开「模型搜索」面板
```

打开即聚焦输入行；输入关键词实时过滤（标签 > 模型 id），Enter 切换第一个匹配，或按 ↓ 进入列表用方向键选择；Esc 关闭。模型列表来自 `~/.claude/settings.json` 的 `modelPicker.options`（也支持 `CLAUDE_CONFIG_DIR`）。


## 工具 action（主 agent 用）

| action | 作用 |
|---|---|
| `start` / `extend` / `close` / `gate` | 开关预算、延时、结束、静态检查豁免 |
| `phase` / `plan` | 记录阶段和预算计划 |
| `card worker=<id> files="a,b"` | 登记 worker 允许改动的文件；登记后越界改文件会被硬拦 |
| `say worker=<id|all> message="…"` | 给 worker 发消息（btw / 纠偏） |
| `view worker=<id> limit=10` | 读 worker 最近的对话行 |
| `stop worker=<id|all>` | 硬停止，失败自动退化为发收尾消息 |
| `probe` | 探测 agent 列表能力，顺带列出当前子代理 |
