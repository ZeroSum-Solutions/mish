import { sessionModelChoicesEqual, type PutSessionModel, type SessionModelChoice, type SessionModelSnapshot } from '@mish/contracts';
export interface SessionModelApi {
  get(id: string): Promise<SessionModelSnapshot>;
  put(id: string, input: PutSessionModel): Promise<SessionModelSnapshot>;
}
export interface SessionModelState {
  choice: SessionModelChoice | null;
  snapshot: SessionModelSnapshot | null;
  status: 'loading' | 'ready' | 'saving' | 'conflict' | 'error';
  error: unknown;
}
/** Serializes this conversation's next-turn edits, separate from admitted runs. */
export class SessionModelController {
  state: SessionModelState;
  private listeners = new Set<() => void>();
  private loading: Promise<void> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private edited = false;
  private conflictEpoch = 0;
  private invalidSelection: unknown;
  constructor(readonly sessionId: string, initial: SessionModelChoice | null, private api: SessionModelApi, private recoveredRevision?: number, private recoveredFailure = false) {
    this.edited = recoveredRevision !== undefined;
    this.state = { choice: initial, snapshot: null, status: 'loading', error: null };
  }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = (): SessionModelState => this.state;
  private publish(patch: Partial<SessionModelState>): void {
    // An older request may update the authorized snapshot, but cannot clear a newer rejection.
    this.state = { ...this.state, ...patch, ...(this.invalidSelection !== undefined ? { status: 'error' as const, error: this.invalidSelection } : {}) }; this.listeners.forEach(listener => listener());
  }
  private assertValidSelection(): void {
    if (this.invalidSelection !== undefined) throw this.invalidSelection;
  }
  load(): Promise<void> {
    return this.loading ??= this.api.get(this.sessionId).then(snapshot => {
      const conflict = this.recoveredRevision !== undefined && this.recoveredRevision !== snapshot.revision && !sessionModelChoicesEqual(this.state.choice, snapshot.choice);
      this.publish({ snapshot, ...(!this.edited && snapshot.choice ? { choice: snapshot.choice } : {}), status: conflict ? 'conflict' : this.recoveredFailure ? 'error' : 'ready', error: this.recoveredFailure ? new Error('session-model-save-failed') : null });
      this.recoveredRevision = undefined; this.recoveredFailure = false;
    }).catch(error => { this.loading = undefined; this.publish({ status: 'error', error }); throw error; });
  }
  select(choice: SessionModelChoice): Promise<SessionModelSnapshot> {
    this.invalidSelection = undefined;
    this.edited = true;
    this.publish({ choice });
    return this.enqueue(choice);
  }
  private enqueue(choice: SessionModelChoice): Promise<SessionModelSnapshot> {
    const epoch = this.conflictEpoch;
    const pending = this.queue.catch(() => undefined).then(() => {
      if (epoch !== this.conflictEpoch) throw new Error('session-model-conflict');
      return this.save(choice);
    });
    this.queue = pending; return pending;
  }
  private async save(choice: SessionModelChoice): Promise<SessionModelSnapshot> {
    await this.load();
    this.assertValidSelection();
    this.publish({ status: 'saving', error: null });
    try {
      const snapshot = await this.api.put(this.sessionId, { ...choice, expectedRevision: this.state.snapshot!.revision });
      this.publish({ snapshot, status: 'ready', error: null });
      this.assertValidSelection();
      return snapshot;
    } catch (error) {
      if (error && typeof error === 'object' && 'status' in error && error.status === 409) {
        // GET rechecks project authority; no guessed error envelope or unsafe snapshot.
        try { this.publish({ snapshot: await this.api.get(this.sessionId) }); } catch { /* Keep the last authorized snapshot. */ }
        this.conflictEpoch += 1;
        this.publish({ status: 'conflict', error });
      } else this.publish({ status: 'error', error });
      this.assertValidSelection();
      throw error;
    }
  }
  rejectSelection(error: unknown): void { this.invalidSelection = error; this.publish({ status: 'error', error }); }
  retry(): Promise<SessionModelSnapshot> {
    if (this.invalidSelection !== undefined) return Promise.reject(this.invalidSelection);
    if (!this.state.choice) return Promise.reject(new Error('session-model-agent-required'));
    return this.enqueue(this.state.choice);
  }
  async ensureSaved(): Promise<SessionModelSnapshot> {
    this.assertValidSelection();
    await this.queue.catch(() => undefined);
    this.assertValidSelection();
    await this.load();
    this.assertValidSelection();
    if (this.state.status === 'conflict') throw new Error('session-model-conflict');
    const { choice, snapshot } = this.state;
    if (!choice) throw new Error('session-model-agent-required');
    // rev0/null must PUT the complete displayed pair before consuming send.
    if (this.state.status === 'ready' && snapshot?.choice && sessionModelChoicesEqual(choice, snapshot.choice)) return snapshot;
    const saved = await this.enqueue(choice);
    this.assertValidSelection();
    return saved;
  }
}
