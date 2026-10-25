"""Read-only Kanban assignment preflight, not runtime authorization.

Resolve the target profile's saved CLI tool selection, never this process's tool
registry or credentials. Requirements use bounded English/Japanese action cues;
``kanban-capabilities: terminal, browser, mcp:server`` adds explicit requirements.
SOUL denies are subtractive (including ``kanban-deny-capabilities: ...``). No
network calls, secret loading, profile activation, config writes, or role maps.
"""
from __future__ import annotations

from dataclasses import dataclass
import re
from pathlib import Path
from typing import Optional

import hermes_yaml as yaml


@dataclass(frozen=True)
class AssignmentDecision:
    requested: Optional[str]
    resolved: Optional[str]
    required: tuple[str, ...]
    missing: tuple[str, ...]
    reason: str


_KNOWN = {"terminal", "browser", "file_write"}
_METADATA = re.compile(r"(?mi)^\s*(?:<!--\s*)?kanban-capabilities\s*:\s*([^\n]*?)(?:\s*-->)?$")
_DENY_METADATA = re.compile(r"(?mi)^\s*(?:<!--\s*)?kanban-deny-capabilities\s*:\s*([^\n]*?)(?:\s*-->)?$")
_CODE = re.compile(r"\b(?:implement|implementation|code|coding|build|compile|deploy|debug|fix|pytest|git|npm|xcode|terminal|shell|run tests?)\b|実装|ビルド|コンパイル|デプロイ|コード修正|テスト実行|ターミナル", re.IGNORECASE)
_BROWSER = re.compile(r"\b(?:live browser|browser|playwright|selenium|interactive qa|live qa)\b|ブラウザ|実操作|画面操作|操作\s*QA", re.IGNORECASE)
_WRITE = re.compile(r"\b(?:write|draft|prose|article|edit|implement|save|create file)\b|文章|執筆|記事|原稿|書く|書き|編集|保存", re.IGNORECASE)
_READ_REVIEW = re.compile(r"\b(?:review|inspect|read.only)\b|レビュー|読み取り|読取", re.IGNORECASE)
# Remove simple negative action clauses before action matching. More complicated
# prose/quotes are deliberately not interpreted as a general semantic classifier.
_NEGATED = re.compile(
    r"\b(?:do not|don't|never|no need to)\s+[^\n.;!]*|"
    r"(?:実装|ビルド|テスト実行|ブラウザ操作)(?:は|を)?(?:禁止|不要|しない|行わない)", re.IGNORECASE,
)


def _tokens(matches) -> set[str]:
    result = set()
    for raw in matches:
        for token in re.split(r"[,\s]+", raw.strip()):
            if not token:
                continue
            if token not in _KNOWN and not re.fullmatch(r"mcp:[A-Za-z0-9_-]+", token):
                raise ValueError("unsupported Kanban capability declaration")
            result.add(token)
    return result


def required_capabilities(title: str, body: str = "", *, workspace_kind: str = "scratch", operation: str = "execute") -> set[str]:
    """Conservative action cues; declarations add to, never bypass, inference."""
    text = f"{title}\n{body or ''}"
    required = _tokens(_METADATA.findall(text))
    actions = _NEGATED.sub("", _METADATA.sub("", text))
    # A source/prose review does not inherit the implementation's commands or
    # worktree requirements. Live QA and explicit metadata still apply.
    reviewing = operation == "request_review"
    if not reviewing and _CODE.search(actions):
        required.update(("terminal", "file_write"))
    if _BROWSER.search(actions):
        required.add("browser")
    if not reviewing and _WRITE.search(actions):
        required.add("file_write")
    if not reviewing and workspace_kind == "worktree":
        required.update(("terminal", "file_write"))
    # Plain action cards without recognized cues require a writable artifact;
    # an explicitly read-only review can remain file-read-only.
    if not required and not reviewing and not _READ_REVIEW.search(actions):
        required.add("file_write")
    # Recognize named connectors without a role/server allowlist. Ambiguous MCP
    # work needs a declaration instead of borrowing the dispatcher's registry.
    for name in re.findall(r"([A-Za-z][A-Za-z0-9_-]*)\s+MCP(?![A-Za-z0-9_])", actions):
        if name.lower() not in {"use", "using", "via", "the", "a", "an"}:
            required.add(f"mcp:{name.lower()}")
    if re.search(r"\bMCP\b", actions, re.IGNORECASE) and not any(c.startswith("mcp:") for c in required):
        raise ValueError("MCP work requires an explicit kanban-capabilities: mcp:<server> declaration")
    return required


