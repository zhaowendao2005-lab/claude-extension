#!/usr/bin/env python3
"""model-agents 同步器。

把 /model 名录里的每个模型生成一个 `context: fork` 的 skill（~/.claude/skills/m-*），
主 agent 调用这个 skill 就等于用该模型派发一个子 agent。skill 目录由 Claude Code 实时监听，
所以名录变化后在当前会话里就能生效，不需要重启。

用法：
  sync.py sync [--quiet]   同步一次（hook 调用这个）
  sync.py list             打印名录和对应的 skill 名
  sync.py clean            删除本插件生成的全部 skill
"""
import contextlib
import importlib.util
import json
import os
import re
import shlex
import shutil
import sys
import tempfile

try:                       # POSIX
    import fcntl
except ImportError:        # Windows
    fcntl = None
try:
    import msvcrt
except ImportError:
    msvcrt = None


def claude_home():
    """CLAUDE_CONFIG_DIR > USERPROFILE/HOME > ~；返回 .claude 目录。"""
    configured = os.environ.get("CLAUDE_CONFIG_DIR")
    if configured:
        home = configured
    else:
        home = os.environ.get("USERPROFILE") or os.environ.get("HOME") or os.path.expanduser("~")
    # Git Bash 可能给出 /c/Users/x，转成 C:/Users/x 供原生 Python 使用。
    m = re.match(r"^/([A-Za-z])/(.*)$", home)
    if os.name == "nt" and m:
        home = f"{m.group(1).upper()}:/{m.group(2)}"
    return home if configured else os.path.join(home, ".claude")


PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLAUDE_HOME = claude_home()
SKILLS_DIR = os.path.join(CLAUDE_HOME, "skills")
STATE_DIR = os.path.join(CLAUDE_HOME, "model-agents")
LOCK_PATH = os.path.join(STATE_DIR, "sync.lock")
LOG_PATH = os.path.join(STATE_DIR, "sync.log")
CONFIG_PATH = os.path.join(STATE_DIR, "config.json")
MARKER = ".model-agents"          # 生成的 skill 目录里放这个文件，清理时只认它
PREFIX = "m-"

DEFAULT_CONFIG = {
    "adapters": ["claude_settings"],
    "include": [],                 # 为空表示全部；否则按 route_id 子串匹配
    "exclude": [],
    "agent": "general-purpose",
    "background": True,
}


def log(msg):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        import time
        f.write(time.strftime("%F %T ") + msg + "\n")


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            cfg.update(json.load(f))
    except (OSError, ValueError):
        pass
    return cfg


