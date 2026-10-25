"""Adversarial capability routing regressions and mutation-boundary contracts."""
import json

import pytest

from tests.hermes_cli.test_kanban_capabilities import _profile
from hermes_cli.kanban_capabilities import required_capabilities, resolve_assignment

pytest_plugins = ["tests.hermes_cli.test_kanban_capabilities"]


@pytest.mark.parametrize("soul", [
    "Do not use the terminal.", "Never use terminal tools.", "ターミナルは使用しない。",
    "ターミナルは禁止。", "kanban-deny-capabilities: terminal",
])
def test_soul_denials_subtract_from_enabled_tools(capability_profiles, soul):
    _profile(capability_profiles, "limited", ["terminal", "file"], soul)
    assert resolve_assignment("limited", title="Run tests").resolved == "default"


def test_metadata_cannot_remove_inferred_work_and_review_is_separate(capability_profiles):
    assert resolve_assignment("writer", title="Implement feature", body="kanban-capabilities: file_write").resolved == "default"
    assert resolve_assignment("writer", title="Implement feature", operation="request_review").resolved == "writer"
    assert required_capabilities("Do not implement this; review the plan") == set()
    assert required_capabilities("実装は禁止。計画をレビュー") == set()
    with pytest.raises(ValueError, match="explicit.*mcp"):
        required_capabilities("Use MCP to retrieve records")


@pytest.mark.parametrize("config", [
    "[broken", "[]", "platform_toolsets: {cli: '${TOOLS}'}",
    "platform_toolsets: {cli: [terminal, file]}\ndisabled_toolsets: terminal",
])
def test_invalid_or_unresolved_config_falls_back(capability_profiles, config):
    path = capability_profiles / ".hermes/profiles/writer/config.yaml"
    path.write_text(config, encoding="utf-8")
    assert resolve_assignment("writer", title="Write article").resolved == "default"


def test_disable_tool_granularity_and_missing_readonly_profile(capability_profiles):
    path = capability_profiles / ".hermes/profiles/writer/config.yaml"
    path.write_text("platform_toolsets: {cli: [file]}\ndisabled_toolsets: [write_file, patch]", encoding="utf-8")
    assert resolve_assignment("writer", title="Write article").resolved == "default"
    assert resolve_assignment("absent", title="Review prose", operation="request_review").resolved == "default"


def test_assignment_paths_recheck_updated_card_and_atomic_children(capability_profiles):
    from hermes_cli import kanban_db as kb, kanban_db_connect as kbc
    from hermes_cli.kanban_db_graph import decompose_triage_task
    kb.init_db()
    with kbc.connect_closing() as conn:
        tid = kb.create_task(conn, title="Write article", assignee="writer", triage=True)
        assert kb.specify_triage_task(conn, tid, title="Implement CMS demo", body="Build and test")
        assert kb.get_task(conn, tid).assignee == "default"
        assert kb.assign_task(conn, tid, "designer")
        assert kb.get_task(conn, tid).assignee == "default"
        assert kb.reassign_task(conn, tid, "writer")
        assert kb.get_task(conn, tid).assignee == "default"
        root = kb.create_task(conn, title="Review plan", assignee="writer", triage=True)
        children = decompose_triage_task(conn, root, root_assignee="writer", children=[
            {"title": "Implement feature", "assignee": "designer"},
            {"title": "実操作 QA", "assignee": "fact-checker"},
            {"title": "文章の執筆", "assignee": "writer"},
        ])
        assert [kb.get_task(conn, c).assignee for c in children] == ["default", "default", "writer"]
        root2 = kb.create_task(conn, title="Review plan", assignee="writer", triage=True)
        before = conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0]
        (capability_profiles / ".hermes/config.yaml").write_text("platform_toolsets: {cli: [file]}", encoding="utf-8")
        with pytest.raises(ValueError, match="terminal"):
            decompose_triage_task(conn, root2, root_assignee="writer", children=[
                {"title": "Write article", "assignee": "writer"},
                {"title": "Implement feature", "assignee": "designer"},
            ])
        assert conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == before
        assert kb.get_task(conn, root2).status == "triage"


def test_review_fallback_preserves_requested_reviewer(capability_profiles):
    from hermes_cli import kanban_db as kb, kanban_db_connect as kbc
    kb.init_db()
    with kbc.connect_closing() as conn:
        tid = kb.create_task(conn, title="live browser QA", assignee="default")
        assert kb.request_review(conn, tid, reviewer="fact-checker", summary="Ready", force=True)
        assert kb.get_task(conn, tid).assignee == "default"
        payload = json.loads(conn.execute(
            "SELECT payload FROM task_events WHERE task_id=? AND kind='assignment_routed' ORDER BY id DESC LIMIT 1", (tid,),
        ).fetchone()[0])
        assert (payload["requested"], payload["resolved"]) == ("fact-checker", "default")


