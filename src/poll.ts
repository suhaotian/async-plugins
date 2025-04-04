// ===== ASYNC POLL =====

export interface PollOptions {
  interval: number; // Polling interval in milliseconds
  maxAttempts?: number; // Maximum number of attempts (undefined = infinite)
  backoff?: {
    // Backoff configuration
    type: 'fixed' | 'linear' | 'exponential';
    factor?: number; // Factor to multiply by (for linear/exponential)
    maxInterval?: number; // Maximum interval
    jitter?: boolean; // Add random jitter to prevent thundering herd
  };
  shouldContinue?: (result: any, attempt: number) => boolean; // Determine if polling should continue
  onProgress?: (result: any, attempt: number) => void; // Callback for intermediate results
  onError?: (error: Error, attempt: number) => boolean | Promise<boolean>; // Handle errors, return true to continue
  abortSignal?: AbortSignal; // Allow cancellation of polling
}

export class PollError extends Error {
  constructor(
    message: string,
    public attempt: number,
    public cause?: Error
  ) {
    super(message);
    this.name = 'PollError';
  }
}

export interface AsyncPoller<T> {
  start: () => Promise<T>;
  stop: () => void;
  isPolling: () => boolean;
  currentAttempt: () => number;
  changeInterval: (interval: number) => void;
}

/**
 * Creates a poller to repeatedly call an async function until a condition is met
 * @param fn The async function to poll
 * @param options Configuration options for polling behavior
 * @returns A poller object with methods to control polling
 */
