"""An unsent best-effort prune must not poison required worker persistence."""
import copy
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from unittest.mock import patch

import pytest

from agent.runtime_session_store import WorkerPersistenceError


def _encoded(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(',', ':')).encode()


def test_proactive_prune_oversize_keeps_transcript_and_allows_next_append(worker, caplog):
    from agent.context_compressor import ContextCompressor

    db, store = worker
    messages: list[dict[str, Any]] = [{'role': 'user', 'content': 'start'}]
    for index in range(8):
        call_id = f'call-{index}'
        messages.extend([
            {'role': 'assistant', 'content': '', 'tool_calls': [{
                'id': call_id, 'type': 'function',
                'function': {'name': 'terminal', 'arguments': '{}'}}]},
            {'role': 'tool', 'tool_call_id': call_id,
             'content': chr(0x3042 + index) * 260_000 if index < 3 else 'ok'},
        ])
    # Individual writes fit; the archive's messages + held_for_cas do not.
    for message in messages:
        store.append_messages_batch('owned', [message])
        message['_db_persisted'] = True
    original = copy.deepcopy(messages)
    durable_before = db.get_messages_as_conversation('owned', include_row_ids=True)
    candidate_sizes = []
    rpc_operations = []
    save, rpc = store._save, store.rpc

    def observe_save(candidate, **kwargs):
        if candidate['pending'] and candidate['pending'][-1]['operation'] == 'compression.archive':
            entry = candidate['pending'][-1]
            assert entry['payload']['held_for_cas']
            assert entry['payload']['messages']
            candidate_sizes.append((len(_encoded(candidate)), len(json.dumps(
                candidate, ensure_ascii=False, separators=(',', ':')).encode())))
        return save(candidate, **kwargs)

    def observe_rpc(method, **params):
        rpc_operations.append(params['operation'])
        return rpc(method, **params)

    with patch('agent.context_compressor.get_model_context_length', return_value=1_000_000):
        compressor = ContextCompressor(model='test', quiet_mode=True,
            protect_first_n=2, protect_last_n=4, proactive_prune_tokens=48_000,
            proactive_prune_min_result_chars=8_000)
    compressor.proactive_prune_min_reclaim_tokens = 4096
    compressor._session_db, compressor._session_id = store, 'owned'
    old_rearm = compressor._proactive_prune_rearm_tokens
    with patch.object(store, '_save', observe_save), patch.object(store, 'rpc', observe_rpc):
        result, count = compressor.prune_tool_results_only(messages, current_tokens=600_000)

    assert candidate_sizes and candidate_sizes[0][0] > store.max_bytes
    assert candidate_sizes[0][1] < store.max_bytes  # ASCII expansion crosses the real cap.
    print('synthetic prune bytes (ASCII, UTF-8, cap):', *candidate_sizes[0], store.max_bytes)
    assert result is messages and count == 0 and messages == original
    assert compressor._proactive_prune_rearm_tokens == old_rearm
    assert db.get_messages_as_conversation('owned', include_row_ids=True) == durable_before
    assert 'compression.archive' not in rpc_operations
    assert store.journal['pending'] == []
    assert json.loads(store.path.read_bytes()) == store.journal
    assert store.failure is None
    assert 'encoded_bytes=' in caplog.text and 'max_bytes=' in caplog.text
    assert messages[2]['content'] not in caplog.text
    store.append_messages_batch('owned', [{'role': 'assistant', 'content': 'after rejected prune'}])
    assert db.get_messages_as_conversation('owned')[-1]['content'] == 'after rejected prune'
    assert db._read_one('SELECT last_sequence FROM worker_executions')[0] == store.journal['next_sequence'] - 1


def test_optional_archive_capacity_rejection_is_unsent_and_journal_unchanged(worker):
    db, store = worker
    store.max_bytes = 1024
    before = copy.deepcopy(store.journal)
    disk_before = store.path.read_bytes()
    with patch.object(store, 'rpc', side_effect=AssertionError('must not send')):
        with pytest.raises(WorkerPersistenceError, match='outbox_full'):
            store.archive_pruned_messages('owned', [{'role': 'assistant', 'content': 'x' * 2000}])
    assert store.failure is None
    assert store.journal == before and store.path.read_bytes() == disk_before
    store.append_messages_batch('owned', [{'role': 'assistant', 'content': 'after'}])
    assert [m['content'] for m in db.get_messages_as_conversation('owned')] == ['after']


def test_required_archive_capacity_rejection_remains_sticky(worker):
    _db, store = worker
    store.max_bytes = 1024
    before = store.path.read_bytes()
    with pytest.raises(WorkerPersistenceError, match='outbox_full'):
        store.archive_and_compact('owned', [{'role': 'assistant', 'content': 'x' * 2000}])
    assert store.failure == 'outbox_full' and store.path.read_bytes() == before
    with pytest.raises(WorkerPersistenceError, match='outbox_full'):
        store.append_messages_batch('owned', [{'role': 'assistant', 'content': 'after'}])


