// ===== ASYNC RETRY =====

export interface RetryOptions {
  retries: number;
  minTimeout: number;
  maxTimeout: number;
  factor: number;
  onRetry?: (error: Error, attempt: number) => void | Promise<void>;
  shouldRetry?: (error: Error) => boolean | Promise<boolean>;
  jitter?: boolean; // Add randomness to backoff
  abortSignal?: AbortSignal; // Allow cancellation of retries
}

/**
 * Standard retry strategies for common scenarios
 */
export const RetryStrategies = {
  /**
   * Default strategy - retries on all errors
   */
  DEFAULT: () => true,

  /**
   * Only retry on network errors, not on HTTP 4xx client errors
   */
  NETWORK_ONLY: (error: Error) => {
    if (error.name === 'AbortError') return false;
    return (
      !(error instanceof TypeError && error.message.includes('fetch failed')) &&
      !(error instanceof Error && /^(4\d\d)/.test(error.message))
    );
  },

  /**
   * Retry on server errors (5xx) but not on client errors (4xx)
   */
  SERVER_ERRORS: (error: Error) => {
    return error instanceof Error && /^(5\d\d)/.test(error.message);
  },
};

/**
 * Custom error class for retry failures that preserves the original error
 */
export class RetryError extends Error {
  originalError: Error;
  attempts: number;

  constructor(message: string, originalError: Error, attempts: number) {
    super(message);
    this.name = 'RetryError';
    this.originalError = originalError;
    this.attempts = attempts;
  }
}

/**
 * Retries an asynchronous operation with configurable exponential backoff
 * @param operation The async function to retry
 * @param options Configuration options for retry behavior
 * @returns Promise that resolves with the operation result or rejects after all retries fail
 * @throws RetryError with .originalError property containing the last error
 */
export async function asyncRetry<T>(
  operation: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const config: RetryOptions = {
    retries: 3,
    minTimeout: 100,
    maxTimeout: 10000,
    factor: 2,
    jitter: true,
    ...options,
  };

  let lastError: Error | undefined; // Initialize explicitly
  let finalAttemptCount = 0; // Track actual attempts

  for (let attempt = 0; attempt <= config.retries; attempt++) {
    finalAttemptCount = attempt + 1; // Update attempt count
    try {
      // Check if operation has been aborted
      if (config.abortSignal?.aborted) {
        throw new Error('Retry operation aborted');
      }

      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check for abort *immediately* after catching any error (including the delay rejection)
      if (config.abortSignal?.aborted) {
         // If the caught error is already the specific abort error, rethrow it directly.
         // Otherwise, throw the standard abort error.
         if (lastError.message === 'Retry operation aborted') {
             throw lastError;
         } else {
             throw new Error('Retry operation aborted');
         }
      }

      // Exit conditions (if not aborted)
      if (attempt === config.retries) { // No longer need || config.abortSignal?.aborted here
        break;
      }

      // Check if we should retry based on the error (if not aborted)
      if (config.shouldRetry && !(await Promise.resolve(config.shouldRetry(lastError)))) {
        break;
      }

      // Call onRetry callback if provided
      if (config.onRetry) {
        try {
          await Promise.resolve(config.onRetry(lastError, attempt + 1));
        } catch (callbackError) {
          // Don't let callback errors interrupt the retry flow
          console.error('Error in retry callback:', callbackError);
        }
      }

      // Calculate backoff timeout
      let timeout = Math.min(
        config.maxTimeout,
        config.minTimeout * Math.pow(config.factor, attempt)
      );

      // Add jitter if enabled to prevent thundering herd problem
      if (config.jitter) {
        const jitterFactor = 0.5 + Math.random() * 0.5; // Random between 0.5 and 1
        timeout = Math.floor(timeout * jitterFactor);
      }

      // Create abort-aware timeout
      await new Promise<void>((resolve, reject) => {
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        let abortHandler: (() => void) | undefined;

        const cleanup = () => {
          if (timeoutId) clearTimeout(timeoutId);
          if (config.abortSignal && abortHandler) {
            config.abortSignal.removeEventListener('abort', abortHandler);
          }
        };

        // Handle abort signal
        if (config.abortSignal) {
          abortHandler = () => {
            cleanup();
            reject(new Error('Retry operation aborted'));
          };

          if (config.abortSignal.aborted) {
            // If already aborted before timeout starts
            abortHandler();
            return;
          }
          config.abortSignal.addEventListener('abort', abortHandler, { once: true });
        }

        timeoutId = setTimeout(() => {
          cleanup();
          resolve();
        }, timeout);
      });
    }
  }

  // Throw RetryError if lastError is defined (it should always be if we reach here)
  if (lastError) {
    throw new RetryError(
      `Failed after ${finalAttemptCount} attempt(s): ${lastError.message}`,
      lastError,
      finalAttemptCount
    );
  } else {
    // Should theoretically not happen if loop completed, but handle defensively
    throw new Error(`Retry mechanism failed unexpectedly after ${finalAttemptCount} attempts.`);
  }
}