def _home(profile: str) -> Path:
    from hermes_cli.profiles import _get_default_hermes_home, _get_profiles_root, validate_profile_name
    validate_profile_name(profile)
    return _get_default_hermes_home() if profile == "default" else _get_profiles_root() / profile


def _soul_denied(soul: str) -> set[str]:
    denied = _tokens(_DENY_METADATA.findall(soul))
    nouns = {
        "terminal": r"terminal|shell|ターミナル|シェル",
        "browser": r"browser|ブラウザ",
        "file_write": r"file[- ]?writ(?:e|es|ing)|writ(?:e|ing)\s+(?:to\s+)?files?|ファイル(?:の)?(?:書き込み|書込|編集|変更)",
        "mcp": r"\bMCP\b",
    }
    for capability, noun in nouns.items():
        if re.search(rf"\b(?:no|never|do not|don't|cannot|can't|must not|without)\b[^\n.;。]{{0,200}}(?:{noun})", soul, re.IGNORECASE) or re.search(
            rf"(?:{noun})[^\n.;。]{{0,30}}(?:禁止|使わない|使用しない|利用しない|不可|できない)", soul, re.IGNORECASE,
        ):
            denied.add(capability)
    return denied


def _mcp_tools_available(filters) -> bool:
    """Static filter check; include wins over exclude, as in MCP registration.

    Discovery is unavailable here, so partial name filters cannot establish
    actual tool availability. Reject explicit empty includes and universal
    exclude globs over nonempty tool names without contacting the server.
    """
    if filters is None:
        return True
    if not isinstance(filters, dict) or "${" in repr(filters):
        raise ValueError("invalid or unresolved MCP tool filters")
    include = filters.get("include")
    exclude = filters.get("exclude")
    for value in (include, exclude):
        if value is not None and not isinstance(value, (str, list, tuple, set)):
            raise ValueError("invalid MCP tool filter")
    if include is not None:
        return bool(include) and any(str(p) for p in ([include] if isinstance(include, str) else include))
    patterns = [exclude] if isinstance(exclude, str) else exclude or []
    return not any("*" in str(p) and set(str(p)) <= {"*", "?"} and str(p).count("?") <= 1 for p in patterns)


def _read_profile_policy(home: Path) -> dict:
    """Read saved and managed policy without expanding credentials."""
    cfg = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8-sig"))
    if not isinstance(cfg, dict):
        raise ValueError("not a mapping")
    from hermes_cli.managed_scope import get_managed_dir
    managed_dir = get_managed_dir()
    if managed_dir is not None and (managed_dir / "config.yaml").exists():
        managed = yaml.safe_load((managed_dir / "config.yaml").read_text(encoding="utf-8-sig"))
        if not isinstance(managed, dict):
            raise ValueError("invalid managed configuration")
        from hermes_cli.config import _deep_merge
        cfg = _deep_merge(cfg, managed)
    policy = {k: cfg[k] for k in ("platform_toolsets", "toolsets", "disabled_toolsets") if k in cfg}
    if "${" in repr(policy):
        raise ValueError("unresolved policy reference")
    return cfg


