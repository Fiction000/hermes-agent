from __future__ import annotations

import json
from pathlib import Path

import pytest

from hermes_cli.kanban_capabilities import resolve_assignment


_INVALID_SELECTIONS = [123, "terminal", {"unexpected": "shape"}, None, False]
_VALID_POLICY = {"platform_toolsets": {"cli": ["file", "terminal", "browser"]}}


@pytest.fixture
def policy_profiles(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    for directory in (home, home / "profiles" / "candidate"):
        directory.mkdir(parents=True, exist_ok=True)
        directory.joinpath("config.yaml").write_text(json.dumps(_VALID_POLICY), encoding="utf-8")
    return home


def _save_policy(home, profile, policy):
    directory = home if profile == "default" else home / "profiles" / profile
    directory.joinpath("config.yaml").write_text(json.dumps(policy), encoding="utf-8")


@pytest.mark.parametrize("selection", _INVALID_SELECTIONS)
def test_explicit_invalid_selection_routes_to_valid_default(policy_profiles, selection):
    _save_policy(policy_profiles, "candidate", {"platform_toolsets": {"cli": selection}})
    decision = resolve_assignment("candidate", title="Implement feature")
    assert decision.resolved == "default"
    assert "invalid" in decision.reason
    assert decision.missing == ("file_write", "terminal")


@pytest.mark.parametrize("selection", _INVALID_SELECTIONS)
def test_invalid_default_refuses_creation_and_reclaim_without_db_changes(policy_profiles, selection):
    from hermes_cli import kanban_db as kb, kanban_db_connect as kbc

    kb.init_db()
    with kbc.connect_closing() as conn:
        task_id = kb.create_task(conn, title="Implement feature", assignee="default")
        assert kb.claim_task(conn, task_id, claimer="worker") is not None
        for profile in ("default", "candidate"):
            _save_policy(policy_profiles, profile, {"platform_toolsets": {"cli": selection}})
        before = list(conn.iterdump())
        with pytest.raises(ValueError, match="assignment rejected"):
            kb.create_task(conn, title="Implement another feature", assignee="candidate")
        assert list(conn.iterdump()) == before
        with pytest.raises(ValueError, match="assignment rejected"):
            kb.reassign_task(conn, task_id, "candidate", reclaim_first=True)
        assert list(conn.iterdump()) == before
        assert resolve_assignment("default", title="Implement feature").resolved is None
        read_only = resolve_assignment("candidate", title="Read-only review", operation="request_review")
        assert read_only.resolved is None
        assert "invalid" in read_only.reason


@pytest.mark.parametrize("policy, expected", [
    ({}, "candidate"),
    ({"platform_toolsets": {}}, "candidate"),
    ({"platform_toolsets": {"telegram": []}}, "candidate"),
    ({"platform_toolsets": {"cli": ["file", "terminal"]}}, "candidate"),
    ({"platform_toolsets": {"cli": '["file", "terminal"]'}}, "candidate"),
    ({"platform_toolsets": {"cli": []}}, "default"),
    ({"platform_toolsets": {"cli": "[]"}}, "default"),
])
def test_valid_selection_forms_preserve_runtime_meaning(policy_profiles, policy, expected):
    _save_policy(policy_profiles, "candidate", policy)
    decision = resolve_assignment("candidate", title="Implement feature")
    assert decision.resolved == expected
    read_only = resolve_assignment("candidate", title="Read-only review", operation="request_review")
    assert read_only.resolved == "candidate"


@pytest.mark.parametrize("section", [False, None, [], "terminal", 123])
def test_explicit_invalid_platform_section_routes_to_default(policy_profiles, section):
    _save_policy(policy_profiles, "candidate", {"platform_toolsets": section})
    decision = resolve_assignment("candidate", title="Implement feature")
    assert decision.resolved == "default"
    assert "invalid" in decision.reason
