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

    // Retry if it's a network error but not a 4xx client error
    // Note: Parsing error messages for status codes can be brittle.
    // Consider checking specific error types or properties (e.g., error.status) if available.
    const isNetworkError = error instanceof TypeError && error.message.includes('fetch failed');
    const isClientError = error instanceof Error && /^(4\d\d)/.test(error.message);

    return isNetworkError && !isClientError;
  },

  /**
   * Retry on server errors (5xx) but not on client errors (4xx)
   */
  SERVER_ERRORS: (error: Error) => {
    // Note: Parsing error messages for status codes can be brittle.
    // Consider checking specific error types or properties (e.g., error.status) if available.
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
    
    // Capture proper stack trace in modern JS environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, RetryError);
    }
  }
}

/**
 * Constant for abort error message to ensure consistency
 */
const ABORT_ERROR_MESSAGE = 'Retry operation aborted';

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

  let lastError: Error | undefined;
  let finalAttemptCount = 0;

  // Check if already aborted before starting
  if (config.abortSignal?.aborted) {
    throw new Error(ABORT_ERROR_MESSAGE);
  }

  for (let attempt = 0; attempt <= config.retries; attempt++) {
    finalAttemptCount = attempt + 1;
    
    try {
      return await operation();
    } catch (error) {
      // Ensure error is properly typed
      lastError = error instanceof Error ? error : new Error(String(error));
      
      // Check if operation has been aborted
      if (config.abortSignal?.aborted) {
        throw new Error(ABORT_ERROR_MESSAGE);
      }
      
      // Exit if this was the last attempt
      if (attempt === config.retries) {
        break;
      }
      
      // Check if we should retry based on the error
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
            reject(new Error(ABORT_ERROR_MESSAGE));
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
  
  // Throw RetryError if lastError is defined
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

/**
 * Creates a retry function with pre-configured options
 * @param defaultOptions Default options to use for all retries
 * @returns A function that retries operations with the default options
 */
export function createAsyncRetry(defaultOptions: Partial<RetryOptions>) {
  return function retryWithOptions<T>(
    operation: () => Promise<T>,
    overrideOptions: Partial<RetryOptions> = {}
  ): Promise<T> {
    return asyncRetry(operation, { ...defaultOptions, ...overrideOptions });
  };
}

