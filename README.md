# zhaowendao's Claude Extension Marketplaces

Claude Code plugin marketplace: `zhaowendao-claude-extension`.

## Install

```bash
claude plugin marketplace add zhaowendao2005/claude-extension
claude plugin install orcheatractor-zhaowendao@zhaowendao-claude-extension
```

Inside a session:

```text
/plugin marketplace add zhaowendao2005/claude-extension
/plugin install orcheatractor-zhaowendao@zhaowendao-claude-extension
```

## Plugin

| Plugin | Category | Description |
| --- | --- | --- |
| `orcheatractor-zhaowendao` | workflow | Model-agent orchestration with an optional time budget, plus fuzzy model search (`/model-search`). |

命令：

- `/orcheatractor-zhaowendao 10m <任务>` 开启时间预算编排
- `/orcheatractor-zhaowendao 状态` / `延时 5m` / `关闭`
- `/model-search` 模糊搜索并切换模型

## Development

```bash
claude plugin validate . --strict
claude plugin validate plugins/orcheatractor-zhaowendao --strict
claude plugin test plugins/orcheatractor-zhaowendao
python -I plugins/orcheatractor-zhaowendao/model-agents/bin/sync.py list
```

### Layout

```text
.claude-plugin/marketplace.json           marketplace catalog
plugins/orcheatractor-zhaowendao/         the single plugin
  hooks/{register.ts,register.tsx}         budget/orchestration + model-search UI
  model-agents/                            generates ~/.claude/skills/m-* dispatch skills
  types/index.d.ts                         hand-written PluginState contract (committed)
  .claude-plugin/types/                    engine-generated shims (gitignored)
```

## License

MIT — see [LICENSE](LICENSE).
