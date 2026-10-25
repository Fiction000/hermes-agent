from __future__ import annotations

from pathlib import Path

import pytest

from hermes_cli.kanban_capabilities import required_capabilities, resolve_assignment


def _profile(tmp_path: Path, name: str, toolsets: list[str], soul: str = "") -> None:
    home = tmp_path / ".hermes"
    profile_home = home if name == "default" else home / "profiles" / name
    profile_home.mkdir(parents=True, exist_ok=True)
    (profile_home / "config.yaml").write_text(
        "platform_toolsets:\n  cli: [" + ", ".join(toolsets) + "]\n", encoding="utf-8",
    )
    if soul:
        (profile_home / "SOUL.md").write_text(soul, encoding="utf-8")


@pytest.fixture
def capability_profiles(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / ".hermes"))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    _profile(tmp_path, "default", ["terminal", "file", "browser"])
    _profile(tmp_path, "designer", ["file", "browser"], "No terminal, browser, file writing, publishing, or external sends.")
    _profile(tmp_path, "fact-checker", ["file"], "Read and write evidence summaries. No browser or terminal.")
    _profile(tmp_path, "writer", ["file"])
    return tmp_path


def test_bilingual_inference_and_explicit_capabilities():
    assert required_capabilities("実装して") == {"file_write", "terminal"}
    assert required_capabilities("実操作 QA") == {"browser"}
    assert required_capabilities("実操作QA") == {"browser"}
    assert required_capabilities("テスト実行") == {"file_write", "terminal"}
    assert required_capabilities("文章を書いて") == {"file_write"}
    assert required_capabilities("work", "kanban-capabilities: terminal,browser") == {"browser", "terminal"}
    with pytest.raises(ValueError, match="unsupported Kanban capability"):
        required_capabilities("work", "kanban-capabilities: magic")


def test_profile_soul_subtracts_enabled_tools_and_routes_to_default(capability_profiles):
    decision = resolve_assignment("designer", title="Build and test code", body="", workspace_kind="scratch")
    assert decision.resolved == "default"
    assert decision.required == ("file_write", "terminal")
    assert "routed to default" in decision.reason


def test_review_separation_and_writer_assignment(capability_profiles):
    review = resolve_assignment("designer", title="Review source", body="", operation="request_review")
    assert review.resolved == "designer"
    implementation_review = resolve_assignment(
        "designer", title="Review source", body="kanban-capabilities: terminal,file_write",
        operation="request_review",
    )
    assert implementation_review.resolved == "default"
    live_qa = resolve_assignment("designer", title="Review source", body="live browser QA", operation="request_review")
    assert live_qa.resolved == "default"
    prose = resolve_assignment("writer", title="Write a short prose draft", body="")
    assert prose.resolved == "writer"


def test_missing_profile_rejects_when_default_cannot_cover(capability_profiles):
    _profile(capability_profiles, "default", ["file"])
    decision = resolve_assignment("absent", title="Run live browser QA", body="")
    assert decision.resolved is None
    assert decision.missing == ("browser",)
    assert "default is not a capable fallback" in decision.reason


def test_none_remains_unassigned(capability_profiles):
    decision = resolve_assignment(None, title="Build code", body="")
    assert decision.resolved is None
    assert decision.reason == "unassigned"


def test_mcp_requires_named_enabled_profile_server(capability_profiles):
    _profile(capability_profiles, "connector", ["file"])
    path = capability_profiles / ".hermes" / "profiles" / "connector" / "config.yaml"
    path.write_text(
        "platform_toolsets:\n  cli: [file, records]\n"
        "mcp_servers:\n  records:\n    enabled: true\n    url: https://example.invalid/mcp\n",
        encoding="utf-8",
    )
    allowed = resolve_assignment(
        "connector", title="Lookup records", body="kanban-capabilities: mcp:records",
    )
    assert allowed.resolved == "connector"
    denied = resolve_assignment(
        "connector", title="Lookup other", body="kanban-capabilities: mcp:unknown",
    )
    assert denied.resolved is None
    assert "mcp:unknown" in denied.reason


def test_create_task_persists_fallback_and_safe_audit_event(capability_profiles):
    from hermes_cli import kanban_db as kb, kanban_db_connect as kbc

    kb.init_db()
    with kbc.connect_closing() as conn:
        task_id = kb.create_task(conn, title="Implement code", assignee="designer")
        task = kb.get_task(conn, task_id)
        assert task is not None
        assert task.assignee == "default"
        event = conn.execute(
            "SELECT payload FROM task_events WHERE task_id = ? AND kind = 'assignment_routed'",
            (task_id,),
        ).fetchone()
        import json
        payload = json.loads(event["payload"])
        assert payload["requested"] == "designer"
        assert payload["resolved"] == "default"
        assert payload["required"] == ["file_write", "terminal"]
        assert "No terminal" not in payload["reason"]