def _capabilities(profile: str) -> tuple[set[str], str]:
    """Fail closed on unreadable/malformed configuration; no secret expansion.

    MCP connection/discovery is intentionally not performed here. A configured
    enabled, selected server is a *declared* capability, not a live health check.
    Runtime tool/auth/approval enforcement remains authoritative.
    """
    try:
        home = _home(profile)
        cfg = _read_profile_policy(home)
        from hermes_cli.tools_config import _get_platform_tools
        from toolsets import resolve_toolset
        selected = _get_platform_tools(cfg, "cli")
        if not isinstance(selected, (list, set, tuple)) or not all(isinstance(s, str) for s in selected):
            raise ValueError("invalid CLI tool selection")
        disabled = cfg.get("disabled_toolsets", [])
        if not isinstance(disabled, list) or not all(isinstance(s, str) for s in disabled):
            raise ValueError("invalid disabled toolsets")
        agent = cfg.get("agent") or {}
        if not isinstance(agent, dict):
            raise ValueError("invalid agent policy")
        from agent.skill_utils import parse_config_string_list
        agent_disabled = parse_config_string_list(agent.get("disabled_toolsets") or [])
        if not isinstance(agent_disabled, list) or not all(isinstance(s, str) for s in agent_disabled):
            raise ValueError("invalid agent disabled toolsets")
        if "${" in repr(agent_disabled):
            raise ValueError("unresolved disabled toolsets")
        disabled = set(disabled) | set(agent_disabled)
        selected = [s for s in selected if s not in disabled]
        tools = set()
        for toolset in selected:
            tools.update(resolve_toolset(toolset, include_registry=False))
        for toolset in disabled:
            tools.difference_update(resolve_toolset(toolset, include_registry=False))
        tools.difference_update(disabled)
        caps = set()
        if "terminal" in tools:
            caps.add("terminal")
        if "browser_navigate" in tools:
            caps.add("browser")
        if "write_file" in tools or "patch" in tools:
            caps.add("file_write")
        servers = cfg.get("mcp_servers", {})
        if not isinstance(servers, dict):
            raise ValueError("invalid MCP server mapping")
        for name, spec in servers.items():
            if not isinstance(spec, dict):
                raise ValueError("invalid MCP server configuration")
            if (spec.get("enabled", True) is True and (spec.get("command") or spec.get("url"))
                    and (name in selected or f"mcp:{name}" in selected or "all" in selected)
                    and name not in disabled and f"mcp:{name}" not in disabled and "mcp" not in disabled
                    and _mcp_tools_available(spec.get("tools"))):
                caps.add(f"mcp:{name}")
        soul_path = home / "SOUL.md"
        soul = soul_path.read_text(encoding="utf-8-sig") if soul_path.exists() else ""
        denied = _soul_denied(soul)
        caps.difference_update(denied)
        if "mcp" in denied:
            caps = {c for c in caps if not c.startswith("mcp:")}
        return caps, "resolved saved config and SOUL"
    except (OSError, ValueError, TypeError, AttributeError, yaml.YAMLError):
        return set(), "profile configuration or SOUL is missing, unreadable, or invalid"


def resolve_assignment(profile: Optional[str], *, title: str, body: str = "", workspace_kind: str = "scratch", operation: str = "execute") -> AssignmentDecision:
    if profile is None:
        return AssignmentDecision(None, None, (), (), "unassigned")
    required = required_capabilities(title, body, workspace_kind=workspace_kind, operation=operation)
    available, detail = _capabilities(profile)
    missing = required - available
    # Empty requirements (read-only review) must still validate profile config.
    valid = detail == "resolved saved config and SOUL"
    if valid and not missing:
        return AssignmentDecision(profile, profile, tuple(sorted(required)), (), detail)
    if profile != "default":
        fallback, fallback_detail = _capabilities("default")
        if fallback_detail == "resolved saved config and SOUL" and required <= fallback:
            return AssignmentDecision(profile, "default", tuple(sorted(required)), tuple(sorted(missing)),
                f"routed to default: requested profile lacks {', '.join(sorted(missing)) or 'valid configuration'} ({detail})")
    return AssignmentDecision(profile, None, tuple(sorted(required)), tuple(sorted(missing)),
        f"assignment rejected: {profile} lacks {', '.join(sorted(missing)) or 'valid configuration'} ({detail}); default is not a capable fallback")
