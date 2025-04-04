// dedupe.ts
export interface DedupeOptions {
  timeout?: number; // Maximum time to wait for in-flight request before creating a new one
  errorSharing?: boolean; // Whether to share errors across deduplicated calls
  keyPrefix?: string; // Prefix for keys to avoid collisions when used in multiple places
  abortSupport?: boolean; // Whether functions support AbortController signals
  maxAge?: number; // Optional max age for cached promises before they're considered stale
}

export interface PromiseRecord<T> {
  promise: Promise<T>;
  timestamp: number;
  subscribers: number;
  controller?: AbortController; // Optional abort controller for the operation
  id: number; // Unique identifier for this promise record
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
    abortSupport: true,
    maxAge: undefined, // Default to no max age
    ...options,
  };

  const inProgress = new Map<string, PromiseRecord<any>>();
  let nextPromiseId = 1; // To generate unique IDs for promise records

  // Fix: Use generic timeout ID type to support both Node and browser environments
  let cleanupTimer: ReturnType<typeof setTimeout> | null = null;

  const setupCleanupTimer = () => {
    if (config.maxAge && !cleanupTimer) {
      // Fix: Use setTimeout/setInterval in a way that works in both Node and browser
      const maxAge = config.maxAge; // Avoid non-null assertion
      cleanupTimer = setInterval(
        () => {
          const now = Date.now();
          for (const [key, record] of inProgress.entries()) {
            if (now - record.timestamp > maxAge) {
              // Abort and remove stale promises
              if (record.controller) {
                record.controller.abort(new Error('Promise timed out due to maxAge'));
              }
              inProgress.delete(key);
            }
          }

          // If no more in-progress items, clear the interval
          if (inProgress.size === 0 && cleanupTimer) {
            clearInterval(cleanupTimer);
            cleanupTimer = null;
          }
        },
        Math.min(maxAge, 60000)
      ); // Run at most once per minute
    }
  };

  /**
   * Safely applies an abort signal to function arguments
   * @param fn The original function
   * @param args Original arguments
   * @param signal Abort signal to apply
   * @returns Modified arguments array with abort signal applied
   */
  function applyAbortSignal<Args extends any[]>(
    fn: Function,
    args: Args,
    signal: AbortSignal
  ): Args {
    // Create a copy of the arguments
    const fnArgs = [...args] as Args;

    // Strategy 1: Check if last argument is an options object
    const lastArgIndex = fnArgs.length - 1;
    if (lastArgIndex >= 0) {
      const lastArg = fnArgs[lastArgIndex];
      // Fix: Better check for options objects - must be plain object and not null
      if (
        lastArg && 
        typeof lastArg === 'object' && 
        !Array.isArray(lastArg) && 
        lastArg.constructor === Object
      ) {
        // Update the existing options object
        fnArgs[lastArgIndex] = {
          ...lastArg,
          signal: signal,
        };
        return fnArgs;
      }
    }

    // Strategy 2: Add a new options object with the signal
    return [...fnArgs, { signal }] as unknown as Args;
  }

  /**
   * Properly clone an error while preserving properties
   * @param error Original error
   * @returns Cloned error
   */
  function cloneError(error: unknown): Error {
    // Handle non-error objects
    if (!(error instanceof Error)) {
      return new Error(String(error));
    }

    // Create appropriate error instance based on constructor
    let newError: Error;

    // Handle specific error types
    if (error instanceof TypeError) {
      newError = new TypeError(error.message);
    } else if (error instanceof RangeError) {
      newError = new RangeError(error.message);
    } else if (error instanceof SyntaxError) {
      newError = new SyntaxError(error.message);
    } else if (error instanceof ReferenceError) {
      newError = new ReferenceError(error.message);
    } else {
      // Default error or custom error types
      try {
        // Try to use the same constructor
        newError = new (error.constructor as ErrorConstructor)(error.message);
      } catch {
        // Fallback to a standard error
        newError = new Error(error.message);
      }
    }

    // Copy stack trace
    newError.stack = error.stack;
    newError.name = error.name;

    // Copy custom properties
    for (const prop in error) {
      if (Object.prototype.hasOwnProperty.call(error, prop)) {
        try {
          (newError as any)[prop] = (error as any)[prop];
        } catch {
          // Ignore failures on read-only properties
        }
      }
    }

    return newError;
  }

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

        // Check for staleness based on maxAge first
        const isStale = config.maxAge && now - record.timestamp > config.maxAge;

        // Check for timeout if configured
        const isTimedOut = config.timeout && now - record.timestamp >= config.timeout;

        // Reuse if not stale and not timed out
        if (!isStale && !isTimedOut) {
          record.subscribers++;

          // If error sharing is disabled, create a new promise chain to isolate errors
          if (!config.errorSharing) {
            // Create a new promise that will resolve/reject independently
            return new Promise<T>((resolve, reject) => {
              record.promise.then(resolve).catch((error) => {
                reject(cloneError(error));
              });
            });
          }

          return record.promise;
        }

        // If stale or timed out, we'll create a new request below.
        // Don't abort the original promise here, just remove the record
        // so the new request gets a fresh promise.
        // The maxAge cleanup timer will eventually abort stale promises if needed.
        inProgress.delete(key);
      }

      // Start cleanup timer if needed
      if (config.maxAge) {
        setupCleanupTimer();
      }

      // Generate a unique ID for this promise record
      const promiseId = nextPromiseId++;
      
      // Create a new promise for this call
      const controller = config.abortSupport ? new AbortController() : undefined;

      let result: Promise<T>;
      let promiseRecord: PromiseRecord<T>;

      try {
        // Apply abort signal if abortSupport is enabled
        let fnArgs: Args;
        if (config.abortSupport && controller) {
          fnArgs = applyAbortSignal(fn, args, controller.signal);
        } else {
          fnArgs = args;
        }
        
        result = fn(...fnArgs);

        // Handle case where the function doesn't return a promise
        if (!(result instanceof Promise)) {
          throw new Error('Wrapped function did not return a Promise');
        }
      } catch (error) {
        // Handle synchronous errors (including non-Promise return)
        // Reject with the error but don't store in inProgress
        return Promise.reject(error);
      }

      // Create wrapped promise that will clean up records when done
      const wrappedPromise = result
        .then((value) => {
          // Clean up on success
          const currentRecord = inProgress.get(key);
          if (currentRecord && currentRecord.id === promiseId) {
            inProgress.delete(key);
          }
          return value;
        })
        .catch((error) => {
          // Clean up on error
          const currentRecord = inProgress.get(key);
          if (currentRecord && currentRecord.id === promiseId) {
            inProgress.delete(key);
          }
          throw error;
        });

      // Create the promise record
      promiseRecord = {
        promise: wrappedPromise,
        timestamp: now,
        subscribers: 1,
        controller,
        id: promiseId,
      };

      // Store the promise record
      inProgress.set(key, promiseRecord);

      return wrappedPromise;
    };
  }

  // Add helper methods
  asyncDedupe.inProgressCount = () => inProgress.size;
  asyncDedupe.isInProgress = (key: string) => inProgress.has(key);
  asyncDedupe.getInProgressKeys = () => Array.from(inProgress.keys());

  // Reset method that properly aborts operations
  asyncDedupe.reset = () => {
    // Abort all in-progress operations before resetting
    for (const record of inProgress.values()) {
      if (record.controller) {
        record.controller.abort(new Error('Operation aborted due to reset'));
      }
    }
    inProgress.clear();

    // Clear cleanup timer if it exists
    if (cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  };

  // Abort method to ensure abortion actually happens
  asyncDedupe.abort = (key: string) => {
    const record = inProgress.get(key);
    if (record && record.controller) {
      record.controller.abort(new Error(`Operation aborted for key: ${key}`));
      inProgress.delete(key);
      return true;
    }
    return false;
  };

  // AbortAll method
  asyncDedupe.abortAll = () => {
    let count = 0;
    for (const [key, record] of inProgress.entries()) {
      if (record.controller) {
        record.controller.abort(new Error('Operation aborted'));
        count++;
      }
    }
    inProgress.clear();

    // Clear cleanup timer if it exists
    if (cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }

    return count;
  };

  return asyncDedupe;
}
