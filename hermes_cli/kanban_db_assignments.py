"""Assignment and reassignment subflows for the Kanban database facade."""

from __future__ import annotations

import sqlite3
from typing import Any, Optional


def create_task_assignment(assignee, *, title: str, body, workspace_kind: str):
    """Resolve and validate the explicit assignment requested at task creation."""
    from hermes_cli.kanban_capabilities import resolve_assignment

    assignment = resolve_assignment(
        assignee, title=title, body=body, workspace_kind=workspace_kind, operation="execute",
    )
    if assignment.resolved is None and assignee is not None:
        raise ValueError(assignment.reason)
    return assignment


def append_assignment_routed_event(conn: sqlite3.Connection, task_id: str, assignment) -> None:
    """Record the decision's stable capability provenance on its task."""
    from hermes_cli import kanban_db as _kb

    _kb._append_event(conn, task_id, "assignment_routed", {
        "requested": assignment.requested,
        "resolved": assignment.resolved,
        "required": list(assignment.required),
        "missing": list(assignment.missing),
        "reason": assignment.reason,
    })


def resolve_task_assignment(profile, *, title, body, workspace_kind, operation="execute"):
    """Resolve an assignment against task content for the requested operation."""
    from hermes_cli.kanban_capabilities import resolve_assignment

    return resolve_assignment(
        profile, title=title, body=body, workspace_kind=workspace_kind or "scratch",
        operation=operation,
    )


def assignment_decision(conn: sqlite3.Connection, task_id: str, profile: Optional[str]):
    """Take one capability snapshot before any reclaim or assignment side effects."""
    from hermes_cli import kanban_db as _kb
    from hermes_cli.kanban_capabilities import resolve_assignment

    profile = _kb._canonical_assignee(profile)
    task = conn.execute(
        "SELECT title, body, workspace_kind FROM tasks WHERE id = ?", (task_id,),
    ).fetchone()
    if task is None:
        return None
    decision = resolve_assignment(
        profile,
        title=task["title"],
        body=task["body"],
        workspace_kind=task["workspace_kind"] or "scratch",
        operation="execute",
    )
    if profile is not None and decision.resolved is None:
        raise ValueError(decision.reason)
    return decision


def assign_task(conn: sqlite3.Connection, task_id: str, profile: Optional[str]) -> bool:
    from hermes_cli import kanban_db as _kb

    decision = _kb._assignment_decision(conn, task_id, profile)
    return False if decision is None else _kb._assign_task_decided(conn, task_id, decision)


def assign_task_decided(conn: sqlite3.Connection, task_id: str, assignment) -> bool:
    """Persist the preflight decision and its provenance."""
    from hermes_cli import kanban_db as _kb

    profile = assignment.resolved
    with _kb.write_txn(conn):
        row = conn.execute(
            "SELECT status, claim_lock, assignee FROM tasks WHERE id = ?", (task_id,)
        ).fetchone()
        if not row:
            return False
        if row["claim_lock"] is not None and row["status"] == "running":
            raise RuntimeError(
                f"cannot reassign {task_id}: currently running (claimed). "
                "Wait for completion or reclaim the stale lock first."
            )
        if row["assignee"] != profile:
            conn.execute(
                "UPDATE tasks SET assignee = ?, consecutive_failures = 0, "
                "last_failure_error = NULL WHERE id = ?", (profile, task_id),
            )
        else:
            conn.execute("UPDATE tasks SET assignee = ? WHERE id = ?", (profile, task_id))
        _kb._append_event(
            conn, task_id, "assigned", {"assignee": profile, "from": row["assignee"]},
        )
        _kb._append_assignment_routed_event(conn, task_id, assignment)
    _kb.notify_task_updated(conn, task_id, ("assignee",))
    return True


def reassign_task(
    conn: sqlite3.Connection, task_id: str, profile: Optional[str], *, reclaim_first: bool = False,
    reason: Optional[str] = None,
) -> bool:
    """Reassign after preflight, optionally reclaiming before persistence."""
    from hermes_cli import kanban_db as _kb

    decision = _kb._assignment_decision(conn, task_id, profile)
    if decision is None:
        return False
    if reclaim_first:
        _kb.reclaim_task(conn, task_id, reason=reason or "reassign")
    try:
        return _kb._assign_task_decided(conn, task_id, decision)
    except RuntimeError:
        return False


