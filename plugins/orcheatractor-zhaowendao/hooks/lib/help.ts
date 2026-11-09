// /orcheatractor-zhaowendao-help 打印的中文用法。纯文本，不依赖任何 run。

export const USAGE = `orcheatractor-zhaowendao — 时间预算 · worker 编排 · 可中断继续

一、最常用
  /orcheatractor-zhaowendao 20m 重构登录模块
      开始任务：在当前工作区根目录创建「时间戳-标题」任务目录，
      预算 20 分钟，并把任务交给模型。
  /orcheatractor-zhaowendao 状态
      查看当前任务：状态、阶段、预算用量、worker 明细。
  /orcheatractor-zhaowendao 延时 10m
      预算不够时延长。
  /orcheatractor-zhaowendao 关闭
      取消任务（不会把未完成的工作伪装成成功）。
  /orcheatractor-zhaowendao-help
      显示这份说明。

二、开始命令的写法
  /orcheatractor-zhaowendao <时长> <任务>
  时长：10m / 90s / 半小时 / 1h30m / 10（纯数字按分钟），最少 1 分钟。
  节奏（可选）：
      每 5%        每过预算的 5% 提醒一次
      每 5 分钟    每隔 5 分钟提醒一次
      第 10 分钟   到点额外提醒
  例：
      /orcheatractor-zhaowendao 1h 每10% 升级依赖并跑通测试
      /orcheatractor-zhaowendao 30m 每5分钟 修复 CI
  任务写得越具体越好，可以带文件路径和验收标准。

三、命令执行了却没有开始？
  宿主对斜杠命令的规则：
  · 模型回合进行中执行 → 本回合结束时自动开始。
  · 空闲状态执行 → 宿主不会新建回合；紧接着发一条普通消息（例如「开始」），
    插件会把任务和这条消息一起交给模型。
  已在进行的任务不会被重复启动。

四、worker（子代理）
  由模型调用 budget 工具的 dispatch 派发；你只要在任务里说清楚，例如：
      「落地阶段用 4 个 worker 并行，模型用 ds41 360」
  规则：
  · 每个 worker 一个任务卡文件，card_path 传文件路径，不是任务正文；
  · 每个 worker 必须声明自己要写的 files，同一批派发里不允许文件重叠；
  · worker 跑在临时 git worktree 里，结束只把声明的文件回收回主工作树；
  · 正常结束会自动删除 worktree；被打断则半成品存进 salvage/<attemptId>/。

五、查看与继续
  当前任务：/orcheatractor-zhaowendao 状态
  列出任务：对模型说「列出编排任务」（budget action=list）。
  继续被打断的任务：把任务目录路径告诉模型，例如：
      「继续 /Users/you/project/20261109-160408-修登录」
  模型调用 budget action=recover 后：
      · 阶段重置为 pre-explore，cycle 加 1；
      · 已完成的 task 不重做；
      · 未完成的 task 重新派发新的 worker；
      · 旧会话的 worker 不会被接管，也不会被重复操作。

六、计时规则
  · 模型向你提问（AskUserQuestion）期间主预算停表，回答后继续；
  · 停表不等于停 worker，也不等于停止模型费用；
  · 进程被杀不会把离线时间计入预算（每约 5 秒写检查点）。

七、交付门禁
  · 所有 task 必须有成功的 worker，且静态检查（tsc/eslint/test 等）
    绑定到「最后一次修改」的版本；
  · 改过文件却没跑检查就直接交付，会被拦住；
  · 确实没有可跑的检查时，让模型显式登记豁免（budget action=gate）；
  · 交付：对模型说「进入验收并交付」，或调用
    budget action=close status=delivered；
  · 取消：/orcheatractor-zhaowendao 关闭 或 budget action=cancel，
    取消不受门禁限制，但不会把 worker 标成成功。

八、预算耗尽
  预算用完不会自动关闭任务：模型会用 AskUserQuestion 询问延期或取消，
  不会静默重派或偷偷加班。

九、数据在哪
  <工作区根>/YYYYMMDD-HHMMSS-标题/
      state.sqlite3      状态库（SQLite，事务 + revision 校验）
      cards/             任务卡
      salvage/           被打断时的半成品留档
      manifest.json      关闭或打断时导出的快照
  工作区根 = 启动 claude 时所在的目录（不要求是 git 仓库）。
  任务目录已写入本地 .git/info/exclude，不会入库。
  换一个会话也能按路径继续。

十、模型侧 action 速查（budget 工具）
  start status list recover resume dispatch retry probe
  phase plan extend gate close cancel card say stop view ref decline help
`;
