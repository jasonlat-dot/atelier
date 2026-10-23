import { SessionError } from '../auth/sessionApi';
import { projectApi, type Graph, type Project } from './projectApi';
import type { EditorStore } from './editorStore';
export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';
/** One writer per editor; an acknowledgement never replaces edits made during the request. */
export class ProjectSaver {
  revision: number;
  private savedSequence: number;
  private pending?: Promise<void>;
  private blocked = false;
  private channel?: BroadcastChannel;
  constructor(
    private id: string,
    private csrf: string,
    private store: EditorStore,
    private notify: (status: SaveStatus, error?: unknown) => void,
    private received: (project: Project) => void,
  ) {
    this.revision = 0;
    this.savedSequence = store.getState().sequence;
    if ('BroadcastChannel' in window)
      this.channel = new BroadcastChannel(`atelier-project-${id}`);
    if (this.channel)
      this.channel.onmessage = (event: MessageEvent<unknown>) => {
        if (typeof event.data === 'number' && event.data > this.revision) {
          this.blocked = true;
          this.notify('conflict');
        }
      };
  }
  initialize(revision: number) {
    this.revision = revision;
    this.savedSequence = this.store.getState().sequence;
    this.blocked = false;
    this.notify('saved');
  }
  dirty() {
    return this.savedSequence !== this.store.getState().sequence;
  }
  close() {
    this.channel?.close();
  }
  async flush(): Promise<void> {
    if (this.pending) {
      await this.pending;
      if (this.dirty()) return this.flush();
      return;
    }
    if (this.blocked)
      throw new Error('画布版本有冲突，请先选择重新加载或另存副本。');
    if (!this.dirty()) return;
    this.pending = this.write();
    try {
      await this.pending;
    } finally {
      this.pending = undefined;
    }
  }
  private async write() {
    while (this.dirty()) {
      if (this.blocked) throw new Error('画布版本已变更。');
      const { sequence, graph } = this.store.getState();
      this.notify('saving');
      try {
        const result = await projectApi.save(
          this.id,
          graph,
          this.revision,
          this.csrf,
        );
        this.revision = result.project.revision;
        this.savedSequence = sequence;
        this.received(result);
        this.channel?.postMessage(this.revision);
      } catch (error) {
        this.blocked = error instanceof SessionError && error.status === 409;
        this.notify(this.blocked ? 'conflict' : 'error', error);
        throw error;
      }
    }
    this.notify('saved');
  }
  accept(project: Project) {
    this.store.getState().reset(project.graph);
    this.initialize(project.project.revision);
    this.received(project);
  }
  advance(project: Project) {
    this.revision = project.project.revision;
    this.received(project);
    this.channel?.postMessage(this.revision);
    this.notify(this.dirty() ? 'dirty' : 'saved');
  }
  graph(): Graph {
    return this.store.getState().graph;
  }
}
