"""数据源适配器：从 Claude Code 的 settings.json 读取 /model 名录。

`/model` 菜单显示的就是 settings 里 `modelPicker.options`（CC Switch 聚合模式写入），
所以这是名录的权威来源。只读，不碰 env 里的令牌。

返回 None 表示“数据源暂时读不到”（文件正在被改写、JSON 解析失败），调用方应保持现状；
返回 [] 表示“名录确实是空的”。
"""
import json
import os
import re

NAME = "claude_settings"


def claude_home():
    """CLAUDE_CONFIG_DIR > USERPROFILE/HOME > ~；返回 .claude 目录。"""
    configured = os.environ.get("CLAUDE_CONFIG_DIR")
    if configured:
        home = configured
    else:
        home = os.environ.get("USERPROFILE") or os.environ.get("HOME") or os.path.expanduser("~")
    m = re.match(r"^/([A-Za-z])/(.*)$", home)
    if os.name == "nt" and m:
        home = f"{m.group(1).upper()}:/{m.group(2)}"
    return home if configured else os.path.join(home, ".claude")


USER_SETTINGS = os.path.join(claude_home(), "settings.json")


def _load(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        return None


def list_models():
    d = _load(USER_SETTINGS)
    if d is None:
        return None
    options = (d.get("modelPicker") or {}).get("options") or []
    model_settings = d.get("modelSettings") or {}
    out = []
    for o in options:
        model = (o or {}).get("model")
        if not isinstance(model, str) or not model.strip():
            continue
        base = model.split("[", 1)[0]
        effort = (model_settings.get(model) or model_settings.get(base) or {}).get("effortLevel")
        out.append({
            "route_id": model,
            "label": o.get("label") or base,
            "description": o.get("description") or "",
            "effort": effort,
            "source": NAME,
        })
    return out
