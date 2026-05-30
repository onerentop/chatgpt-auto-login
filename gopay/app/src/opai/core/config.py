"""Centralized configuration — loads from config.json, falls back to env vars."""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

_cfg: dict[str, Any] = {}
_loaded = False

CONFIG_DIR = Path(__file__).resolve().parent.parent.parent.parent.parent / "config"


def _find_config_file() -> Path | None:
    override = os.environ.get("OPAI_CONFIG_FILE", "").strip()
    if override:
        p = Path(override).expanduser().resolve()
        if p.exists():
            return p
    candidate = CONFIG_DIR / "config.json"
    if candidate.exists():
        return candidate
    return None


def load_config() -> dict[str, Any]:
    global _cfg, _loaded
    if _loaded:
        return _cfg
    path = _find_config_file()
    if path:
        try:
            _cfg = json.loads(path.read_text(encoding="utf-8"))
            log.info("Config loaded from %s", path)
        except Exception as e:
            log.warning("Failed to load config from %s: %s", path, e)
            _cfg = {}
    else:
        _cfg = {}
    _loaded = True
    return _cfg


def get(section: str, key: str, default: Any = "") -> Any:
    """Get a config value: config.json > env var > default.

    Env var name is derived as OPAI_{SECTION}_{KEY} uppercased.
    For nested sections like sms.herosms.api_key, pass section="sms.herosms", key="api_key".
    """
    cfg = load_config()

    parts = section.split(".")
    node = cfg
    for p in parts:
        if isinstance(node, dict):
            node = node.get(p, {})
        else:
            node = {}
            break
    if isinstance(node, dict) and key in node:
        val = node[key]
        if val != "" and val is not None:
            return val

    env_name = "OPAI_" + "_".join(parts).upper() + "_" + key.upper()
    env_val = os.environ.get(env_name, "").strip()
    if env_val:
        if isinstance(default, int):
            return int(env_val)
        if isinstance(default, float):
            return float(env_val)
        if isinstance(default, bool):
            return env_val.lower() in ("1", "true", "yes")
        return env_val

    return default
