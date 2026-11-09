import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, reduce, elapsed, completionProblems, counts } from '../core/state.ts';
import { RunController } from '../core/controller.ts';

const input = (id = 'run') => ({ id, project: 'demo', sessionId: 'owner', task: 'build', budgetMs: 1000, now: 100, deliverDir: '/tmp/delivery' });
const fresh = () => createRun(input());
const task = { id: 't', label: 'task', cardPath: '/tmp/card', allowedFiles: ['file.ts'], attemptIds: [] };
function withAttempt(options = {}) {
  let run = reduce(fresh(), { type: 'task-added', task, now: 101 });
  return reduce(run, { type: 'attempt-created', now: 102, attempt: {
    id: 'a', taskId: 't', ownerSessionId: 'owner', name: 'worker', requestedModel: 'requested',
    status: 'creating', managed: true, createdAt: 102, updatedAt: 102, ...options,
  } });
}
function started() {
  return reduce(withAttempt(), { type: 'attempt-started', attemptId: 'a', agentId: 'agent', resolvedModel: 'resolved', now: 110 });
}
class MemoryStore {
  runs = new Map();
  writes = [];
  failNext = false;
  async load(id) { return structuredClone(this.runs.get(id)); }
  async save(run, expectedRevision) {
    await Promise.resolve();
    if (this.failNext) { this.failNext = false; throw new Error('save failed'); }
    assert.equal(this.runs.get(run.id)?.revision ?? null, expectedRevision, 'CAS mismatch');
    this.writes.push(expectedRevision);
    this.runs.set(run.id, structuredClone(run));
  }
}

test('creation and negative clock delta', () => {
  const run = fresh();
  assert.equal(run.schemaVersion, 1);
  assert.equal(run.phase, 'pre-explore');
  assert.equal(elapsed(run, 90), 0);
  assert.equal(elapsed(run, 150), 50);
  assert.throws(() => createRun({ ...input(), budgetMs: -1 }));
});

test('multiple and nested pauses require all reasons to clear', () => {
  let run = reduce(fresh(), { type: 'pause', reason: 'user', now: 120 });
  run = reduce(run, { type: 'pause', reason: 'user', now: 130 });
  run = reduce(run, { type: 'pause', reason: 'permission', now: 140 });
  assert.equal(elapsed(run, 900), 20);
  run = reduce(run, { type: 'resume', reason: 'user', now: 150 });
  run = reduce(run, { type: 'resume', reason: 'permission', now: 160 });
  assert.equal(run.status, 'paused');
  run = reduce(run, { type: 'resume', reason: 'user', now: 170 });
  assert.equal(run.status, 'running');
  assert.equal(elapsed(run, 180), 30);
});

test('late completion never unpauses and settled attempts never restart', () => {
  let run = reduce(started(), { type: 'pause', reason: 'permission', now: 120 });
  run = reduce(run, { type: 'attempt-finished', agentId: 'agent', outcome: 'completed', actualModel: 'actual', now: 130 });
  assert.equal(run.status, 'paused');
  assert.equal(elapsed(run, 1000), 20);
  run = reduce(run, { type: 'attempt-started', attemptId: 'a', agentId: 'agent', resolvedModel: 'other', now: 140 });
  assert.equal(run.attempts.a.status, 'completed');
  assert.equal(run.attempts.a.actualModel, 'actual');
  assert.equal(run.attempts.a.resolvedModel, 'resolved');
  let failed = reduce(started(), { type: 'attempt-finished', agentId: 'agent', outcome: 'failed', now: 120 });
  failed = reduce(failed, { type: 'attempt-started', attemptId: 'a', agentId: 'agent', resolvedModel: 'other', now: 130 });
  assert.equal(failed.attempts.a.status, 'failed');
});

test('verification is edit revision scoped and stale success or failure cannot overwrite it', () => {
  let run = reduce(fresh(), { type: 'edit', now: 110 });
  const old = run.check.editRevision;
  run = reduce(run, { type: 'waive', reason: 'reviewed manually', now: 120 });
  assert.deepEqual(completionProblems(run), []);
  run = reduce(run, { type: 'edit', now: 130 });
  assert.equal(run.check.waiver, null);
  assert.ok(completionProblems(run).length);
  run = reduce(run, { type: 'check', passed: true, revision: old, now: 140 });
  assert.ok(completionProblems(run).length);
  run = reduce(run, { type: 'check', passed: true, revision: run.check.editRevision, now: 150 });
  run = reduce(run, { type: 'check', passed: false, revision: old, now: 160 });
  assert.deepEqual(completionProblems(run), []);
  run = reduce(run, { type: 'edit', now: 170 });
  assert.equal(run.check.passedRevision, null);
  assert.throws(() => reduce(run, { type: 'complete', now: 180, reason: 'done' }), /Verification/);
});

