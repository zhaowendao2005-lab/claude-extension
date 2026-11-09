import type { Run } from '../core/state';
import type { RunStore } from '../core/controller';

export type RunSummary = {
  id: string;
  ownerSessionId: string;
  status: string;
  updatedAt: number;
  deliverDir: string;
};

/** All reads and writes go to SQLite through the host process API. */
export async function createRunStore(
  $: any,
  project: string,
  pluginRoot: string,
): Promise<RunStore & { list(): Promise<RunSummary[]> }> {
  let python: string[] | undefined;
  for (const candidate of [['python3'], ['python'], ['py', '-3']]) {
    try {
      const result = await $.process.run([
        ...candidate, '-I', '-c',
        'import sys, sqlite3; sys.exit(0 if sys.version_info.major == 3 else 1)',
      ], { timeoutMs: 10000 });
      if (result.exitCode === 0) {
        python = candidate;
        break;
      }
    } catch {
      // Try the next interpreter name, never a different persistence backend.
    }
  }
  if (!python) {
    throw new Error('Budget disabled: Python 3 with sqlite3 is required for durable storage (tried python3, python, py -3).');
  }
  const command = [...python, '-I', `${pluginRoot}/storage/store.py`, '--db', `${project}/.budget/state.sqlite3`];
  async function invoke(action: 'load' | 'save' | 'list', args: string[] = []): Promise<unknown> {
    let result;
    try {
      result = await $.process.run([...command, '--action', action, ...args], { timeoutMs: 10000 });
    } catch {
      throw new Error(`Budget storage ${action} failed: host process unavailable or timed out.`);
    }
    if (result.exitCode !== 0) {
      // Only expose our CLI's short diagnostics, not host output that might contain data.
      const detail = typeof result.stderr === 'string'
        ? result.stderr.trim().split('\n').find((line: string) => line.startsWith('store: '))
        : undefined;
      throw new Error(`Budget storage ${action} failed${detail ? `: ${detail.slice(0, 200)}` : '.'}`);
    }
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error(`Budget storage ${action} returned invalid JSON.`);
    }
  }
  const store: RunStore & { list(): Promise<RunSummary[]> } = {
    async load(id) {
      const value = await invoke('load', ['--id', id]);
      return value === null ? undefined : value as Run;
    },
    async save(run, expectedRevision) {
      if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
        throw new Error('Budget storage save failed: invalid expected revision.');
      }
      await invoke('save', ['--id', run.id, '--expected', expectedRevision === null ? 'new' : String(expectedRevision), '--data', JSON.stringify(run)]);
    },
    async list() {
      return await invoke('list') as RunSummary[];
    },
  };
  // Fail initialization on inaccessible/corrupt storage before enabling the budget.
  await store.list();
  return store;
}
