// Serialized write queue: every task runs after the previous one, none is dropped.

export type QueueHooks = {
  /** Right after a task is queued (cheap: stats, busy state). Must not replace click targets. */
  onQueued?: () => void;
  /** After each task settles (full render). */
  onSettled?: () => void;
  /** A task threw. */
  onError?: (e: unknown) => void;
};

export type WriteQueue = {
  /** Queue a task; resolves true if it ran without throwing. */
  enqueue: (task: () => Promise<void>) => Promise<boolean>;
  /**
   * Queue a task that reports success; `onAccepted` runs only when it returns true, after the
   * write is on disk. Resolves to that result.
   */
  enqueueAccepted: (task: () => Promise<boolean>, onAccepted?: () => void) => Promise<boolean>;
  /** Tasks queued or running. */
  readonly pending: number;
  /** Resolves once everything queued so far has settled (and its hooks ran). */
  idle: () => Promise<void>;
};

export function createQueue(hooks: QueueHooks = {}): WriteQueue {
  let chain: Promise<void> = Promise.resolve();
  let pending = 0;
  const enqueue = (task: () => Promise<void>) => {
    pending++;
    hooks.onQueued?.();
    const run = chain.then(task).then(
      () => true,
      (e) => { hooks.onError?.(e); return false; },
    );
    chain = run.then(() => {
      pending--;
      hooks.onSettled?.();
    });
    return run;
  };
  return {
    enqueue,
    enqueueAccepted(task, onAccepted) {
      let ok = false;
      return enqueue(async () => {
        ok = await task();
        if (ok) onAccepted?.();
      }).then((ran) => ran && ok);
    },
    get pending() { return pending; },
    idle: () => chain,
  };
}
