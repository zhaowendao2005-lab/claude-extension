# orcheatractor-zhaowendao 0.4 — 持久化编排内核

本版本重写编排控制面，保留原生 `general-purpose` worker 和 `/model-search`。**任务不再以临时 session 为唯一身份；超时不是关闭，宿主列表为空不是任务失败。**

## 使用

```text
/orcheatractor-zhaowendao 10m 实现某个任务
/orcheatractor-zhaowendao 状态
/orcheatractor-zhaowendao 延时 5m
/orcheatractor-zhaowendao 关闭
```

斜杠命令“关闭”是明确取消；成功交付通过 `budget action=close status=delivered`，必须满足统一门禁。插件不自动开启预算；`auto_detect` 只建议主 agent 询问。

需要 **Python 3（含标准库 sqlite3）**。启动时按 python3、python、py -3 探测；存储不可用时明确失败，不回退内存运行。原生派发需要宿主支持 `$.agent.spawn`；不再悄悄回退到另一种调度通道。模型名录读取 Claude 配置的 `modelPicker.options`，内置别名仍可使用。

## 核心保证与边界

- Run 是稳定任务；Task 是工作契约；Attempt 是一次具体执行。创建意图先落盘，再调用宿主 spawn，再绑定 agentId。
- `.budget/state.sqlite3` 是权威状态，采用 SQLite 事务与 revision CAS。每项目只允许一个未关闭 run；已取消但仍有未确认结束的 managed attempt 也阻止创建新 run。
- `RunController` 串行化同 run 事件；不同进程的旧版本写入被拒绝，不覆盖新状态。
- 多原因暂停：Ask 等待、idle、会话中断互不替代。worker 的工具调用不恢复主预算。
- **Ask 停表不停止 worker，也不停止模型费用。** Ask 结束或异常退出时解除该提问的暂停原因；主预算不是所有 worker 的累计计算成本。
- 状态每约 5 秒保存工作时间检查点；重启冻结到最后持久化点，离线时间不计入。崩溃可能少计最后一个检查点之后的工作。
- 提醒仅追加上下文和 UI 状态，不调用 `prompt.submit` 唤醒新执行会话。空闲时不会为读提醒另开模型回合。
- 超时通知 managed worker 收尾，并要求主 agent 询问延期/取消。run 仍可查询、验收、延期和关闭。
- observed 代理只记录，不纳入 `stop all`、文件契约或交付门禁。
- `files` 对原生 Write/Edit/NotebookEdit 做精确路径检查，**不是 Shell 沙箱，也不提供 symlink 隔离**。任意 Bash 可能改文件，因此非检查类 Bash 会保守使验收失效。真正安全隔离须依赖宿主 sandbox/worktree。

## 持久化与恢复

`session.end` 保存 interrupted，而不是 cancelled。重新初始化时停止自动计时，先查看记录：

```text
budget action=list
budget action=status run=<runId>
budget action=recover run=<runId>
budget action=probe
```

- 同一 owner session 可显式恢复；probe 将宿主可见状态与已保存 attempts 对账。
- **跨 session 接管目前明确拒绝**：宿主没有提供已验证的归属迁移契约，插件不绕过它。回到原 owner session 恢复/取消；不要删除数据库来绕过未知执行。
- 恢复失败或列表不可见会标记 unknown，不自动重派。原生执行可能仍在运行，不能通过“再开一次”掩盖不确定状态。
- 创建 agent 成功但保存 agentId 前崩溃时，持久化意图与唯一 name 用于对账。宿主不再暴露该 agent 时不能承诺精确一次执行，也不会自动重试。
- 如果重启留下一个已经不存在的用户提问暂停，可先 status，再显式 `resume reason=<完整暂停原因>`；仍在本进程等待用户的 Ask 不允许提前解除。
- cancelled run 仍可由原 owner 用 recover 选中后 probe/stop 清理残留执行，不会重新开始任务。取消和宿主实际停止是两回事。
- close 后导出 `runs/<runId>/manifest.json`。导出失败不丢失已提交的 SQLite 状态。
- 状态保留最近 500 条审计事件；这不是完整无限日志，worker transcript 仍由宿主管理。

## 派发示例

先在本次 run 的 `cards/` 下写任务卡，再调用：

```json
{
  "action": "dispatch",
  "workers": [
    {
      "label": "worker-a",
      "model": "sonnet",
      "card_path": "/project/.budget/runs/<runId>/cards/a.md",
      "files": ["src/a.ts"]
    }
  ]
}
```

