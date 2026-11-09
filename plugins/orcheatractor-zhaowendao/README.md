# orcheatractor-zhaowendao

给主 agent 和它派发的 worker 一个时间预算与可继续的任务记录。

## 斜杠命令

| 命令 | 说明 |
|---|---|
| `/orcheatractor-zhaowendao <时长> <任务>` | 创建任务目录并开始计时，例如 `20m 重构登录模块` |
| `/orcheatractor-zhaowendao 状态` | 查看当前任务 |
| `/orcheatractor-zhaowendao 延时 10m` | 延长预算 |
| `/orcheatractor-zhaowendao 关闭` | 取消任务 |
| `/orcheatractor-zhaowendao-help` | 显示完整中文用法（不创建任务、不产生模型回合） |

## 任务目录（按路径寻址）

```text
<工作区根>/20261109-160408-修登录/
  state.sqlite3          # 状态机（SQLite 事务 + revision CAS）
  manifest.json          # 关闭/打断时导出
  cards/                 # 任务卡（也可以放任意路径）
  salvage/<attemptId>/   # 打断时抢救的半成品
```

- 工作区根 = 会话启动目录（不要求是 git 仓库）。
- 目录名 `时间戳-标题`，自动写入本地 `.git/info/exclude`，不入库。
- 所有操作都可以用**路径或目录名**定位：`budget action=status run=<路径>`。

## 生命周期

```text
start ──► active ──► completed
             │
             ├─ 用户打断/会话结束 ──► worker 收敛为 ended ──► interrupted
             │                                    │
             └──────────── recover <路径> ◄───────┘  (cycle+1，阶段重置)
```

- **worker 只在创建它的会话里有效**：手动打断、`session.end`、进程退出后，插件把所有未完成执行收敛为 `ended`（终态、不是成功），并把声明文件抢救到 `salvage/`。
- **继续**：`budget action=recover run=<任务目录>`。允许新会话接管（旧执行已终态，不操作旧 worker），阶段回到 `pre-explore`，`cycle+1`；已完成的 task 不重做，未完成的重新派发。
- 不存在 `unknown` 这种跨会话不确定态；状态只有 `creating/running/completed/failed/ended`。
- `start` 会先创建任务目录并停表，等待真正的模型回合。
- 如果命令是在一个正在结束的模型回合里调用，插件在 `turn.complete` 中自动提交任务。
- 如果用户在空闲状态直接输入 slash command，宿主不会为 `command.run` 自动创建模型回合；此时命令会保留任务，**下一条用户消息会自动承接该任务**。这是宿主事件语义，不是插件吞掉了任务。

每个 attempt 在临时 git worktree 中执行（`worktree add --detach`），结束后只把该任务**声明的 files** 复制回主工作树，然后删除 worktree。

- 非 git 工作区降级为共享目录，manifest 会标注隔离方式。
- 两个并行 attempt 不允许声明同一文件；因此不需要人工确认冲突。
- `files` 是写入白名单（精确路径），不是 shell 沙箱；非检查类 Bash 会使验收失效。

## Ask 与计时

- `AskUserQuestion` 等待期间主预算停表；worker 的活动不会解除这个暂停。
- 停表不等于停 worker，也不等于停止模型费用。
- 每约 5 秒写检查点；进程被杀时不会把离线时间计入预算。

## 交付门禁

- 所有 task 必须有 `completed` attempt；静态检查或豁免绑定到"最后一次修改版本"。
- 直接 `close status=delivered` 与自动交付走同一套检查。
- `cancel` 不受门禁限制，但不会把 worker 标成成功。

## 工具 action

| action | 说明 |
|---|---|
| start | 在当前工作区根创建任务目录并开预算 |
| status / list | 查看状态 / 列出工作区里的任务目录（都可带路径） |
| recover | 按路径继续任务（cycle+1，阶段重置） |
| dispatch | 整批预检后派发；`card_path` 是文件路径，`files` 必填 |
| probe | 与宿主 agent 列表对账（列表为空不等于失败） |
| phase / plan / extend / gate | 阶段、估算、延期、检查豁免 |
| close / cancel | 交付（过门禁）/ 取消（不过门禁） |
| card / say / stop / view / retry | 文件契约、消息、停止、查看、显式重试 failed |
| ref | 记录历史引用，不转移执行权限 |

## 依赖

- Python 3 + 标准库 `sqlite3`（每个任务目录一个状态库）。
- 原生派发需要宿主支持 `$.agent.spawn`；不支持时明确报错，不回退其它通道。

## 测试

```sh
claude plugin validate .
claude plugin test .          # 宿主桥接 + 解析
node --test tests/core.test.mjs
python3 tests/store.test.py
```
