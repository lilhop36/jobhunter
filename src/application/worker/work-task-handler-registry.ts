import { WorkTaskHandler } from './work-task-handler';

/**
 * Maps a work task `type` to its handler. Registration is explicit so an
 * unrecognised task type is a clear, permanent failure rather than a silent
 * no-op.
 */
export class WorkTaskHandlerRegistry {
  private readonly handlers = new Map<string, WorkTaskHandler>();

  register(type: string, handler: WorkTaskHandler): this {
    if (!type) throw new Error('Cannot register a work task handler without a type');
    if (this.handlers.has(type)) {
      throw new Error(`A handler is already registered for work task type "${type}"`);
    }
    this.handlers.set(type, handler);
    return this;
  }

  get(type: string): WorkTaskHandler | undefined {
    return this.handlers.get(type);
  }

  has(type: string): boolean {
    return this.handlers.has(type);
  }

  types(): string[] {
    return [...this.handlers.keys()];
  }
}