test('all unsettled managed statuses block complete, unmanaged do not', () => {
  for (const status of ['creating', 'running', 'unknown', 'interrupted']) {
    const run = withAttempt({ status });
    assert.equal(completionProblems(run).length, 2);
    assert.throws(() => reduce(run, { type: 'complete', now: 200, reason: 'done' }));
    assert.equal(reduce(run, { type: 'cancel', now: 200, reason: 'stop' }).status, 'cancelled');
  }
  assert.deepEqual(completionProblems(withAttempt({ status: 'completed' })), []);
  assert.match(completionProblems(withAttempt({ status: 'failed' }))[0], /no completed attempt/);
  assert.equal(completionProblems(withAttempt({ managed: false })).length, 1);
  const observed = fresh();
  observed.attempts.observed = { ...withAttempt().attempts.a, id: 'observed', taskId: '', managed: false };
  assert.deepEqual(completionProblems(observed), []);
});

test('complete and cancel are irreversible with fixed elapsed time', () => {
  for (const type of ['complete', 'cancel']) {
    const run = reduce(fresh(), { type, now: 150, reason: 'closed' });
    assert.equal(elapsed(run, 10000), 50);
    assert.equal(run.endedAt, 150);
    for (const event of [
      { type: 'resume', reason: 'user', now: 160 },
      { type: 'recover', sessionId: 'owner', now: 160 },
      { type: 'edit', now: 160 },
      { type: 'attempt-finished', agentId: 'agent', outcome: 'completed', now: 160 },
    ]) assert.strictEqual(reduce(run, event), run);
  }
});

test('interrupt preserves uncertainty, recovery cannot transfer session ownership', () => {
  let run = reduce(started(), { type: 'interrupt', reason: 'shutdown', now: 130 });
  assert.equal(run.status, 'interrupted');
  assert.equal(run.attempts.a.status, 'interrupted');
  assert.equal(elapsed(run, 1000), 30);
  assert.throws(() => reduce(run, { type: 'recover', sessionId: 'intruder', now: 140 }), /Cross-session/);
  run = reduce(run, { type: 'recover', sessionId: 'owner', now: 150 });
  assert.equal(run.status, 'running');
  assert.equal(run.attempts.a.status, 'interrupted');
  assert.equal(elapsed(run, 160), 40);
  assert.equal(completionProblems(run).length, 2);
  run = reduce(run, { type: 'attempt-finished', agentId: 'agent', outcome: 'completed', now: 170 });
  assert.deepEqual(completionProblems(run), []);
  let unknown = reduce(withAttempt(), { type: 'interrupt', reason: 'lost', now: 130 });
  assert.equal(unknown.attempts.a.status, 'unknown');
  unknown = reduce(unknown, { type: 'recover', sessionId: 'owner', now: 150 });
  assert.equal(unknown.attempts.a.status, 'unknown');
  assert.deepEqual(unknown.tasks.t.attemptIds, ['a']);
});

test('explicit unknown and pauses survive recovery', () => {
  let run = reduce(started(), { type: 'attempt-unknown', attemptId: 'a', reason: 'lost contact', now: 115 });
  run = reduce(run, { type: 'pause', reason: 'user', now: 120 });
  run = reduce(run, { type: 'interrupt', reason: 'exit', now: 130 });
  run = reduce(run, { type: 'recover', sessionId: 'owner', now: 140 });
  assert.equal(run.status, 'paused');
  assert.equal(run.attempts.a.status, 'unknown');
  assert.equal(elapsed(run, 1000), 20);
});

test('pure reducer, phase, budget, counts, safe arbitrary map keys and bounded audit log', () => {
  const original = fresh();
  let run = reduce(original, { type: 'phase', phase: 'verify', now: 110 });
  assert.equal(run.status, 'verifying');
  assert.equal(original.phase, 'pre-explore');
  run = reduce(run, { type: 'extend', ms: 100, now: 120 });
  assert.equal(run.budgetMs, 1100);
  run = reduce(run, { type: 'pause', reason: '__proto__', now: 130 });
  assert.equal(run.pauses.__proto__, 1);
  run = reduce(run, { type: 'resume', reason: '__proto__', now: 140 });
  assert.equal(run.status, 'verifying');
  for (let i = 0; i < 600; i++) run = reduce(run, { type: 'extend', ms: 1, now: 150 + i });
  assert.equal(run.events.length, 500);
  assert.equal(run.events.at(-1).seq, run.revision);
  assert.equal(counts(started()).running, 1);
  assert.equal(counts(started()).tasks, 1);
});