def load_adapter(name):
    path = os.path.join(PLUGIN_ROOT, "adapters", name + ".py")
    spec = importlib.util.spec_from_file_location("model_agents_adapter_" + name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def slug(s):
    s = s.lower().replace("[1m]", "")
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return re.sub(r"-+", "-", s).strip("-")


def skill_name(route_id):
    rid = route_id
    if rid.startswith("ccs-claude-") and "--" in rid:
        provider, model = rid[len("ccs-claude-"):].split("--", 1)
        base = slug(model) + "--" + slug(provider)
    else:
        base = slug(rid)
    return (PREFIX + base)[:64].rstrip("-")


def python_exe():
    """选一个可用的 Python 解释器；Windows 优先 python（python3 可能是 Store 存根）。"""
    override = os.environ.get("CLAUDE_PYTHON") or os.environ.get("PYTHON")
    if override:
        return override
    candidates = ("python", "python3", "py") if os.name == "nt" else ("python3", "python")
    for cand in candidates:
        if shutil.which(cand):
            return cand
    return sys.executable or "python"


def q(s):
    """YAML 双引号字符串（JSON 字符串是合法的 YAML）。"""
    return json.dumps(s, ensure_ascii=False)


def render(entry, cfg):
    route_id = entry["route_id"]
    window = "1M" if route_id.lower().endswith("[1m]") else "200K"
    label = entry["label"]
    desc = (
        f"仅当用户明确点名要用 {label} 这个模型派发子 agent 时调用（{entry['description'] or route_id}，"
        f"上下文 {window}）。参数写完整、自包含的任务说明：子 agent 看不到当前对话。"
    )
    short = route_id
    for suffix in ("[1M]", "[1m]"):
        if short.endswith(suffix):
            short = short[: -len(suffix)]
            break
    if "--" in short:
        short = short.split("--", 1)[1]
    short = short.rsplit("/", 1)[-1]
    when = (
        f"用户点名该模型、其简称或供应商时，例如“用 {short} 做…”。"
        f"用户没有指定模型时不要调用，按正常方式派发子 agent。"
    )
    lines = [
        "---",
        f"name: {entry['name']}",
        f"description: {q(desc)}",
        f"when_to_use: {q(when)}",
        "user-invocable: false",
        "context: fork",
        f"agent: {cfg['agent']}",
        f"model: {q(route_id)}",
    ]
    if entry.get("effort"):
        lines.append(f"effort: {entry['effort']}")
    if not cfg.get("background", True):
        lines.append("background: false")
    lines += [
        "metadata:",
        "  generated-by: model-agents",
        f"  route-id: {q(entry['route_id'])}",
        "---",
        "",
        "$ARGUMENTS",
        "",
    ]
    return "\n".join(lines)


def render_models_cmd():
    """subagent-models 这个固定 skill 的内容。"""
    sync = os.path.join(PLUGIN_ROOT, "bin", "sync.py")
    py_arg = shlex.quote(python_exe())
    sync_arg = shlex.quote(sync.replace(os.sep, "/"))
    return "\n".join([
        "---",
        "name: subagent-models",
        f"description: {q('查看当前可用于派发子 agent 的模型名录')}",
        "disable-model-invocation: true",
        f"allowed-tools: Bash({py_arg} -I {sync_arg} list)",
        "metadata:",
        "  generated-by: model-agents",
        "---",
        "",
        "## 当前可派发的模型",
        f"!`{py_arg} -I {sync_arg} list`",
        "",
        "把上面的表格原样展示给用户，不要增删条目，不要调用任何工具。",
        "",
    ])


def collect(cfg):
    """返回 [entry...]；任何适配器读不到就返回 None（保持现状）。"""
    entries = []
    for name in cfg["adapters"]:
        try:
            got = load_adapter(name).list_models()
        except Exception as e:  # 适配器出错也不能影响会话
            log(f"adapter {name} error: {e!r}")
            return None
        if got is None:
            log(f"adapter {name} unavailable, keep current skills")
            return None
        entries.extend(got)
    inc, exc = cfg.get("include") or [], cfg.get("exclude") or []
    out, seen = [], {}
    for e in entries:
        rid = e["route_id"]
        if inc and not any(p in rid for p in inc):
            continue
        if any(p in rid for p in exc):
            continue
        if rid in seen:                      # 同一路由只生成一次
            continue
        n = skill_name(rid)
        if n in seen.values():
            i = 2
            while f"{n[:60]}-{i}" in seen.values():
                i += 1
            n = f"{n[:60]}-{i}"
        seen[rid] = n
        e["name"] = n
        out.append(e)
    return out


def owned_skills():
    if not os.path.isdir(SKILLS_DIR):
        return {}
    res = {}
    for d in os.listdir(SKILLS_DIR):
        p = os.path.join(SKILLS_DIR, d)
        if os.path.isfile(os.path.join(p, MARKER)):
            res[d] = p
    return res


def write_atomic(path, text):
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp-")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def sync(quiet):
    cfg = load_config()
    entries = collect(cfg)
    if entries is None:
        return 0
    os.makedirs(SKILLS_DIR, exist_ok=True)
    owned = owned_skills()
    wanted = {e["name"]: e for e in entries}
    added = updated = removed = 0

    for name, e in wanted.items():
        d = os.path.join(SKILLS_DIR, name)
        if os.path.exists(d) and name not in owned:
            log(f"skip {name}: directory exists and is not ours")
            continue
        os.makedirs(d, exist_ok=True)
        text = render(e, cfg)
        f = os.path.join(d, "SKILL.md")
        try:
            old = open(f, encoding="utf-8").read()
        except OSError:
            old = None
        if old != text:
            write_atomic(f, text)
            updated += old is not None
            added += old is None
        m = os.path.join(d, MARKER)
        if not os.path.exists(m):
            open(m, "w").close()

    cmd_name = "subagent-models"
    cmd_dir = os.path.join(SKILLS_DIR, cmd_name)
    if os.path.exists(cmd_dir) and cmd_name not in owned:
        log(f"skip {cmd_name}: directory exists and is not ours")
    else:
        os.makedirs(cmd_dir, exist_ok=True)
        text = render_models_cmd()
        f = os.path.join(cmd_dir, "SKILL.md")
        try:
            old = open(f, encoding="utf-8").read()
        except OSError:
            old = None
        if old != text:
            write_atomic(f, text)
            updated += old is not None
            added += old is None
        m = os.path.join(cmd_dir, MARKER)
        if not os.path.exists(m):
            open(m, "w").close()

    for name, d in owned.items():
        if name not in wanted and name != cmd_name:
            shutil.rmtree(d, ignore_errors=True)
            removed += 1

    if added or updated or removed:
        log(f"sync: +{added} ~{updated} -{removed} total={len(wanted)}")
    if not quiet:
        print(f"同步完成：新增 {added}，更新 {updated}，删除 {removed}，共 {len(wanted)} 个模型 skill")
    return 0


def list_cmd():
    cfg = load_config()
    entries = collect(cfg)
    if entries is None:
        print("数据源暂时读不到")
        return 0
    print("| 供应商 | 模型 | 上下文 | skill | 状态 |")
    print("| --- | --- | --- | --- | --- |")
    for e in entries:
        rid = e["route_id"]
        provider, model = "-", rid
        if rid.startswith("ccs-claude-") and "--" in rid:
            provider, model = rid[len("ccs-claude-"):].split("--", 1)
            if model.lower().endswith("[1m]"):
                model = model[:-len("[1M]")]
        m = re.search(r"（([^）]*)）", e.get("label") or "")
        if m:
            provider = m.group(1)
        window = "1M" if rid.lower().endswith("[1m]") else "200K"
        name = e["name"]
        status = "已同步" if os.path.isfile(os.path.join(SKILLS_DIR, name, "SKILL.md")) else "缺失"
        print(f"| {provider} | {model} | {window} | {name} | {status} |")
    print(f"共 {len(entries)} 个模型。")
    return 0


def clean():
    n = 0
    for _, d in owned_skills().items():
        shutil.rmtree(d, ignore_errors=True)
        n += 1
    print(f"已删除 {n} 个生成的 skill")
    return 0


@contextlib.contextmanager
def file_lock(path):
    """跨平台文件锁：POSIX 用 fcntl，Windows 用 msvcrt；同步幂等，拿不到锁也放行。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a+b") as lk:
        if fcntl is not None:
            fcntl.flock(lk.fileno(), fcntl.LOCK_EX)
        elif msvcrt is not None:
            lk.seek(0)
            if not lk.read(1):
                lk.write(b"\0")
                lk.flush()
            import time
            deadline = time.time() + 10
            while True:
                try:
                    lk.seek(0)
                    msvcrt.locking(lk.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    if time.time() > deadline:
                        break
                    time.sleep(0.05)
        try:
            yield
        finally:
            if fcntl is not None:
                fcntl.flock(lk.fileno(), fcntl.LOCK_UN)
            elif msvcrt is not None:
                try:
                    lk.seek(0)
                    msvcrt.locking(lk.fileno(), msvcrt.LK_UNLCK, 1)
                except OSError:
                    pass


def main(argv):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    cmd = argv[1] if len(argv) > 1 else "sync"
    quiet = "--quiet" in argv
    if cmd in ("install-watcher", "uninstall-watcher", "watcher-status"):
        print("watcher 已移除；skill 在会话启动时同步。")
        return 0
    os.makedirs(STATE_DIR, exist_ok=True)
    with file_lock(LOCK_PATH):
        if cmd == "sync":
            return sync(quiet)
        if cmd == "list":
            return list_cmd()
        if cmd == "clean":
            return clean()
    print(__doc__)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception as e:  # hook 永远不能阻塞会话
        try:
            log(f"fatal: {e!r}")
        except Exception:
            pass
        sys.exit(0)
