import { createRun, reduce } from './state.ts';
import type { CreateRunInput, Event, Run } from './state.ts';

export interface RunStore {
  load(id: string): Promise<Run | undefined>;
  /** Atomically insert when expectedRevision is null, otherwise compare and swap. */
  save(run: Run, expectedRevision: number | null): Promise<void>;
}

export class RunController {
  private readonly store: RunStore;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(store: RunStore) { this.store = store; }

  private serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(id) ?? Promise.resolve()).then(operation);
    const tail = result.then(() => {}, () => {});
    this.queues.set(id, tail);
    void tail.then(() => { if (this.queues.get(id) === tail) this.queues.delete(id); });
    return result;
  }

  create(input: CreateRunInput): Promise<Run> {
    const snapshot = structuredClone(input);
    return this.serial(snapshot.id, async () => {
      if (await this.store.load(snapshot.id)) throw new Error(`Run already exists: ${snapshot.id}`);
      const run = createRun(snapshot);
      await this.store.save(structuredClone(run), null);
      return run;
    });
  }

  get(id: string): Promise<Run | undefined> {
    return this.serial(id, async () => {
      const run = await this.store.load(id);
      return run === undefined ? undefined : structuredClone(run);
    });
  }

  dispatch(id: string, event: Event): Promise<Run> {
    const snapshot = structuredClone(event);
    return this.serial(id, async () => {
      const previous = await this.store.load(id);
      if (!previous) throw new Error(`Unknown run: ${id}`);
      const run = reduce(previous, snapshot);
      if (run !== previous) await this.store.save(structuredClone(run), previous.revision);
      return structuredClone(run);
    });
  }
}