test('controller serializes concurrent dispatches using CAS and isolates returned data', async () => {
  const store = new MemoryStore();
  const controller = new RunController(store);
  const creating = controller.create(input());
  const updates = Array.from({ length: 50 }, (_, i) => controller.dispatch('run', { type: 'extend', ms: 1, now: 101 + i }));
  await creating;
  await Promise.all(updates);
  const run = await controller.get('run');
  assert.equal(run.revision, 50);
  assert.equal(run.budgetMs, 1050);
  assert.deepEqual(store.writes, [null, ...Array.from({ length: 50 }, (_, i) => i)]);
  run.budgetMs = -1;
  assert.equal((await controller.get('run')).budgetMs, 1050);
});

test('controller queue survives reducer and storage failures', async () => {
  const store = new MemoryStore();
  const controller = new RunController(store);
  await controller.create(input());
  await assert.rejects(controller.create(input()), /already exists/);
  await assert.rejects(controller.dispatch('run', { type: 'extend', ms: -1, now: 110 }));
  store.failNext = true;
  await assert.rejects(controller.dispatch('run', { type: 'extend', ms: 1, now: 120 }), /save failed/);
  assert.equal((await controller.dispatch('run', { type: 'extend', ms: 1, now: 130 })).revision, 1);
  assert.equal(await controller.get('missing'), undefined);
  await assert.rejects(controller.dispatch('missing', { type: 'edit', now: 140 }), /Unknown run/);
});

test('independent runs are not blocked by another run queue', async () => {
  const store = new MemoryStore();
  const controller = new RunController(store);
  await controller.create(input('a'));
  await controller.create(input('b'));
  const load = store.load.bind(store);
  let unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  store.load = async id => { if (id === 'a') await gate; return load(id); };
  const waiting = controller.dispatch('a', { type: 'extend', ms: 1, now: 110 });
  try {
    assert.equal((await controller.dispatch('b', { type: 'extend', ms: 1, now: 110 })).revision, 1);
  } finally { unblock(); }
  await waiting;
});

test('task completion requires a successful attempt, including after failures', () => {
  const empty = reduce(fresh(), { type: 'task-added', task, now: 101 });
  assert.throws(() => reduce(empty, { type: 'complete', now: 120, reason: 'done' }), /no completed attempt/);
  let run = withAttempt({ status: 'failed' });
  assert.throws(() => reduce(run, { type: 'complete', now: 120, reason: 'done' }), /no completed attempt/);
  run = reduce(run, { type: 'attempt-created', now: 130, attempt: { ...run.attempts.a, id: 'retry', status: 'completed' } });
  assert.deepEqual(completionProblems(run), []);
  assert.equal(reduce(run, { type: 'complete', now: 140, reason: 'done' }).status, 'completed');
});

test('unknown intent can bind then reconcile without reviving settled attempts', () => {
  let run = withAttempt({ status: 'unknown' });
  run = reduce(run, { type: 'attempt-started', attemptId: 'a', agentId: 'found', resolvedModel: 'resolved', now: 120 });
  assert.equal(run.attempts.a.agentId, 'found');
  assert.equal(run.attempts.a.status, 'unknown');
  run = reduce(run, { type: 'attempt-reconciled', attemptId: 'a', status: 'running', now: 130 });
  assert.equal(run.attempts.a.status, 'running');
  run = reduce(run, { type: 'attempt-finished', agentId: 'found', outcome: 'failed', now: 140 });
  run = reduce(run, { type: 'attempt-reconciled', attemptId: 'a', status: 'running', now: 150 });
  assert.equal(run.attempts.a.status, 'failed');
});

test('observed agents without tasks do not gate completion or duplicate managed identities', () => {
  const attempt = { ...withAttempt().attempts.a, id: 'observed', taskId: '', managed: false, agentId: 'observed-agent', status: 'running' };
  let run = reduce(fresh(), { type: 'attempt-observed', attempt, now: 110 });
  assert.deepEqual(completionProblems(run), []);
  run = reduce(run, { type: 'attempt-observed', attempt: { ...attempt, id: 'duplicate' }, now: 120 });
  assert.equal(Object.keys(run.attempts).length, 1);
  assert.equal(reduce(run, { type: 'complete', reason: 'done', now: 130 }).status, 'completed');
  assert.throws(() => reduce(fresh(), { type: 'attempt-observed', attempt: { ...attempt, managed: true }, now: 110 }));
});

