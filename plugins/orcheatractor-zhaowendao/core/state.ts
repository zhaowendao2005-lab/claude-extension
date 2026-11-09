export type PauseReason = string;
export type Phase = 'pre-explore' | 'explore' | 'implement' | 'verify';
export type Attempt = {
  id: string; taskId: string; ownerSessionId: string; agentId?: string;
  name: string; requestedModel: string; resolvedModel?: string; actualModel?: string;
  status: 'creating' | 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';
  managed: boolean; createdAt: number; updatedAt: number; reason?: string;
};
export type Task = { id: string; label: string; cardPath: string; allowedFiles: string[]; attemptIds: string[] };
export type Run = {
  schemaVersion: 1; revision: number; id: string; project: string; task: string;
  deliverDir: string; createdSessionId: string; ownerSessionId: string;
  status: 'running' | 'paused' | 'interrupted' | 'recovering' | 'verifying' | 'completed' | 'cancelled';
  phase: Phase; budgetMs: number; workMs: number; segmentStart: number | null;
  pauses: Record<string, number>; tasks: Record<string, Task>; attempts: Record<string, Attempt>;
  check: { editRevision: number; passedRevision: number | null; waiver: string | null };
  createdAt: number; updatedAt: number; endedAt: number | null; closeReason: string | null;
  events: Array<{ seq: number; at: number; type: string; detail?: string }>;
  config: { step?: number; cadenceMs?: number; extraMarksMs?: number[] };
  estimates: Record<string, number>;
  firedMarks: string[];
  refs: Array<{ run: string; phrase: string }>;
};
export type CreateRunInput = { id: string; project: string; sessionId: string; task: string; budgetMs: number; now: number; deliverDir: string };
export type Event =
  | { type: 'configure'; config: Run['config']; now: number }
  | { type: 'plan'; estimates: Record<string, number>; now: number }
  | { type: 'mark'; key: string; now: number }
  | { type: 'ref'; run: string; phrase: string; now: number }
  | { type: 'allow-files'; taskId: string; files: string[]; now: number }
  | { type: 'checkpoint'; now: number }
  | { type: 'pause' | 'resume'; reason: PauseReason; now: number }
  | { type: 'phase'; phase: Phase; now: number }
  | { type: 'extend'; ms: number; now: number }
  | { type: 'task-added'; task: Task; now: number }
  | { type: 'attempt-created' | 'attempt-observed'; attempt: Attempt; now: number }
  | { type: 'attempt-reconciled'; attemptId: string; status: 'running'; now: number }
  | { type: 'attempt-started'; attemptId: string; agentId: string; resolvedModel: string; now: number }
  | { type: 'attempt-finished'; agentId: string; outcome: 'completed' | 'failed' | 'interrupted'; reason?: string; actualModel?: string; now: number }
  | { type: 'attempt-unknown'; attemptId: string; reason: string; now: number }
  | { type: 'attempt-model'; agentId: string; actualModel: string; now: number }
  | { type: 'edit'; now: number }
  | { type: 'check'; passed: boolean; now: number; revision?: number }
  | { type: 'waive'; reason: string; now: number }
  | { type: 'interrupt'; reason: string; now: number }
  | { type: 'recover'; sessionId: string; now: number }
  | { type: 'complete' | 'cancel'; now: number; reason: string };