export function createAsyncPoller<T>(
  fn: () => Promise<T>,
  options: Partial<PollOptions> = {}
): AsyncPoller<T> {
  const config: PollOptions = {
    interval: 1000,
    shouldContinue: () => false, // Make the default behavior explicit
    ...options,
  };

  // Polling state
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let currentAttempt = 0;
  let currentInterval = config.interval;
  let polling = false;
  let aborted = false;
  let abortHandler: (() => void) | null = null;

  // Promise control - separate for each call to start()
  let currentPromise: {
    resolve: (value: T) => void;
    reject: (reason: any) => void;
  } | null = null;

  // Set up abort handler
  function setupAbortListener() {
    if (!config.abortSignal) return;

    // Remove any existing handler
    cleanupAbortListener();

    if (config.abortSignal.aborted) {
      aborted = true;
      return;
    }

    // Create new handler
    abortHandler = () => {
      aborted = true;
      stop('Polling operation aborted');
    };

    config.abortSignal.addEventListener('abort', abortHandler);
  }

  // Clean up abort listener
  function cleanupAbortListener() {
    if (abortHandler && config.abortSignal) {
      config.abortSignal.removeEventListener('abort', abortHandler);
      abortHandler = null;
    }
  }

  // Calculate next interval based on backoff strategy with optional jitter
  function getNextInterval(): number {
    if (!config.backoff) {
      return config.interval;
    }

    const { type, factor = 2, maxInterval, jitter = false } = config.backoff;

    let nextInterval: number;

    switch (type) {
      case 'fixed':
        nextInterval = config.interval;
        break;
      case 'linear':
        nextInterval = config.interval + config.interval * (factor - 1) * currentAttempt;
        break;
      case 'exponential':
        nextInterval = config.interval * Math.pow(factor, currentAttempt);
        break;
      default:
        nextInterval = config.interval;
    }

    if (maxInterval !== undefined) {
      nextInterval = Math.min(nextInterval, maxInterval);
    }

    // Apply jitter if configured (±15%)
    if (jitter) {
      const jitterRange = nextInterval * 0.15;
      nextInterval += Math.random() * jitterRange * 2 - jitterRange;
    }

    return nextInterval;
  }

  // Execute a single poll attempt
  async function executePoll() {
    if (!polling || aborted || !currentPromise) return;

    // Check max attempts first
    if (config.maxAttempts !== undefined && currentAttempt >= config.maxAttempts) {
      const error = new PollError(
        `Polling reached maximum attempts (${config.maxAttempts})`,
        currentAttempt
      );
      currentPromise.reject(error);
      cleanup();
      return;
    }

    currentAttempt++;

    try {
      const result = await fn();

      // Report progress if configured
      if (config.onProgress) {
        config.onProgress(result, currentAttempt);
      }

      // Check if we should continue polling
      const shouldContinue = config.shouldContinue
        ? config.shouldContinue(result, currentAttempt)
        : false;

      if (!shouldContinue) {
        // Resolve with the final result
        currentPromise.resolve(result);
        cleanup();
        return;
      }

      // Schedule next attempt
      currentInterval = getNextInterval();
      timerId = setTimeout(executePoll, currentInterval);
    } catch (error) {
      // Handle errors
      const shouldContinue = config.onError
        ? await Promise.resolve(config.onError(error as Error, currentAttempt))
        : false;

      if (!shouldContinue) {
        const pollError = new PollError(
          `Polling failed after ${currentAttempt} attempts`,
          currentAttempt,
          error instanceof Error ? error : new Error(String(error))
        );
        currentPromise.reject(pollError);
        cleanup();
        return;
      }

      // Schedule next attempt
      currentInterval = getNextInterval();
      timerId = setTimeout(executePoll, currentInterval);
    }
  }

  // Clean up all resources
  function cleanup() {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }

    polling = false;
    currentPromise = null;
    cleanupAbortListener();
  }

  // Stop polling
  function stop(reason = 'Polling stopped') {
    if (!polling) return;

    const currentPromiseRef = currentPromise;

    // Set the reference to null before rejecting to prevent callback issues
    currentPromise = null;
    polling = false;

    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }

    cleanupAbortListener();

    if (currentPromiseRef) {
      currentPromiseRef.reject(new PollError(reason, currentAttempt));
    }
  }

  // Create poller API
  const poller: AsyncPoller<T> = {
    start: (): Promise<T> => {
      // If already polling, stop first
      if (polling) {
        stop('Previous polling operation superseded');
      }

      // Check if already aborted before starting
      if (config.abortSignal?.aborted) {
        return Promise.reject(new PollError('Polling operation aborted', 0));
      }

      // Reset state
      currentAttempt = 0;
      currentInterval = config.interval;
      polling = true;

      // Set up abort handling
      setupAbortListener();

      // Create a new promise
      return new Promise<T>((resolve, reject) => {
        currentPromise = { resolve, reject };

        // Start polling immediately on next tick to ensure proper setup
        setTimeout(executePoll, 0);
      });
    },

    stop: () => stop(),

    isPolling: () => polling,

    currentAttempt: () => currentAttempt,

    changeInterval: (interval: number) => {
      if (interval <= 0) {
        throw new Error('Interval must be greater than 0');
      }

      const oldInterval = config.interval;
      config.interval = interval;

      // If we're polling and the timer is active, restart with new interval
      if (polling && timerId !== null) {
        // Calculate the new current interval based on backoff state
        if (!config.backoff) {
          currentInterval = interval;
        } else if (config.backoff.type === 'fixed') {
          currentInterval = interval;
        } else if (config.backoff.type === 'linear') {
          // Preserve the linear progression
          const factor = config.backoff.factor ?? 2;
          currentInterval = interval + interval * (factor - 1) * (currentAttempt - 1);
        } else if (config.backoff.type === 'exponential') {
          // Preserve the exponential progression
          const factor = config.backoff.factor ?? 2;
          currentInterval = interval * Math.pow(factor, currentAttempt - 1);
        }

        // Apply maxInterval if configured
        if (config.backoff?.maxInterval !== undefined) {
          currentInterval = Math.min(currentInterval, config.backoff.maxInterval);
        }

        // Apply jitter if configured
        if (config.backoff?.jitter) {
          const jitterRange = currentInterval * 0.15;
          currentInterval += Math.random() * jitterRange * 2 - jitterRange;
        }

        clearTimeout(timerId);
        timerId = setTimeout(executePoll, currentInterval);
      }
    },
  };

  return poller;
}