test('integration configuration, estimates, file contracts, references, marks and checkpoint', () => {
  let run = withAttempt();
  run = reduce(run, { type: 'configure', config: { step: 0.2, cadenceMs: 200, extraMarksMs: [500] }, now: 110 });
  run = reduce(run, { type: 'plan', estimates: { explore: 20, implement: 30 }, now: 120 });
  run = reduce(run, { type: 'allow-files', taskId: 't', files: ['extra.ts', 'file.ts'], now: 130 });
  run = reduce(run, { type: 'ref', run: 'previous', phrase: 'reuse finding', now: 140 });
  run = reduce(run, { type: 'mark', key: 'interval:1', now: 150 });
  run = reduce(run, { type: 'mark', key: 'interval:1', now: 151 });
  run = reduce(run, { type: 'checkpoint', now: 160 });
  assert.equal(run.workMs, 60);
  assert.equal(elapsed(run, 170), 70);
  assert.deepEqual(run.firedMarks, ['interval:1']);
  assert.deepEqual(run.refs, [{ run: 'previous', phrase: 'reuse finding' }]);
  assert.deepEqual(run.tasks.t.allowedFiles, ['file.ts', 'extra.ts']);
  assert.equal(run.estimates.implement, 30);
  assert.equal(run.config.cadenceMs, 200);
  run = reduce(run, { type: 'checkpoint', now: 155 });
  assert.equal(elapsed(run, 170), 70);
  run = reduce(run, { type: 'pause', reason: 'user', now: 170 });
  run = reduce(run, { type: 'checkpoint', now: 180 });
  assert.equal(elapsed(run, 1000), 70);
  assert.throws(() => reduce(run, { type: 'configure', config: { step: 0 }, now: 190 }));
});

test('audit details identify entities and outcomes without embedding task or run content', () => {
  let run = withAttempt();
  assert.deepEqual(JSON.parse(run.events.at(-2).detail), { taskId: 't' });
  assert.deepEqual(JSON.parse(run.events.at(-1).detail), { attemptId: 'a', taskId: 't' });
  run = reduce(run, { type: 'attempt-started', attemptId: 'a', agentId: 'host-a', resolvedModel: 'resolved', now: 110 });
  assert.deepEqual(JSON.parse(run.events.at(-1).detail), { attemptId: 'a', agentId: 'host-a' });
  run = reduce(run, { type: 'attempt-finished', agentId: 'host-a', outcome: 'completed', reason: 'host confirmed', now: 120 });
  assert.deepEqual(JSON.parse(run.events.at(-1).detail), { reason: 'host confirmed', agentId: 'host-a', outcome: 'completed' });
  run = reduce(run, { type: 'phase', phase: 'verify', now: 130 });
  assert.deepEqual(JSON.parse(run.events.at(-1).detail), { phase: 'verify' });
  run = reduce(run, { type: 'mark', key: 'overdue', now: 140 });
  assert.deepEqual(JSON.parse(run.events.at(-1).detail), { key: 'overdue' });
  const audit = JSON.stringify(run.events);
  assert.ok(!audit.includes(task.cardPath));
  assert.ok(!audit.includes('allowedFiles'));
  assert.ok(!audit.includes('requestedModel'));
});

test('task labels are unique and unfinished tasks reserve exact allowed file paths', () => {
  const empty = reduce(fresh(), { type: 'task-added', task, now: 110 });
  const adding = (run, overrides = {}) => reduce(run, { type: 'task-added', task: { ...task, id: 'other', label: 'other', ...overrides }, now: 120 });
  assert.throws(() => adding(empty, { label: task.label, allowedFiles: ['different.ts'] }), /Duplicate task label/);
  assert.throws(() => adding(empty), /overlaps unfinished task/);
  for (const status of ['creating', 'running', 'unknown', 'interrupted']) {
    assert.throws(() => adding(withAttempt({ status })), /overlaps unfinished task/);
  }
  for (const status of ['completed', 'failed']) {
    const run = withAttempt({ status });
    assert.ok(adding(run).tasks.other);
    assert.throws(() => adding(run, { label: task.label }), /Duplicate task label/);
  }
  assert.ok(adding(empty, { allowedFiles: ['file.ts.child'] }).tasks.other);
});