const own = (object: object, key: string) => Object.hasOwn(object, key);
const put = <T>(object: Record<string, T>, key: string, value: T) => {
  Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
};
const terminal = (run: Run) => run.status === 'completed' || run.status === 'cancelled';
const settled = (attempt: Attempt) => attempt.status === 'completed' || attempt.status === 'failed';
function finite(value: number, label: string) {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
}
export function createRun(input: CreateRunInput): Run {
  finite(input.now, 'now'); finite(input.budgetMs, 'budgetMs');
  if (input.budgetMs < 0) throw new Error('budgetMs must be nonnegative');
  return {
    schemaVersion: 1, revision: 0, id: input.id, project: input.project, task: input.task,
    deliverDir: input.deliverDir, createdSessionId: input.sessionId, ownerSessionId: input.sessionId,
    status: 'running', phase: 'pre-explore', budgetMs: input.budgetMs, workMs: 0,
    segmentStart: input.now, pauses: {}, tasks: {}, attempts: {},
    check: { editRevision: 0, passedRevision: null, waiver: null },
    createdAt: input.now, updatedAt: input.now, endedAt: null, closeReason: null,
    events: [{ seq: 0, at: input.now, type: 'created' }],
    config: {}, estimates: {}, firedMarks: [], refs: [],
  };
}
export function elapsed(run: Run, now: number): number {
  finite(now, 'now');
  return run.workMs + (run.segmentStart === null ? 0 : Math.max(0, now - run.segmentStart));
}
export function completionProblems(run: Run): string[] {
  const problems = Object.values(run.attempts)
    .filter(attempt => attempt.managed && !settled(attempt))
    .map(attempt => `Managed attempt ${attempt.id} is ${attempt.status}`);
  for (const task of Object.values(run.tasks)) {
    if (!task.attemptIds.some(id => own(run.attempts, id) && run.attempts[id]!.taskId === task.id && run.attempts[id]!.status === 'completed'))
      problems.push(`Task ${task.id} has no completed attempt`);
  }
  if (run.check.editRevision > 0 && run.check.passedRevision !== run.check.editRevision && !run.check.waiver)
    problems.push(`Verification required for edit revision ${run.check.editRevision}`);
  return problems;
}
/** Attempt counts include unmanaged observations; completion gates only managed attempts. */
export function counts(run: Run): Record<string, number> {
  const result = { tasks: Object.keys(run.tasks).length, attempts: 0, managed: 0,
    creating: 0, running: 0, completed: 0, failed: 0, interrupted: 0, unknown: 0 };
  for (const attempt of Object.values(run.attempts)) {
    result.attempts++; result[attempt.status]++; if (attempt.managed) result.managed++;
  }
  return result;
}
export function reduce(previous: Run, event: Event): Run {
  finite(event.now, 'now');
  if (event.type === 'recover' && event.sessionId !== previous.ownerSessionId)
    throw new Error('Cross-session recovery requires host-confirmed takeover');
  // A closed run cannot resume work, but existing workers may still report facts.
  const workerAudit = ['attempt-finished', 'attempt-model', 'attempt-unknown', 'attempt-reconciled', 'attempt-started'].includes(event.type);
  if (terminal(previous) && !workerAudit) return previous;
  const run = structuredClone(previous);
  const stop = () => { run.workMs = elapsed(run, event.now); run.segmentStart = null; };
  const activeStatus = () => run.phase === 'verify' ? 'verifying' as const : 'running' as const;
  const start = () => {
    if (run.status === 'interrupted' || Object.keys(run.pauses).length) return;
    run.status = activeStatus();
    if (run.segmentStart === null) run.segmentStart = Math.max(event.now, run.updatedAt);
  };
  const attemptById = (id: string) => {
    if (!own(run.attempts, id)) throw new Error(`Unknown attempt ${id}`);
    return run.attempts[id]!;
  };
  switch (event.type) {
    case 'configure': {
      const config = event.config;
      if (config.step !== undefined && (!Number.isFinite(config.step) || config.step <= 0 || config.step > 1)) throw new Error('step must be in (0, 1]');
      if (config.cadenceMs !== undefined && (!Number.isFinite(config.cadenceMs) || config.cadenceMs <= 0)) throw new Error('cadenceMs must be positive');
      if (config.extraMarksMs?.some(ms => !Number.isFinite(ms) || ms < 0)) throw new Error('extraMarksMs must be nonnegative');
      run.config = { ...run.config, ...structuredClone(config) }; break;
    }
    case 'plan':
      if (Object.values(event.estimates).some(value => !Number.isFinite(value) || value < 0)) throw new Error('Estimates must be nonnegative');
      run.estimates = structuredClone(event.estimates); break;
    case 'mark':
      run.firedMarks ??= [];
      if (!run.firedMarks.includes(event.key)) run.firedMarks.push(event.key);
      break;
    case 'ref': (run.refs ??= []).push({ run: event.run, phrase: event.phrase }); break;
    case 'allow-files':
      if (!own(run.tasks, event.taskId)) throw new Error(`Unknown task ${event.taskId}`);
      run.tasks[event.taskId]!.allowedFiles = [...new Set([...run.tasks[event.taskId]!.allowedFiles, ...event.files])]; break;
    case 'checkpoint':
      if (run.segmentStart !== null) {
        const previousStart = run.segmentStart;
        stop(); run.segmentStart = Math.max(previousStart, event.now);
      }
      break;
    case 'pause':
      stop(); put(run.pauses, event.reason, (own(run.pauses, event.reason) ? run.pauses[event.reason]! : 0) + 1);
      if (run.status !== 'interrupted') run.status = 'paused';
      break;
    case 'resume':
      if (own(run.pauses, event.reason)) {
        const remaining = run.pauses[event.reason]! - 1;
        if (remaining <= 0) delete run.pauses[event.reason];
        else run.pauses[event.reason] = remaining;
      }
      start(); break;
    case 'phase': run.phase = event.phase; if (run.segmentStart !== null) run.status = activeStatus(); break;
    case 'extend':
      finite(event.ms, 'ms');
      if (event.ms <= 0 || !Number.isFinite(run.budgetMs + event.ms)) throw new Error('Extension must be positive and finite');
      run.budgetMs += event.ms; break;
    case 'task-added':
      if (own(run.tasks, event.task.id)) throw new Error(`Duplicate task ${event.task.id}`);
      if (event.task.attemptIds.length) throw new Error('New tasks must have no attempts');
      for (const task of Object.values(run.tasks)) {
        if (task.label === event.task.label) throw new Error(`Duplicate task label ${event.task.label}`);
        const attempts = Object.values(run.attempts).filter(attempt => attempt.taskId === task.id);
        if (!attempts.length || attempts.some(attempt => !settled(attempt))) {
          const overlap = event.task.allowedFiles.find(file => task.allowedFiles.includes(file));
          if (overlap !== undefined) throw new Error(`File ${overlap} overlaps unfinished task ${task.id}`);
        }
      }
      put(run.tasks, event.task.id, structuredClone(event.task)); break;
    case 'attempt-created': {
      const attempt = event.attempt;
      if (!own(run.tasks, attempt.taskId)) throw new Error(`Unknown task ${attempt.taskId}`);
      if (own(run.attempts, attempt.id)) throw new Error(`Duplicate attempt ${attempt.id}`);
      if (Object.values(run.attempts).some(existing => existing.taskId === attempt.taskId && !settled(existing)))
        throw new Error(`Task ${attempt.taskId} already has an unsettled attempt; refusing blind retry`);
      if (attempt.ownerSessionId !== run.ownerSessionId) throw new Error('Attempt owner does not match run owner');
      if (attempt.agentId && Object.values(run.attempts).some(a => a.agentId === attempt.agentId)) throw new Error('Duplicate agent ID');
      put(run.attempts, attempt.id, structuredClone(attempt)); run.tasks[attempt.taskId]!.attemptIds.push(attempt.id); break;
    }
    case 'attempt-observed': {
      const attempt = event.attempt;
      if (attempt.managed || attempt.taskId) throw new Error('Observed attempt must be unmanaged and have no task');
      if (attempt.ownerSessionId !== run.ownerSessionId) throw new Error('Attempt owner does not match run owner');
      if (own(run.attempts, attempt.id) || (attempt.agentId && Object.values(run.attempts).some(a => a.agentId === attempt.agentId))) break;
      put(run.attempts, attempt.id, structuredClone(attempt)); break;
    }
    case 'attempt-reconciled': {
      const attempt = attemptById(event.attemptId);
      if (settled(attempt)) break;
      if (!attempt.agentId) throw new Error('Reconciliation requires a bound agent');
      attempt.status = event.status; attempt.updatedAt = event.now; delete attempt.reason; break;
    }
    case 'attempt-started': {
      const attempt = attemptById(event.attemptId);
      const bindingUnknown = attempt.status === 'unknown' && !attempt.agentId;
      if (attempt.status !== 'creating' && attempt.status !== 'running' && !bindingUnknown) break;
      if (attempt.agentId && attempt.agentId !== event.agentId) throw new Error('Attempt already bound to another agent');
      if (Object.values(run.attempts).some(a => a.id !== attempt.id && a.agentId === event.agentId)) throw new Error('Duplicate agent ID');
      Object.assign(attempt, { status: bindingUnknown ? 'unknown' : 'running', agentId: event.agentId, resolvedModel: event.resolvedModel, updatedAt: event.now }); break;
    }
    case 'attempt-finished': {
      const attempt = Object.values(run.attempts).find(a => a.agentId === event.agentId);
      if (!attempt) return previous;
      if (!settled(attempt)) {
        attempt.status = event.outcome;
        if (event.reason !== undefined) attempt.reason = event.reason;
      }
      attempt.updatedAt = Math.max(attempt.updatedAt, event.now);
      if (event.actualModel !== undefined) attempt.actualModel = event.actualModel;
      break;
    }
    case 'attempt-model': {
      const attempt = Object.values(run.attempts).find(a => a.agentId === event.agentId);
      if (!attempt) return previous;
      attempt.actualModel = event.actualModel;
      attempt.updatedAt = Math.max(attempt.updatedAt, event.now); break;
    }
    case 'attempt-unknown': {
      const attempt = attemptById(event.attemptId);
      if (!settled(attempt)) Object.assign(attempt, { status: 'unknown', reason: event.reason, updatedAt: event.now });
      break;
    }
    case 'edit': run.check = { editRevision: run.revision + 1, passedRevision: null, waiver: null }; break;
    case 'check':
      if ((event.revision ?? run.check.editRevision) === run.check.editRevision)
        run.check.passedRevision = event.passed ? run.check.editRevision : null;
      break;
    case 'waive':
      if (!event.reason.trim()) throw new Error('Waiver requires a reason');
      run.check.waiver = event.reason; break;
    case 'interrupt':
      stop(); run.status = 'interrupted';
      for (const attempt of Object.values(run.attempts)) {
        if (attempt.managed && !settled(attempt) && attempt.status !== 'unknown') {
          attempt.status = attempt.agentId ? 'interrupted' : 'unknown';
          attempt.reason = event.reason; attempt.updatedAt = event.now;
        }
      }
      break;
    case 'recover':
      if (run.status === 'interrupted' || run.status === 'recovering') {
        run.status = Object.keys(run.pauses).length ? 'paused' : activeStatus(); start();
      }
      break;
    case 'complete': {
      const problems = completionProblems(run);
      if (problems.length) throw new Error(problems.join('; '));
      stop(); run.status = 'completed'; run.endedAt = event.now; run.closeReason = event.reason; break;
    }
    case 'cancel': stop(); run.status = 'cancelled'; run.endedAt = event.now; run.closeReason = event.reason; break;
    default: throw new Error(`Unsupported event ${(event as { type: string }).type}`);
  }
  run.revision++; run.updatedAt = Math.max(run.updatedAt, event.now);
  const entry: Run['events'][number] = { seq: run.revision, at: event.now, type: event.type };
  const detail: Record<string, string | number | boolean> = {};
  if ('reason' in event && event.reason !== undefined) detail.reason = event.reason;
  if ('attemptId' in event) detail.attemptId = event.attemptId;
  if ('agentId' in event) detail.agentId = event.agentId;
  if ('taskId' in event) detail.taskId = event.taskId;
  if ('task' in event) detail.taskId = event.task.id;
  if ('attempt' in event) {
    detail.attemptId = event.attempt.id;
    detail.taskId = event.attempt.taskId;
    if (event.attempt.agentId) detail.agentId = event.attempt.agentId;
  }
  if ('phase' in event) detail.phase = event.phase;
  if ('key' in event) detail.key = event.key;
  if ('outcome' in event) detail.outcome = event.outcome;
  if ('status' in event) detail.status = event.status;
  if (event.type === 'check') {
    detail.passed = event.passed;
    detail.revision = event.revision ?? run.check.editRevision;
  }
  if (Object.keys(detail).length) entry.detail = JSON.stringify(detail);
  run.events.push(entry); run.events = run.events.slice(-500);
  return run;
}