def test_db_assignment_rejects_live_reclaim_before_side_effects(capability_profiles):
    from hermes_cli import kanban_db as kb, kanban_db_connect as kbc

    kb.init_db()
    with kbc.connect_closing() as conn:
        task_id = kb.create_task(conn, title="Build and test code", assignee="default")
        assert kb.get_task(conn, task_id).assignee == "default"
        (capability_profiles / ".hermes" / "config.yaml").write_text(
            "platform_toolsets:\n  cli: [file, browser]\n", encoding="utf-8",
        )
        claimed = kb.claim_task(conn, task_id, claimer="test-worker")
        assert claimed is not None
        run_id = claimed.current_run_id
        before = tuple(conn.execute(
            "SELECT status, assignee, claim_lock, current_run_id FROM tasks WHERE id=?", (task_id,),
        ).fetchone())
        events_before = conn.execute("SELECT COUNT(*) FROM task_events WHERE task_id=?", (task_id,)).fetchone()[0]
        with pytest.raises(ValueError, match="terminal"):
            kb.reassign_task(conn, task_id, "designer", reclaim_first=True)
        assert tuple(conn.execute(
            "SELECT status, assignee, claim_lock, current_run_id FROM tasks WHERE id=?", (task_id,),
        ).fetchone()) == before
        assert conn.execute("SELECT COUNT(*) FROM task_events WHERE task_id=?", (task_id,)).fetchone()[0] == events_before
        assert run_id == before[3]


def test_specify_decompose_atomic_idempotency_and_review_handoff(capability_profiles):
    from hermes_cli import kanban_db as kb, kanban_db_connect as kbc
    from hermes_cli.kanban_db_graph import decompose_triage_task

    kb.init_db()
    with kbc.connect_closing() as conn:
        first = kb.create_task(conn, title="Idempotent work", idempotency_key="stable-key", assignee="writer")
        assert kb.create_task(conn, title="Different duplicate", idempotency_key="stable-key") == first
        assert conn.execute("SELECT COUNT(*) FROM tasks WHERE idempotency_key='stable-key'").fetchone()[0] == 1

        triage = kb.create_task(conn, title="Needs specification", triage=True)
        assert kb.specify_triage_task(conn, triage, title="Specified", body="Updated requirements", author="operator")
        task = kb.get_task(conn, triage)
        assert (task.title, task.body) == ("Specified", "Updated requirements")

        root = kb.create_task(conn, title="Break down", triage=True)
        with pytest.raises(ValueError, match="cyclic"):
            decompose_triage_task(conn, root, root_assignee="default", children=[
                {"title": "First", "assignee": "writer", "parents": [1]},
                {"title": "Second", "assignee": "writer", "parents": [0]},
            ])
        assert kb.get_task(conn, root).status == "triage"
        assert not kb.child_ids(conn, root)
        child_ids = decompose_triage_task(conn, root, root_assignee="default", children=[
            {"title": "Draft prose", "assignee": "writer"},
        ])
        assert child_ids and len(child_ids) == 1
        # In auto-decomposition the root depends on its generated children.
        assert kb.parent_ids(conn, root) == child_ids


def test_review_audit_requested_candidate_and_reopen(capability_profiles):
    from hermes_cli import kanban_db as kb, kanban_db_connect as kbc

    kb.init_db()
    with kbc.connect_closing() as conn:
        task_id = kb.create_task(conn, title="Implement feature", assignee="designer")
        assert kb.get_task(conn, task_id).assignee == "default"
        assert kb.request_review(conn, task_id, summary="ready", reviewer="fact-checker", force=True)
        task = kb.get_task(conn, task_id)
        assert task.status == "review" and task.assignee == "fact-checker"
        routed = conn.execute(
            "SELECT payload FROM task_events WHERE task_id=? AND kind='assignment_routed' ORDER BY id DESC LIMIT 1",
            (task_id,),
        ).fetchone()
        import json
        assert json.loads(routed["payload"])["requested"] == "fact-checker"
        assert kb.reopen_review_task(conn, task_id)
        assert kb.get_task(conn, task_id).status in {"ready", "todo"}