@pytest.mark.parametrize('offset', [-1, 0, 1])
def test_optional_archive_exact_ascii_journal_boundary(worker, offset):
    _db, store = worker
    assert store.max_bytes == 4 * 1024 * 1024
    messages = [{'role': 'assistant', 'content': ''}]
    payload = dict(messages=messages, model_config_patch=None, watermark=None, lock_holder=None,
                   tail_count=0, carried_messages=[], covered_ids=None, unresolved_held=None, held_for_cas=None)
    candidate = copy.deepcopy(store.journal)
    candidate['pending'].append(dict(sequence=candidate['next_sequence'],
                                     operation='compression.archive', payload=payload))
    candidate['next_sequence'] += 1
    messages[0]['content'] = 'x' * (store.max_bytes - len(_encoded(candidate)) + offset)
    assert len(_encoded(candidate)) == store.max_bytes + offset
    if offset > 0:
        with pytest.raises(WorkerPersistenceError, match='outbox_full'):
            store.archive_pruned_messages('owned', messages)
    else:
        assert store.archive_pruned_messages('owned', messages) == 1
    assert store.failure is None
    assert store.path.stat().st_size <= store.max_bytes


@pytest.mark.parametrize('failure', ['lost_ack', 'filesystem', 'ack_cleanup_capacity'])
def test_optional_archive_only_recovers_presend_capacity_rejection(worker, failure):
    db, store = worker
    rpc, save = store.rpc, store._save
    calls = []

    def fault_rpc(method, **params):
        calls.append(params)
        result = rpc(method, **params)
        if failure == 'lost_ack':
            raise TimeoutError('lost-ack')
        return result

    def fault_save(candidate, **kwargs):
        if failure == 'filesystem':
            raise OSError('disk-failed')
        if failure == 'ack_cleanup_capacity' and calls and not candidate['pending']:
            # The owner committed; even a capacity error at cleanup stays sticky.
            store.max_bytes = 1
        return save(candidate, **kwargs)

    with patch.object(store, 'rpc', fault_rpc), patch.object(store, '_save', fault_save):
        with pytest.raises((TimeoutError, OSError, WorkerPersistenceError)):
            store.archive_pruned_messages('owned', [{'role': 'assistant', 'content': 'summary'}])
    assert store.failure
    pending_before = copy.deepcopy(store.journal)
    with patch.object(store, 'rpc', side_effect=AssertionError('no automatic replay')):
        with pytest.raises(WorkerPersistenceError):
            store.append_messages_batch('owned', [{'role': 'assistant', 'content': 'unsafe'}])
    assert store.journal == pending_before
    if failure != 'filesystem':
        assert len(store.journal['pending']) == 1
        assert [r['content'] for r in db.get_messages_as_conversation('owned')] == ['summary']
        store.max_bytes = 4 * 1024 * 1024
        store.retry_pending()  # Existing sequence/digest receipt replay, never a fresh command.
        assert store.failure is None and store.journal['pending'] == []
        assert [r['content'] for r in db.get_messages_as_conversation('owned')] == ['summary']
        assert db._read_one('SELECT COUNT(*) FROM worker_receipts')[0] == 1
    else:
        assert not calls and not store.journal['pending']


@pytest.mark.parametrize('lost_ack', [False, True])
def test_slow_owner_never_admits_a_second_command_before_receipt(worker, lost_ack):
    db, store = worker
    entered, release = threading.Event(), threading.Event()
    rpc = store.rpc
    calls = []

    def slow_owner(method, **params):
        calls.append(params['sequence'])
        result = rpc(method, **params)
        if params['operation'] == 'compression.archive':
            entered.set()
            assert release.wait(10), 'test did not release the synthetic owner'
            if lost_ack:
                raise TimeoutError('slow-owner-lost-ack')
        return result

    with patch.object(store, 'rpc', slow_owner), ThreadPoolExecutor(max_workers=2) as pool:
        archive = pool.submit(store.archive_pruned_messages, 'owned', [
            {'role': 'assistant', 'content': 'summary'}])
        try:
            assert entered.wait(10), 'synthetic owner did not receive the archive'
            after = pool.submit(store.append_messages_batch, 'owned', [
                {'role': 'assistant', 'content': 'after'}])
            assert not after.done()
            assert calls == [1] and store.journal['pending'][0]['sequence'] == 1
        finally:
            release.set()
        if lost_ack:
            with pytest.raises(TimeoutError, match='slow-owner-lost-ack'):
                archive.result(timeout=10)
            with pytest.raises(WorkerPersistenceError, match='slow-owner-lost-ack'):
                after.result(timeout=10)
        else:
            assert archive.result(timeout=10) == 1
            assert after.result(timeout=10) == 1

    assert calls == ([1] if lost_ack else [1, 2])
    rows = db.get_messages_as_conversation('owned')
    assert [r['content'] for r in rows] == (['summary'] if lost_ack else ['summary', 'after'])
    if lost_ack:
        assert store.failure and len(store.journal['pending']) == 1
    else:
        assert store.failure is None and store.journal['pending'] == []