def test_dispatch_default_uses_routed_profile_and_rejects_without_assignment(capability_profiles):
    from hermes_cli import kanban_db as kb, kanban_db_connect as kbc, kanban_db_dispatch as kbd
    kb.init_db()
    with kbc.connect_closing() as conn:
        tid = kb.create_task(conn, title="Implement demo")
        assert kbd._apply_default_assignee(conn, tid, "designer", dry_run=True) == "default"
        assert kb.get_task(conn, tid).assignee is None
        assert kbd._apply_default_assignee(conn, tid, "designer", dry_run=False) == "default"
        assert kb.get_task(conn, tid).assignee == "default"
        assert kbd._apply_default_assignee(conn, tid, "writer", dry_run=False) is None
        rejected = kb.create_task(conn, title="Implement demo")
        (capability_profiles / ".hermes/config.yaml").write_text("platform_toolsets: {cli: [file]}", encoding="utf-8")
        assert kbd._apply_default_assignee(conn, rejected, "designer", dry_run=False) is None
        assert kb.get_task(conn, rejected).assignee is None
        assert conn.execute("SELECT COUNT(*) FROM task_events WHERE task_id=? AND kind='assignment_rejected'", (rejected,)).fetchone()[0] == 1


def test_reassign_uses_single_policy_snapshot_before_reclaim(capability_profiles, monkeypatch):
    from hermes_cli import kanban_db as kb, kanban_db_connect as kbc, kanban_capabilities as cap
    kb.init_db()
    with kbc.connect_closing() as conn:
        tid = kb.create_task(conn, title="Implement feature", assignee="default")
        original = cap.resolve_assignment
        decisions = []
        def snapshot(*args, **kwargs):
            decisions.append(original(*args, **kwargs))
            return decisions[-1]
        def reclaim(*args, **kwargs):
            (capability_profiles / ".hermes/config.yaml").write_text("platform_toolsets: {cli: [file]}", encoding="utf-8")
        monkeypatch.setattr(cap, "resolve_assignment", snapshot)
        monkeypatch.setattr(kb, "reclaim_task", reclaim)
        assert kb.reassign_task(conn, tid, "designer", reclaim_first=True)
        assert len(decisions) == 1
        assert kb.get_task(conn, tid).assignee == decisions[0].resolved == "default"


def test_decomposition_checks_inherited_worktree_before_any_insert(capability_profiles):
    from hermes_cli import kanban_db as kb, kanban_db_connect as kbc
    from hermes_cli.kanban_db_graph import decompose_triage_task
    kb.init_db()
    with kbc.connect_closing() as conn:
        root = kb.create_task(conn, title="Review plan", assignee="default", triage=True,
                              workspace_kind="worktree", workspace_path=str(capability_profiles / "repo"))
        children = decompose_triage_task(conn, root, root_assignee="writer", children=[
            {"title": "Write article", "assignee": "writer"},
            {"title": "Write prose", "assignee": "writer", "workspace_kind": "scratch"},
        ])
        assert [(kb.get_task(conn, t).workspace_kind, kb.get_task(conn, t).assignee) for t in children] == [
            ("worktree", "default"), ("scratch", "writer"),
        ]
        root2 = kb.create_task(conn, title="Review plan", assignee="default", triage=True,
                               workspace_kind="worktree", workspace_path=str(capability_profiles / "repo"))
        (capability_profiles / ".hermes/config.yaml").write_text("platform_toolsets: {cli: [file]}", encoding="utf-8")
        before = conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0]
        with pytest.raises(ValueError, match="terminal"):
            decompose_triage_task(conn, root2, root_assignee="writer", children=[
                {"title": "Write article", "assignee": "writer"},
            ])
        assert conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == before
        assert kb.get_task(conn, root2).status == "triage"


@pytest.mark.parametrize("tool_filter, expected", [
    ({"exclude": ["*"]}, None), ({"exclude": "**"}, None),
    ({"exclude": ["?*"]}, None), ({"include": [], "exclude": []}, None),
    ({"include": ["lookup"], "exclude": ["*"]}, "connector"),
    ({"exclude": ["delete_*"]}, "connector"),
])
def test_mcp_static_filter_respects_exclude_all_and_include_precedence(capability_profiles, tool_filter, expected):
    _profile(capability_profiles, "connector", ["file", "records"])
    path = capability_profiles / ".hermes/profiles/connector/config.yaml"
    path.write_text(json.dumps({
        "platform_toolsets": {"cli": ["file", "records"]},
        "mcp_servers": {"records": {"url": "https://example.invalid/mcp", "tools": tool_filter}},
    }), encoding="utf-8")
    assert resolve_assignment("connector", title="Lookup records", body="kanban-capabilities: mcp:records").resolved == expected
