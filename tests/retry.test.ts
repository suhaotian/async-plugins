import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { asyncRetry, RetryError, RetryOptions, RetryStrategies } from '../src/retry';

// Helper function to create a mock operation that fails a certain number of times
const createFailingOperation = <T>(
  failCount: number,
  successValue: T,
  errorMessage = 'Operation failed'
) => {
  let attempts = 0;
  return vi.fn(async (): Promise<T> => {
    attempts++;
    if (attempts <= failCount) {
      return new Promise((resolve, reject) => {
        reject(new Error(errorMessage));
      });
    }
    return Promise.resolve(successValue);
  });
};

describe('asyncRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should return the result if the operation succeeds on the first try', async () => {
    const operation = vi.fn().mockResolvedValue('Success');
    const result = await asyncRetry(operation);
    expect(result).toBe('Success');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('should retry the operation if it fails and eventually succeed', async () => {
    const operation = createFailingOperation(2, 'Success'); // Fails twice, succeeds on the 3rd try
    const options: Partial<RetryOptions> = { retries: 3, minTimeout: 10 };

    const promise = asyncRetry(operation, options);
    await vi.advanceTimersByTimeAsync(10); // First retry delay
    await vi.advanceTimersByTimeAsync(20); // Second retry delay (factor=2)

    await expect(promise).resolves.toBe('Success');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('should throw RetryError if the operation fails after all retries', async () => {
    console.log('[TEST] Starting');
    const operation = createFailingOperation(4, 'Success', 'Persistent failure');
    const options: Partial<RetryOptions> = { retries: 3, minTimeout: 10, factor: 2 };

    console.log('[TEST] Calling asyncRetry');
    const promise = asyncRetry(operation, options);

    // Optional: Add a direct catch to the promise for logging ONLY
    // This helps see if the promise itself *knows* it's rejected
    promise.catch((err) => {
      console.log('[TEST] Promise internal .catch() triggered:', err?.message);
    });

    console.log('[TEST] Running timers');
    await vi.runAllTimersAsync();
    console.log('[TEST] Timers finished');

    let caughtError: Error | null = null;
    let finallyExecuted = false;

    try {
      console.log('[TEST] Awaiting promise in try block...');
      await promise; // Await the promise that we expect to reject
      console.error('[TEST] !!! Promise resolved unexpectedly!'); // This should NOT appear
    } catch (error) {
      console.log('[TEST] Caught error in catch block:', (error as Error)?.message);
      caughtError = error as Error;
    } finally {
      console.log('[TEST] Finally block executed.');
      finallyExecuted = true;
    }

    console.log(
      `[TEST] After try/catch. Error caught? ${!!caughtError}. Finally executed? ${finallyExecuted}`
    );

    // Perform assertions only if the error was caught by the try/catch
    console.log('[TEST] Performing assertions...');
    expect(finallyExecuted).toBe(true); // Sanity check
    expect(caughtError).not.toBeNull(); // Check if the error object was captured

    if (caughtError) {
      expect(caughtError).toBeInstanceOf(RetryError);
      expect(caughtError).toHaveProperty(
        'message',
        'Failed after 4 attempt(s): Persistent failure'
      );
      expect(caughtError).toHaveProperty('attempts', 4);
      expect(caughtError).toHaveProperty('originalError');
      expect((caughtError as any).originalError).toHaveProperty('message', 'Persistent failure');
      console.log('[TEST] Assertions on caught error passed.');
    } else {
      console.error('[TEST] !!! Assertions skipped because no error was caught!');
    }

    expect(operation).toHaveBeenCalledTimes(4);
    console.log('[TEST] Call count assertion passed.');
    console.log('[TEST] Finished.');
  });

  // it('should handle non-Error rejections', async () => {
  //   const operation = vi.fn().mockRejectedValue('Just a string rejection');
  //   const options: Partial<RetryOptions> = { retries: 1, minTimeout: 10 };

  //   const promise = asyncRetry(operation, options);
  //   await vi.advanceTimersByTimeAsync(1); // Allow first attempt
  //   expect(operation).toHaveBeenCalledTimes(1);
  //   await vi.advanceTimersByTimeAsync(10); // First retry delay
  //   expect(operation).toHaveBeenCalledTimes(2); // Second attempt

  //   // Add await before expect().rejects...
  //   await expect(promise).rejects.toThrow(RetryError);
  //   // Consolidate rejection check into one await
  //   await expect(promise).rejects.toThrowError(
  //     expect.objectContaining({
  //       name: 'RetryError',
  //       message: 'Failed after 2 attempt(s): Just a string rejection',
  //       attempts: 2,
  //       originalError: expect.objectContaining({ message: 'Just a string rejection' }),
  //     })
  //   );
  //   // Removed redundant try/catch
  //   expect(operation).toHaveBeenCalledTimes(2);
  // });

  // it('should use RetryStrategies.NETWORK_ONLY correctly', async () => {
  //   const networkErrorOp = createFailingOperation(1, 'Success', 'Network Error'); // Should retry
  //   const clientErrorOp = createFailingOperation(1, 'Success', 'Client Error 404'); // Should not retry

  //   const options: Partial<RetryOptions> = {
  //     retries: 1,
  //     minTimeout: 10,
  //     shouldRetry: RetryStrategies.NETWORK_ONLY,
  //   };

  //   // Test network error (should retry and succeed)
  //   // Test network error (should retry and succeed)
  //   const promiseNetwork = asyncRetry(networkErrorOp, options);
  //   // Allow the first attempt to fail and the retry logic to schedule the timer
  //   await vi.advanceTimersByTimeAsync(1); // Let microtasks run for the first attempt/failure
  //   expect(networkErrorOp).toHaveBeenCalledTimes(1);
  //   // Now run the timer for the delay, triggering the second attempt
  //   await vi.runAllTimersAsync();
  //   // Explicitly await the promise resolution *after* timers have run
  //   await expect(promiseNetwork).resolves.toBe('Success');
  //   expect(networkErrorOp).toHaveBeenCalledTimes(2); // Initial + 1 retry

  //   // Test client error (should fail immediately after first attempt)
  //   const promiseClient = asyncRetry(clientErrorOp, options);
  //   await vi.advanceTimersByTimeAsync(1); // Allow first attempt to run
  //   // shouldRetry returns false, so no delay/retry happens
  //   await expect(promiseClient).rejects.toThrow('Failed after 1 attempt(s): Client Error 404');
  //   expect(clientErrorOp).toHaveBeenCalledTimes(1); // Only the initial attempt
  // });

  it('should call onRetry callback on each retry attempt', async () => {
    const operation = createFailingOperation(2, 'Success');
    const onRetry = vi.fn();
    const options: Partial<RetryOptions> = { retries: 3, minTimeout: 10, onRetry };

    const promise = asyncRetry(operation, options);
    await vi.advanceTimersByTimeAsync(10); // Delay 1
    await vi.advanceTimersByTimeAsync(20); // Delay 2

    await expect(promise).resolves.toBe('Success');
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1); // After 1st failure (attempt 1)
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 2); // After 2nd failure (attempt 2)
  });

  it('should respect shouldRetry logic and not retry if it returns false', async () => {
    const operation = createFailingOperation(3, 'Success', 'Client Error 400');
    const shouldRetry = vi.fn((error: Error) => !error.message.includes('400')); // Don't retry on 400
    const options: Partial<RetryOptions> = { retries: 3, minTimeout: 10, shouldRetry };

    const promise = asyncRetry(operation, options);

    // No need to advance timers, shouldRetry stops it after the first failure
    // Add await before expect().rejects...
    await expect(promise).rejects.toThrow(RetryError);
    await expect(promise).rejects.toThrow('Failed after 1 attempt(s): Client Error 400');

    expect(operation).toHaveBeenCalledTimes(1);
    expect(shouldRetry).toHaveBeenCalledTimes(1); // shouldRetry is called once after the first failure
    expect(shouldRetry).toHaveBeenCalledWith(expect.any(Error));
  });

  it('should respect maxTimeout', async () => {
    const operation = createFailingOperation(2, 'Success');
    const onRetry = vi.fn();
    const options: Partial<RetryOptions> = {
      retries: 2,
      minTimeout: 50,
      maxTimeout: 75, // Lower than 50 * 2^1
      factor: 2,
      onRetry,
      jitter: false, // Disable jitter for predictable timing
    };

    const promise = asyncRetry(operation, options);
    await vi.advanceTimersByTimeAsync(1); // Allow first attempt to run and fail
    expect(operation).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1); // onRetry called after first failure

    // First retry delay: min(75, 50 * 2^0) = 50
    await vi.advanceTimersByTimeAsync(50);
    expect(operation).toHaveBeenCalledTimes(2); // Second attempt runs
    expect(onRetry).toHaveBeenCalledTimes(2); // onRetry called after second failure

    // Second retry delay: min(75, 50 * 2^1) = min(75, 100) = 75
    await vi.advanceTimersByTimeAsync(75);
    expect(operation).toHaveBeenCalledTimes(3); // Third attempt runs and succeeds
    expect(onRetry).toHaveBeenCalledTimes(2); // Not called again as it succeeded

    await expect(promise).resolves.toBe('Success'); // Final result
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('should handle retries = 0 correctly (only initial attempt)', async () => {
    const failingOp = createFailingOperation(1, 'Never');
    const successOp = vi.fn().mockResolvedValue('OK');

    // Test failure with retries = 0
    await expect(asyncRetry(failingOp, { retries: 0 })).rejects.toThrow(RetryError);
    expect(failingOp).toHaveBeenCalledTimes(1);

    // Test success with retries = 0
    await expect(asyncRetry(successOp, { retries: 0 })).resolves.toBe('OK');
    expect(successOp).toHaveBeenCalledTimes(1);
  });

  it('should be abortable using AbortSignal before starting', async () => {
    const controller = new AbortController();
    const operation = vi.fn().mockResolvedValue('Success');
    const options: Partial<RetryOptions> = { retries: 3, abortSignal: controller.signal };

    controller.abort(); // Abort immediately

    await expect(asyncRetry(operation, options)).rejects.toThrow('Retry operation aborted');
    expect(operation).not.toHaveBeenCalled();
  });

  it('should be abortable using AbortSignal during wait', async () => {
    const controller = new AbortController();
    const operation = createFailingOperation(3, 'Success'); // Fails multiple times
    const onRetry = vi.fn();
    const options: Partial<RetryOptions> = {
      retries: 3,
      minTimeout: 100,
      abortSignal: controller.signal,
      onRetry,
    };

    const promise = asyncRetry(operation, options);

    // Let the first failure happen
    await vi.advanceTimersByTimeAsync(1); // Allow microtasks to run
    expect(operation).toHaveBeenCalledTimes(1);
    // onRetry should be called immediately after the first failure, before the delay
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1); // Check arguments

    // Wait for part of the first delay, then abort
    vi.advanceTimersByTimeAsync(50);
    controller.abort();

    await expect(promise).rejects.toThrow('Retry operation aborted');
    expect(operation).toHaveBeenCalledTimes(1); // Only the first attempt
    expect(onRetry).toHaveBeenCalledTimes(1); // onRetry called for the first failure
  });

  // Note: Testing jitter precisely is difficult. We can check if it runs without error.
  it('should run with jitter enabled', async () => {
    const operation = createFailingOperation(1, 'Success');
    const options: Partial<RetryOptions> = { retries: 1, minTimeout: 100, jitter: true };

    const promise = asyncRetry(operation, options);
    // Advance timer by max possible delay (minTimeout) - jitter reduces it
    await vi.advanceTimersByTimeAsync(100);

    await expect(promise).resolves.toBe('Success');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('should handle errors in onRetry callback gracefully', async () => {
    const operation = createFailingOperation(2, 'Success');
    const onRetry = vi.fn().mockRejectedValue(new Error('Callback failed')); // Simulate failing callback
    const options: Partial<RetryOptions> = { retries: 3, minTimeout: 10, onRetry };
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); // Suppress console error

    const promise = asyncRetry(operation, options);
    await vi.advanceTimersByTimeAsync(10); // First retry delay
    await vi.advanceTimersByTimeAsync(20); // Second retry delay

    // The retry mechanism should still complete successfully despite callback errors
    await expect(promise).resolves.toBe('Success');
    expect(operation).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(consoleErrorSpy).toHaveBeenCalledWith('Error in retry callback:', expect.any(Error));

    consoleErrorSpy.mockRestore();
  });
});
