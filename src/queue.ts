// ===== ASYNC QUEUE =====

export interface QueueOptions {
  concurrency: number; // Number of concurrent operations
  autoStart?: boolean; // Start processing automatically
  onError?: (error: Error, task: any) => void | Promise<void>; // Called when a task errors
  onEmpty?: () => void | Promise<void>; // Called when queue becomes empty
  onDrain?: () => void | Promise<void>; // Called when queue becomes empty and all tasks complete
  abortSignal?: AbortSignal; // Allow cancellation of queue
}

export interface QueueStats {
  pending: number; // Tasks waiting to be processed
  active: number; // Tasks currently processing
  completed: number; // Tasks successfully completed
  errors: number; // Tasks that resulted in errors
  total: number; // Total tasks ever added
}

export interface AsyncQueue<T = any> {
  add: <R>(task: () => Promise<R>, priority?: number) => Promise<R>;
  addAll: <R>(tasks: Array<() => Promise<R>>) => Promise<R[]>;
  pause: () => void;
  resume: () => void;
  clear: () => void;
  size: () => number;
  activeCount: () => number;
  isPaused: () => boolean;
  isEmpty: () => boolean;
  isIdle: () => boolean;
  onEmpty: () => Promise<void>;
  onDrain: () => Promise<void>;
  stats: () => QueueStats;
  setConcurrency: (concurrency: number) => void;
}

/**
 * Creates a queue to process async operations with concurrency control
 * @param options Configuration options for queue behavior
 * @returns A queue object with methods to add and control tasks
 */