`card_path` 是路径，旧 `card` 别名兼容；拒绝多行正文。整批预检卡片和文件冲突后才启动。`files` 必填，不能省略后默认全盘可写。任务 label 不重复；未结束任务的文件不能被另一个任务同时占用。默认并发上限 20，可用 `max_concurrent_workers` 与 `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` 取小配置。

任务卡应自包含：目标、允许文件、必读范围、契约、禁止事项、自检、汇报格式。主预算暂停/延长通知优先于卡片旧截止时间；不要让 worker 根据过期绝对时间继续作出调度决策。

## 工具 action

| action | 行为 |
|---|---|
| start / status / list | 建立预算、查看完整状态、列举持久化 run |
| recover / probe | 原 owner 显式恢复或选中关闭记录；与宿主对账 |
| resume | 解除明确指定且当前不在等待的暂停原因 |
| phase / plan | 阶段切换、保存估算（秒） |
| dispatch | 创建持久化任务与执行意图，然后派发 |
| retry worker=<attemptId或agentId> | 仅对已确认 failed 的执行显式重试，新增 attempt 并保留原记录；unknown/interrupted 拒绝重试 |
| extend | 增加主预算并通知未结束 managed worker |
| card | 修改任务文件契约，拒绝与其他运行任务冲突 |
| say / stop / view | 消息、停止、查看；all 只作用于 managed worker |
| gate | 对当前修改版本登记检查豁免，必须说明原因 |
| close | 成功交付，统一门禁；失败或未知任务不伪报成功 |
| cancel | 明确取消，不因检查未完成而阻止取消 |
| ref | 记录用户对历史 run 的引用，不转移执行权限 |

静态检查成功绑定到检查启动时的修改版本。检查期间又有修改，旧结果不能放行。后续修改也会使豁免失效。自动识别只接受直接的单条检查命令（例如 `npm run lint`、`tsc --noEmit`），不接受 `echo tsc`、管道或 `; true` 等组合。复杂命令请拆分或明确登记人工豁免。

## 架构

```text
hooks/register.ts        宿主适配、命令、通知、工具事件
        ↓
core/controller.ts       每 run 串行化、加载、CAS 提交
        ↓
core/state.ts            纯状态机、时钟、任务与执行、统一门禁
        ↓
storage/run-store.ts     宿主 process API 适配
storage/store.py         SQLite事务存储（Python标准库，无第三方包）
```

`hooks/lib/runtime.ts` 保持原生 agent 操作适配；宿主插件 state 只存模型搜索 UI 查询，不存第二份权威 run 状态。

## 测试

在插件目录执行：

```sh
claude plugin validate .
claude plugin test .
node --test tests/core.test.mjs
python3 tests/store.test.py
```

Node 测试需要支持原生 TypeScript stripping 的 Node 版本（开发环境 Node 24）。存储测试使用临时目录，不碰用户真实数据库。bridge 测试使用假宿主，不启动付费模型。

测试覆盖多原因暂停、提问异常退出、会话中断、跨 owner 拒绝、重复/迟到事件、CAS、跨进程竞争、失败事务、派发预检、正常完成后列表归零、未知创建结果、统一门禁与取消。

**真实宿主跨 session 转移仍需手动验收，不以假宿主测试宣称恢复链路已修复。**

## 0.3 → 0.4 迁移

- 旧 run 目录保留为只读历史，不自动导入/接管其 worker，也不修改当前安装插件的状态。
- 新版本不再使用旧插件 state 的 runs/workers；历史速度校准 `use_history` 和强制四问引导暂不接入新内核，避免旧启发式驱动新状态机。
- 提醒不再自动唤醒主 agent；需要继续工作时由用户正常提交消息。
- 本地修改不会自动安装、发布或提交。先运行上述测试，再在单独测试会话加载此插件目录验证。

## 模型搜索

`/model-search` 保持原有行为：读取模型配置、输入过滤、方向键选择、Enter切换、Esc退出。

**每条模型一个 m-* skill 的旧派发通道已移除**：`model-agents/` 生成器与 `hooks/lib/prompts.ts` 不再随插件发布，派发只走原生 `$.agent.spawn`。`~/.claude/skills/` 下由旧版本生成、带 `.model-agents` 标记的目录可安全删除；当前安装的 0.3.0 会在会话启动时重新生成，需先安装 0.4.0 再清理。
