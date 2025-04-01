// ===== ASYNC DEDUPE =====

export interface DedupeOptions {
  timeout?: number; // Maximum time to wait for in-flight request before creating a new one
  errorSharing?: boolean; // Whether to share errors across deduplicated calls
  keyPrefix?: string; // Prefix for keys to avoid collisions when used in multiple places
}

export interface PromiseRecord<T> {
  promise: Promise<T>;
  timestamp: number;
  subscribers: number;
  controller?: AbortController; // Optional abort controller for the operation
}

export interface AsyncDedupe {
  <T, Args extends any[]>(
    fn: (...args: Args) => Promise<T>,
    keyGenerator?: (...args: Args) => string
  ): (...args: Args) => Promise<T>;
  inProgressCount: () => number;
  isInProgress: (key: string) => boolean;
  getInProgressKeys: () => string[];
  reset: () => void;
  abort: (key: string) => boolean; // Abort a specific in-progress operation
  abortAll: () => number; // Abort all in-progress operations, returns count
}

/**
 * Creates a wrapper that deduplicates identical simultaneous calls to an async function
 * @param options Configuration options for deduplication behavior
 * @returns A function to wrap async functions with deduplication
 */
export function createAsyncDedupe(options: Partial<DedupeOptions> = {}): AsyncDedupe {
  const config: DedupeOptions = {
    timeout: undefined,
    errorSharing: true,
    keyPrefix: '',
    ...options,
  };

  const inProgress = new Map<string, PromiseRecord<any>>();

  /**
   * Wraps an async function with deduplication capabilities
   * @param fn The async function to deduplicate
   * @param keyGenerator Optional function to generate a unique key from arguments
   * @returns A wrapped function that deduplicates calls
   */
  function asyncDedupe<T, Args extends any[]>(
    fn: (...args: Args) => Promise<T>,
    keyGenerator?: (...args: Args) => string
  ): (...args: Args) => Promise<T> {
    return async (...args: Args): Promise<T> => {
      const rawKey = keyGenerator ? keyGenerator(...args) : JSON.stringify(args);

      const key = config.keyPrefix ? `${config.keyPrefix}:${rawKey}` : rawKey;
      const now = Date.now();

      // If this exact call is already in progress and not timed out
      if (inProgress.has(key)) {
        const record = inProgress.get(key)!;

        // Check for timeout if configured
        if (!config.timeout || now - record.timestamp < config.timeout) {
          record.subscribers++;

          // If error sharing is disabled, create a new promise chain to isolate errors
          if (!config.errorSharing) {
            return record.promise.catch((error) => {
              // Re-throw the error to maintain the same behavior but isolate the rejection
              throw error instanceof Error ? error : new Error(String(error));
            });
          }

          return record.promise;
        }
        // If timed out, we'll create a new request below
      }

      // Create a new promise for this call
      let resolveOuter!: (value: T | PromiseLike<T>) => void;
      let rejectOuter!: (reason?: any) => void;

      const resultPromise = new Promise<T>((resolve, reject) => {
        resolveOuter = resolve;
        rejectOuter = reject;
      });

      // Create abort controller for this request
      const controller = new AbortController();

      // Create the promise record
      const record: PromiseRecord<T> = {
        promise: resultPromise,
        timestamp: now,
        subscribers: 1,
        controller,
      };

      // Store the promise record
      inProgress.set(key, record);

      // Execute the actual function
      try {
        // Pass the abort signal to the function if it expects it
        // This assumes the function can accept an AbortSignal, typically in an options object
        const fnArgs = [...args] as any[];
        const lastArg = args[args.length - 1];

        // If the last argument is an object, add the signal to it
        // This is a common pattern, but functions would need to be designed for this
        if (lastArg && typeof lastArg === 'object' && !Array.isArray(lastArg)) {
          fnArgs[fnArgs.length - 1] = {
            ...lastArg,
            signal: controller.signal,
          };
        }

        const result = await fn(...(fnArgs as Args));
        resolveOuter(result);
        return result;
      } catch (error) {
        rejectOuter(error);
        throw error;
      } finally {
        // Clean up the map entry only if it's still our promise
        // (might have been replaced by a newer one if timeout occurred)
        if (inProgress.get(key) === record) {
          inProgress.delete(key);
        }
      }
    };
  }

  // Add helper methods
  asyncDedupe.inProgressCount = () => inProgress.size;
  asyncDedupe.isInProgress = (key: string) => inProgress.has(key);
  asyncDedupe.getInProgressKeys = () => Array.from(inProgress.keys());
  asyncDedupe.reset = () => {
    // Abort all in-progress operations before resetting
    asyncDedupe.abortAll();
    inProgress.clear();
  };
  asyncDedupe.abort = (key: string) => {
    const record = inProgress.get(key);
    if (record && record.controller) {
      record.controller.abort();
      inProgress.delete(key);
      return true;
    }
    return false;
  };
  asyncDedupe.abortAll = () => {
    let count = 0;
    for (const [key, record] of inProgress.entries()) {
      if (record.controller) {
        record.controller.abort();
        count++;
      }
      inProgress.delete(key);
    }
    return count;
  };

  return asyncDedupe;
}