export function createAsyncQueue<T = any>(options: Partial<QueueOptions> = {}): AsyncQueue<T> {
  const config: QueueOptions = {
    concurrency: 1,
    autoStart: true,
    ...options,
  };

  // Queue state
  const tasks: Array<{
    task: () => Promise<any>;
    resolve: (value: any) => void;
    reject: (reason: any) => void;
    priority: number;
  }> = [];

  let activeCount = 0;
  let paused = !config.autoStart;
  let drainPromise: Promise<void> | null = null;
  let drainResolve: (() => void) | null = null;
  let emptyPromise: Promise<void> | null = null;
  let emptyResolve: (() => void) | null = null;
  let needsSort = false;

  // Stats
  const stats: QueueStats = {
    pending: 0,
    active: 0,
    completed: 0,
    errors: 0,
    total: 0,
  };

  // Check if aborted
  let aborted = false;
  if (config.abortSignal) {
    const abortHandler = () => {
      aborted = true;
      clear();
    };

    if (config.abortSignal.aborted) {
      aborted = true;
    } else {
      config.abortSignal.addEventListener('abort', abortHandler, { once: true });
    }
  }

  // Process next task
  function processNext() {
    // Don't process if paused, aborted, or no capacity
    if (paused || aborted || activeCount >= config.concurrency || tasks.length === 0) {
      return;
    }

    // Sort tasks by priority (higher first) - only when needed
    if (needsSort && tasks.length > 1) {
      tasks.sort((a, b) => b.priority - a.priority);
      needsSort = false;
    }

    // Take next task
    const { task, resolve, reject } = tasks.shift()!;
    activeCount++;
    stats.pending = tasks.length;
    stats.active = activeCount;

    // Check if queue is now empty (AFTER updating activeCount)
    if (tasks.length === 0) {
      const currentEmptyResolve = emptyResolve;
      // Reset before calling callbacks to prevent race conditions
      emptyPromise = null;
      emptyResolve = null;

      if (currentEmptyResolve) {
        currentEmptyResolve();
      }

      if (config.onEmpty) {
        try {
          const result = config.onEmpty();
          if (result instanceof Promise) {
            result.catch((err) => {
              console.error('Error in onEmpty callback:', err);
            });
          }
        } catch (err) {
          console.error('Error in onEmpty callback:', err);
        }
      }
    }

    // Process the task
    Promise.resolve()
      .then(() => task())
      .then(
        (result) => {
          resolve(result);
          stats.completed++;
          activeCount--;
          stats.active = activeCount;

          // Check for drain condition
          checkDrain();

          // Process next task
          processNext();
        },
        (error) => {
          reject(error);
          stats.errors++;
          activeCount--;
          stats.active = activeCount;

          if (config.onError) {
            try {
              const result = config.onError(error, task);
              if (result instanceof Promise) {
                result.catch((err) => {
                  console.error('Error in onError callback:', err);
                });
              }
            } catch (err) {
              console.error('Error in onError callback:', err);
            }
          }

          // Check for drain condition
          checkDrain();

          // Process next task
          processNext();
        }
      );
  }

  // Check if queue is drained (empty and no active tasks)
  function checkDrain() {
    if (tasks.length === 0 && activeCount === 0) {
      const currentDrainResolve = drainResolve;
      // Reset before calling callbacks to prevent race conditions
      drainPromise = null;
      drainResolve = null;

      if (currentDrainResolve) {
        currentDrainResolve();
      }

      if (config.onDrain) {
        try {
          const result = config.onDrain();
          if (result instanceof Promise) {
            result.catch((err) => {
              console.error('Error in onDrain callback:', err);
            });
          }
        } catch (err) {
          console.error('Error in onDrain callback:', err);
        }
      }
    }
  }

  // Clear all pending tasks
  function clear() {
    for (const { reject } of tasks) {
      reject(new Error('Queue cleared'));
    }

    tasks.length = 0;
    stats.pending = 0;

    // Resolve empty promise if it exists
    if (emptyResolve) {
      const currentEmptyResolve = emptyResolve;
      emptyPromise = null;
      emptyResolve = null;
      currentEmptyResolve();
    }

    // Check drain condition
    checkDrain();
  }

  // Try to process multiple tasks if concurrency allows
  function processMultiple() {
    const available = config.concurrency - activeCount;
    // Process as many tasks as we can based on available concurrency
    for (let i = 0; i < available && tasks.length > 0; i++) {
      processNext();
    }
  }

  // Create queue API
  const queue: AsyncQueue<T> = {
    add: <R>(task: () => Promise<R>, priority = 0): Promise<R> => {
      if (aborted) {
        return Promise.reject(new Error('Queue aborted'));
      }

      return new Promise<R>((resolve, reject) => {
        tasks.push({ task, resolve, reject, priority });
        needsSort = true;
        stats.pending = tasks.length;
        stats.total++;

        // Initialize promises if queue was previously empty and idle
        if (tasks.length === 1 && activeCount === 0) {
          if (!drainPromise && !drainResolve) {
            drainPromise = new Promise<void>((resolve) => {
              drainResolve = resolve;
            });
          }

          if (!emptyPromise && !emptyResolve) {
            emptyPromise = new Promise<void>((resolve) => {
              emptyResolve = resolve;
            });
          }
        }

        processNext();
      });
    },

    addAll: <R>(newTasks: Array<() => Promise<R>>): Promise<R[]> => {
      if (aborted) {
        return Promise.reject(new Error('Queue aborted'));
      }

      if (newTasks.length === 0) {
        return Promise.resolve([]);
      }

      const promises = newTasks.map((task) => {
        // Create a promise for each task like queue.add does
        return new Promise<R>((resolve, reject) => {
          tasks.push({ task, resolve, reject, priority: 0 }); // Assuming default priority 0 for addAll
          stats.pending++;
          stats.total++;
        });
      });

      // Set needsSort flag after adding all tasks
      if (newTasks.length > 0) {
        needsSort = true;
      }

      // Initialize promises if queue was previously empty and idle
      if (tasks.length === newTasks.length && activeCount === 0 && newTasks.length > 0) {
        if (!drainPromise && !drainResolve) {
          drainPromise = new Promise<void>((resolve) => {
            drainResolve = resolve;
          });
        }
        if (!emptyPromise && !emptyResolve) {
          emptyPromise = new Promise<void>((resolve) => {
            emptyResolve = resolve;
          });
        }
      }

      // Trigger processing after adding all tasks
      processMultiple(); // Use processMultiple instead of processNext

      return Promise.all(promises);
    },

    pause: () => {
      paused = true;
    },

    resume: () => {
      if (paused) {
        paused = false;
        processMultiple();
      }
    },

    clear,

    size: () => tasks.length,

    activeCount: () => activeCount,

    isPaused: () => paused,

    isEmpty: () => tasks.length === 0,

    isIdle: () => tasks.length === 0 && activeCount === 0,

    // Fix for onEmpty
    onEmpty: () => {
      // If already empty, resolve immediately
      // BUT only if there are no active tasks either!
      // This is crucial because if activeCount > 0, the queue is not truly empty
      if (tasks.length === 0) {
        // Create a new promise each time to prevent multiple resolves
        return Promise.resolve();
      }

      if (!emptyPromise) {
        emptyPromise = new Promise<void>((resolve) => {
          emptyResolve = resolve;
        });
      }

      return emptyPromise;
    },

    // Fix for onDrain
    onDrain: () => {
      // Only resolve immediately if the queue is truly idle
      // (no pending tasks AND no active tasks)
      if (tasks.length === 0 && activeCount === 0) {
        // Create a new promise each time to prevent multiple resolves
        return Promise.resolve();
      }

      if (!drainPromise) {
        drainPromise = new Promise<void>((resolve) => {
          drainResolve = resolve;
        });
      }

      return drainPromise;
    },

    stats: () => ({ ...stats }),

    setConcurrency: (concurrency: number) => {
      const oldConcurrency = config.concurrency;
      config.concurrency = Math.max(1, concurrency);

      // If we increased concurrency, try to process more tasks
      if (config.concurrency > oldConcurrency) {
        processMultiple();
      }
    },
  };

  return queue;
}
