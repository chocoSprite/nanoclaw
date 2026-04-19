import type { GroupQueue } from '../../group-queue.js';

export interface QueueStatus {
  jid: string;
  active: boolean;
  idleWaiting: boolean;
  isTask: boolean;
  pendingMessages: boolean;
  pendingTaskCount: number;
  runningTaskId: string | null;
}

/**
 * Dashboard's read-only view over GroupQueue state. Narrowed to just what
 * the LivePage needs; the queue retains its internal container handles.
 */
export interface QueueReader {
  getStatuses(): QueueStatus[];
}

export class LiveQueueReader implements QueueReader {
  constructor(private readonly queue: GroupQueue) {}

  getStatuses(): QueueStatus[] {
    return this.queue.getStatuses();
  }
}