def specify_triage_task_impl(
    conn: sqlite3.Connection, task_id: str, *, title: Optional[str] = None,
    body: Optional[str] = None, assignee: Optional[str] = None, author: Optional[str] = None,
) -> bool:
    """Apply assignment and content changes while promoting a triage task."""
    from hermes_cli import kanban_db as _kb

    if title is not None and not title.strip():
        raise ValueError("title cannot be blank")
    assignee = _kb._canonical_assignee(assignee)
    with _kb.write_txn(conn):
        existing = conn.execute(
            "SELECT title, body, assignee, workspace_kind FROM tasks WHERE id = ? AND status = 'triage'",
            (task_id,),
        ).fetchone()
        if existing is None:
            return False
        effective_title = title.strip() if title is not None else existing["title"]
        effective_body = body if body is not None else existing["body"]
        requested = assignee if assignee is not None else existing["assignee"]
        assignment = resolve_task_assignment(
            requested, title=effective_title, body=effective_body,
            workspace_kind=existing["workspace_kind"],
        )
        if requested is not None and assignment.resolved is None:
            raise ValueError(assignment.reason)
        assignee = assignment.resolved
        sets: list[str] = ["status = 'todo'"]
        params: list[Any] = []
        changed_fields: list[str] = []
        if title is not None and title.strip() != (existing["title"] or ""):
            sets.append("title = ?")
            params.append(title.strip())
            changed_fields.append("title")
        if body is not None and (body or "") != (existing["body"] or ""):
            sets.append("body = ?")
            params.append(body)
            changed_fields.append("body")
        if assignee is not None and assignee != (existing["assignee"] or None):
            sets.append("assignee = ?")
            params.append(assignee)
            changed_fields.append("assignee")
        params.append(task_id)
        cur = conn.execute(
            f"UPDATE tasks SET {', '.join(sets)} "
            f"WHERE id = ? AND status = 'triage'", tuple(params),
        )
        if cur.rowcount != 1:
            return False
        _kb._append_assignment_routed_event(conn, task_id, assignment)
        if changed_fields and author and author.strip():
            _kb._insert_comment(
                conn, task_id, author.strip(),
                "Specified — updated " + ", ".join(changed_fields) + " and promoted to todo.",
                int(_kb.time.time()),
            )
        _kb._append_event(
            conn, task_id, "specified",
            {"changed_fields": changed_fields} if changed_fields else None,
        )
    _kb.recompute_ready(conn)
    return True


def specify_triage_task(
    conn: sqlite3.Connection, task_id: str, *, title: Optional[str] = None,
    body: Optional[str] = None, assignee: Optional[str] = None, author: Optional[str] = None,
) -> bool:
    from hermes_cli.kanban_db_assignments import specify_triage_task_impl

    return specify_triage_task_impl(
        conn, task_id, title=title, body=body, assignee=assignee, author=author,
    )


def apply_default_assignee(
    conn: sqlite3.Connection, task_id: str, assignee: str, *, dry_run: bool,
) -> Optional[str]:
    """Apply the configured default to an unassigned ready task."""
    from hermes_cli import kanban_db as _kb
    from hermes_cli.kanban_capabilities import resolve_assignment

    row = conn.execute("SELECT title, body, workspace_kind FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        return None
    try:
        decision = resolve_assignment(
            assignee, title=row["title"], body=row["body"],
            workspace_kind=row["workspace_kind"] or "scratch", operation="execute",
        )
    except ValueError as exc:
        if not dry_run:
            with _kb.write_txn(conn):
                _kb._append_event(conn, task_id, "assignment_rejected", {"requested": assignee, "reason": str(exc)})
        return None
    if decision.resolved is None:
        if not dry_run:
            with _kb.write_txn(conn):
                _kb._append_event(conn, task_id, "assignment_rejected", {"requested": assignee, "reason": decision.reason})
        return None
    if dry_run:
        return decision.resolved
    try:
        with _kb.write_txn(conn):
            cur = conn.execute(
                "UPDATE tasks SET assignee = ? WHERE id = ? "
                "AND (assignee IS NULL OR assignee = '')",
                (decision.resolved, task_id),
            )
            if cur.rowcount != 1:
                return None
            _kb._append_event(
                conn, task_id, "assigned",
                {"assignee": decision.resolved, "source": "kanban.default_assignee"},
            )
            _kb._append_assignment_routed_event(conn, task_id, decision)
    except Exception:  # health: allow BLE001 -- preserve best-effort dispatch; the failure is logged with traceback.
        _kb._log.debug(
            "kanban dispatch: failed to apply default_assignee=%r to task %s",
            assignee, task_id, exc_info=True,
        )
        return None
    return decision.resolved