test('attempt creation refuses blind retries until the prior attempt settles', () => {
  for (const status of ['creating', 'running', 'unknown', 'interrupted']) {
    const run = withAttempt({ status });
    assert.throws(() => reduce(run, { type: 'attempt-created', attempt: { ...run.attempts.a, id: 'retry' }, now: 120 }), /refusing blind retry/);
    assert.deepEqual(run.tasks.t.attemptIds, ['a']);
  }
  for (const status of ['completed', 'failed']) {
    const run = withAttempt({ status });
    const next = reduce(run, { type: 'attempt-created', attempt: { ...run.attempts.a, id: 'retry', status: 'creating' }, now: 120 });
    assert.deepEqual(next.tasks.t.attemptIds, ['a', 'retry']);
  }
});

test('concurrent conflicting dispatches enforce domain constraints in the reducer', async () => {
  const controller = new RunController(new MemoryStore());
  await controller.create(input());
  const additions = await Promise.allSettled([
    controller.dispatch('run', { type: 'task-added', task, now: 110 }),
    controller.dispatch('run', { type: 'task-added', task: { ...task, id: 'other', label: 'other' }, now: 110 }),
  ]);
  assert.deepEqual(additions.map(result => result.status), ['fulfilled', 'rejected']);
  const attempt = withAttempt().attempts.a;
  const spawns = await Promise.allSettled([
    controller.dispatch('run', { type: 'attempt-created', attempt, now: 120 }),
    controller.dispatch('run', { type: 'attempt-created', attempt: { ...attempt, id: 'retry' }, now: 120 }),
  ]);
  assert.deepEqual(spawns.map(result => result.status), ['fulfilled', 'rejected']);
  const run = await controller.get('run');
  assert.equal(run.revision, 2);
  assert.deepEqual(Object.keys(run.tasks), ['t']);
  assert.deepEqual(run.tasks.t.attemptIds, ['a']);
});

test('cancelled runs retain live workers and accept cleanup facts without reviving the run', () => {
  let run = reduce(started(), { type: 'cancel', reason: 'user cancelled', now: 120 });
  const closed = { status: run.status, workMs: run.workMs, segmentStart: run.segmentStart, endedAt: run.endedAt, closeReason: run.closeReason };
  assert.equal(run.attempts.a.status, 'running');
  for (const event of [
    { type: 'attempt-unknown', attemptId: 'a', reason: 'not visible', now: 130 },
    { type: 'attempt-reconciled', attemptId: 'a', status: 'running', now: 140 },
    { type: 'attempt-model', agentId: 'agent', actualModel: 'observed-model', now: 150 },
    { type: 'attempt-finished', agentId: 'agent', outcome: 'completed', actualModel: 'final-model', now: 160 },
  ]) {
    const revision = run.revision;
    run = reduce(run, event);
    assert.equal(run.revision, revision + 1);
    for (const [key, value] of Object.entries(closed)) assert.equal(run[key], value);
    assert.equal(elapsed(run, 1000), 20);
  }
  assert.equal(run.attempts.a.status, 'completed');
  assert.equal(run.attempts.a.actualModel, 'final-model');
  for (const event of [
    { type: 'resume', reason: 'idle', now: 170 },
    { type: 'recover', sessionId: 'owner', now: 170 },
    { type: 'attempt-created', attempt: { ...run.attempts.a, id: 'new' }, now: 170 },
  ]) assert.strictEqual(reduce(run, event), run);
});

test('closed runs can enrich settled worker models without changing outcome', () => {
  let run = reduce(started(), { type: 'attempt-finished', agentId: 'agent', outcome: 'completed', now: 120 });
  run = reduce(run, { type: 'complete', reason: 'done', now: 130 });
  run = reduce(run, { type: 'attempt-finished', agentId: 'agent', outcome: 'failed', actualModel: 'late-model', now: 140 });
  assert.equal(run.attempts.a.status, 'completed');
  assert.equal(run.attempts.a.actualModel, 'late-model');
  assert.equal(run.status, 'completed');
  assert.equal(run.endedAt, 130);
  assert.equal(elapsed(run, 1000), 30);
});

test('cancelled creating intent can bind to its late worker without creating another attempt', () => {
  let run = reduce(withAttempt(), { type: 'cancel', reason: 'cancel', now: 120 });
  run = reduce(run, { type: 'attempt-started', attemptId: 'a', agentId: 'late', resolvedModel: 'model', now: 130 });
  assert.equal(run.status, 'cancelled');
  assert.equal(run.attempts.a.agentId, 'late');
  run = reduce(run, { type: 'attempt-finished', agentId: 'late', outcome: 'failed', reason: 'stop confirmed', now: 140 });
  assert.equal(run.attempts.a.status, 'failed');
  assert.equal(run.endedAt, 120);
  assert.equal(elapsed(run, 1000), 20);
});
