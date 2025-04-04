// dedupe.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAsyncDedupe, type AsyncDedupe } from '../src/dedupe';

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Optionally, you can also terminate the process:
  // process.exit(1);
});

describe('createAsyncDedupe', () => {
  let dedupe: AsyncDedupe;

  beforeEach(() => {
    // Create a fresh dedupe instance for each test
    dedupe = createAsyncDedupe();
    vi.useFakeTimers();
    // Set test environment to prevent signal passing to functions in tests
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    // Clean up after each test
    dedupe.reset();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should execute the function when called for the first time', async () => {
    const mockFn = vi.fn().mockResolvedValue('result');
    const deduped = dedupe(mockFn);

    const result = await deduped('arg1', 'arg2');

    expect(result).toBe('result');
    expect(mockFn).toHaveBeenCalledTimes(1);
    // Expect the call to include the options object with the signal
    expect(mockFn).toHaveBeenCalledWith(
      'arg1',
      'arg2',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('should deduplicate identical calls', async () => {
    const mockFn = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return 'result';
    });

    const deduped = dedupe(mockFn);

    // Make multiple identical calls
    const promise1 = deduped('arg1', 'arg2');
    const promise2 = deduped('arg1', 'arg2');
    const promise3 = deduped('arg1', 'arg2');

    vi.advanceTimersByTime(200);

    const [result1, result2, result3] = await Promise.all([promise1, promise2, promise3]);

    expect(result1).toBe('result');
    expect(result2).toBe('result');
    expect(result3).toBe('result');
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('should treat different arguments as separate calls', async () => {
    const mockFn = vi.fn().mockImplementation(async (arg) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return `result-${arg}`;
    });

    const deduped = dedupe(mockFn);

    const promise1 = deduped('arg1');
    const promise2 = deduped('arg2');

    vi.advanceTimersByTime(200);

    const [result1, result2] = await Promise.all([promise1, promise2]);

    expect(result1).toBe('result-arg1');
    expect(result2).toBe('result-arg2');
    expect(mockFn).toHaveBeenCalledTimes(2);
  });

  it('should respect custom key generators', async () => {
    const mockFn = vi.fn().mockResolvedValue('result');
    const keyGenerator = vi.fn().mockImplementation(() => 'custom-key');

    const deduped = dedupe(mockFn, keyGenerator);

    await Promise.all([deduped('arg1', 'arg2'), deduped('different', 'args')]);

    expect(mockFn).toHaveBeenCalledTimes(1);
    expect(keyGenerator).toHaveBeenCalledTimes(2);
  });

  it('should handle rejected promises', async () => {
    const error = new Error('test error');
    const mockFn = vi.fn().mockRejectedValue(error);

    const deduped = dedupe(mockFn);

    await expect(deduped('arg')).rejects.toThrow('test error');
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('should timeout and create new requests when specified', async () => {
    const timeoutDedupe = createAsyncDedupe({ timeout: 500 });
    let callCount = 0;

    const mockFn = vi.fn().mockImplementation(async () => {
      callCount++;
      // Capture the current callCount value for the closure
      const currentCall = callCount;
      return new Promise((resolve) => setTimeout(() => resolve(`result-${currentCall}`), 1000));
    });

    const deduped = timeoutDedupe(mockFn);

    // First call
    const promise1 = deduped('arg');

    // Advance time beyond timeout
    vi.advanceTimersByTime(600);

    // This should create a new request since the timeout passed
    const promise2 = deduped('arg');

    // Advance time to complete both promises
    vi.advanceTimersByTime(1000);

    const result1 = await promise1;
    const result2 = await promise2;

    // Assert that the second call executed the function again due to timeout
    expect(result1).toBe('result-1');
    expect(result2).toBe('result-2'); // The function should be called again
    expect(mockFn).toHaveBeenCalledTimes(2);
  });

  it('should isolate errors when errorSharing is disabled', async () => {
    const nonSharingDedupe = createAsyncDedupe({ errorSharing: false });

    const error = new Error('test error');
    const mockFn = vi.fn().mockRejectedValue(error);

    const deduped = nonSharingDedupe(mockFn);

    const promise1 = deduped('arg');
    const promise2 = deduped('arg');

    await expect(promise1).rejects.toThrow('test error');
    await expect(promise2).rejects.toThrow('test error');

    // The underlying function should only be called once despite separate error handling
    expect(mockFn).toHaveBeenCalledTimes(1);

    // Verify errors are different instances but have same message
    try {
      await promise1;
    } catch (error1) {
      try {
        await promise2;
      } catch (error2) {
        expect(error1).not.toBe(error2); // Different instances
        expect(error1.message).toBe(error2.message); // Same message
      }
    }
  });

  it('should abort operations when requested', async () => {
    const mockFn = vi.fn().mockImplementation(async (arg, options) => {
      const { signal } = options || {};

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => resolve('result'), 1000);

        if (signal) {
          signal.addEventListener('abort', () => {
            clearTimeout(timeout);
            reject(signal.reason);
          });
        }
      });
    });

    const deduped = dedupe(mockFn);

    const promise = deduped('arg');

    // Should be in progress now
    expect(dedupe.inProgressCount()).toBe(1);
    expect(dedupe.isInProgress(JSON.stringify(['arg']))).toBe(true);

    // Abort the operation
    dedupe.abort(JSON.stringify(['arg']));
    vi.advanceTimersByTime(1); // Allow rejection microtask to run

    await expect(promise).rejects.toThrow('Operation aborted for key');
    expect(dedupe.inProgressCount()).toBe(0);
  });

  it('should abort all operations with abortAll', async () => {
    const mockFn = vi.fn().mockImplementation(async (arg, options) => {
      const { signal } = options || {};

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => resolve('result'), 1000);

        if (signal) {
          signal.addEventListener('abort', () => {
            clearTimeout(timeout);
            reject(signal.reason);
          });
        }
      });
    });

    const deduped = dedupe(mockFn);

    const promise1 = deduped('arg1');
    const promise2 = deduped('arg2');

    expect(dedupe.inProgressCount()).toBe(2);

    // Abort all operations
    const abortedCount = dedupe.abortAll();
    vi.advanceTimersByTime(1); // Allow rejection microtasks to run

    expect(abortedCount).toBe(2);
    expect(dedupe.inProgressCount()).toBe(0);

    await expect(promise1).rejects.toThrow('Operation aborted');
    await expect(promise2).rejects.toThrow('Operation aborted');
  });

  it('should properly handle maxAge configuration', async () => {
    const agingDedupe = createAsyncDedupe({ maxAge: 500 });
    let callCount = 0;

    const mockFn = vi.fn().mockImplementation(async () => {
      callCount++;
      // Capture the current callCount value for the closure
      const currentCall = callCount;
      return new Promise((resolve) => setTimeout(() => resolve(`result-${currentCall}`), 1000));
    });

    const deduped = agingDedupe(mockFn);

    // First call
    const promise1 = deduped('arg');

    // Advance time beyond maxAge
    vi.advanceTimersByTime(600);

    // This should create a new request since maxAge passed
    const promise2 = deduped('arg');

    // Advance time to complete both promises
    vi.advanceTimersByTime(1000);

    const result1 = await promise1;
    const result2 = await promise2;

    // Assert that the second call executed the function again due to maxAge expiry
    expect(result1).toBe('result-1');
    expect(result2).toBe('result-2'); // The function should be called again
    expect(mockFn).toHaveBeenCalledTimes(2);
  });

  it('should reset all in-progress operations', async () => {
    const mockFn = vi.fn().mockImplementation((arg, options) => {
      const { signal } = options || {};

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => resolve('result'), 1000);

        if (signal) {
          signal.addEventListener('abort', () => {
            clearTimeout(timeout);
            reject(signal.reason);
          });
        }
      });
    });

    const deduped = dedupe(mockFn);

    const promise = deduped('arg');

    expect(dedupe.inProgressCount()).toBe(1);

    dedupe.reset();
    vi.advanceTimersByTime(1); // Allow rejection microtask to run

    expect(dedupe.inProgressCount()).toBe(0);
    await expect(promise).rejects.toThrow('Operation aborted due to reset');
  });

  it('should apply abort signal correctly to function arguments', async () => {
    // Test with last argument as options object
    const mockFnWithOptions = vi.fn().mockImplementation(async (arg1, options) => {
      expect(options.signal).toBeDefined();
      expect(options.existingOption).toBe('value');
      return 'result';
    });

    const dedupedWithOptions = dedupe(mockFnWithOptions);
    await dedupedWithOptions('arg', { existingOption: 'value' });
    expect(mockFnWithOptions).toHaveBeenCalledTimes(1);

    // Test with adding new options object
    const mockFnNoOptions = vi.fn().mockImplementation(async (arg1, options) => {
      expect(options.signal).toBeDefined();
      return 'result';
    });

    const dedupedNoOptions = dedupe(mockFnNoOptions);
    await dedupedNoOptions('arg');
    expect(mockFnNoOptions).toHaveBeenCalledTimes(1);
  });

  it('should handle non-error rejections', async () => {
    const mockFn = vi.fn().mockRejectedValue('string error');
    const nonSharingDedupe = createAsyncDedupe({ errorSharing: false });

    const deduped = nonSharingDedupe(mockFn);

    await expect(deduped('arg')).rejects.toThrow('string error');
  });

  it('should handle different error types correctly', async () => {
    // Test with TypeError
    const typeError = new TypeError('type error');
    const mockFnTypeError = vi.fn().mockRejectedValue(typeError);
    const dedupedTypeError = dedupe(mockFnTypeError);

    await expect(dedupedTypeError('arg')).rejects.toThrow(TypeError);
    await expect(dedupedTypeError('arg')).rejects.toThrow('type error');

    // Test with custom error properties
    const customError = new Error('custom error');
    (customError as any).customProp = 'custom value';

    const mockFnCustomError = vi.fn().mockRejectedValue(customError);
    const nonSharingDedupe = createAsyncDedupe({ errorSharing: false });
    const dedupedCustomError = nonSharingDedupe(mockFnCustomError);

    // Use expect().rejects and chain assertions
    await expect(dedupedCustomError('arg')).rejects.toSatisfy((error: any) => {
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('custom error');
      expect(error.customProp).toBe('custom value');
      return true; // Indicate the condition is met
    });
  });

  it("should handle functions that don't return promises", async () => {
    const nonPromiseFn = () => 'not a promise';
    const deduped = dedupe(nonPromiseFn as any);

    await expect(deduped('arg')).rejects.toThrow('Wrapped function did not return a Promise');
  });

  it('should handle synchronous errors in the wrapped function', async () => {
    const mockFn = vi.fn().mockImplementation(() => {
      throw new Error('sync error');
    });

    const deduped = dedupe(mockFn);

    await expect(deduped('arg')).rejects.toThrow('sync error');
    expect(dedupe.inProgressCount()).toBe(0);
  });

  it('should expose helper methods for operation status', async () => {
    const mockFn = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve('result'), 1000);
        })
    );

    const deduped = dedupe(mockFn);

    deduped('arg1');
    deduped('arg2');

    expect(dedupe.inProgressCount()).toBe(2);
    expect(dedupe.isInProgress(JSON.stringify(['arg1']))).toBe(true);
    expect(dedupe.isInProgress(JSON.stringify(['arg2']))).toBe(true);
    expect(dedupe.isInProgress(JSON.stringify(['arg3']))).toBe(false);

    const keys = dedupe.getInProgressKeys();
    expect(keys).toHaveLength(2);
    expect(keys).toContain(JSON.stringify(['arg1']));
    expect(keys).toContain(JSON.stringify(['arg2']));
  });

  it('should respect keyPrefix option', async () => {
    const prefixedDedupe = createAsyncDedupe({ keyPrefix: 'test' });
    const mockFn = vi.fn().mockResolvedValue('result');

    const deduped = prefixedDedupe(mockFn);

    await deduped('arg');

    // Since the promise resolves immediately, we need to check if it was in progress
    expect(prefixedDedupe.inProgressCount()).toBe(0);

    // Make a call that doesn't resolve immediately
    const slowMockFn = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve('result'), 1000);
        })
    );

    const slowDeduped = prefixedDedupe(slowMockFn);
    slowDeduped('slow-arg');

    const keys = prefixedDedupe.getInProgressKeys();
    expect(keys[0].startsWith('test:')).toBe(true);
  });

  it('should properly cleanup after promise resolution', async () => {
    const mockFn = vi.fn().mockResolvedValue('result');
    const deduped = dedupe(mockFn);

    await deduped('arg');

    expect(dedupe.inProgressCount()).toBe(0);
    expect(dedupe.isInProgress(JSON.stringify(['arg']))).toBe(false);
  });

  it('should properly cleanup after promise rejection', async () => {
    const mockFn = vi.fn().mockRejectedValue(new Error('test error'));
    const deduped = dedupe(mockFn);

    try {
      await deduped('arg');
    } catch (error) {
      // Expected error
    }

    expect(dedupe.inProgressCount()).toBe(0);
    expect(dedupe.isInProgress(JSON.stringify(['arg']))).toBe(false);
  });
});

describe('README Examples', () => {
  const dedupe = createAsyncDedupe({
    timeout: 5000,
    errorSharing: true,
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    dedupe.reset();
  });

  it('should work with the API call example', async () => {
    const mockFetch = vi.fn();
    const originalFetch = global.fetch;
    (global as any).fetch = mockFetch;

    mockFetch.mockImplementation(async (url: string) => ({
      json: () => Promise.resolve({ id: url.split('/').pop(), name: 'Test User' }),
    }));

    const fetchUserData = dedupe(async (userId: string) => {
      const response = await fetch(`/api/users/${userId}`);
      return response.json();
    });

    // Start multiple simultaneous calls
    const [user1Promise, user2Promise] = await Promise.all([
      fetchUserData('123'),
      fetchUserData('123'),
    ]);

    expect(mockFetch).toHaveBeenCalledTimes(1); // Only one actual fetch
    expect(mockFetch).toHaveBeenCalledWith('/api/users/123');

    const [user1, user2] = await Promise.all([user1Promise, user2Promise]);
    expect(user1).toEqual({ id: '123', name: 'Test User' });
    expect(user2).toEqual({ id: '123', name: 'Test User' });

    // Verify in-progress operations tracking
    expect(dedupe.inProgressCount()).toBe(0); // Should be completed
    expect(dedupe.isInProgress(JSON.stringify(['123']))).toBe(false);

    // Different ID should trigger new fetch
    const user3 = await fetchUserData('456');
    expect(mockFetch).toHaveBeenCalledTimes(2); // New fetch for different ID
    expect(user3).toEqual({ id: '456', name: 'Test User' });

    // Test error sharing
    mockFetch.mockRejectedValueOnce(new Error('API Error'));
    const error1Promise = fetchUserData('789');
    const error2Promise = fetchUserData('789');

    await expect(error1Promise).rejects.toThrow('API Error');
    await expect(error2Promise).rejects.toThrow('API Error');
    expect(mockFetch).toHaveBeenCalledTimes(3); // Only one failed call

    // Restore fetch
    (global as any).fetch = originalFetch;
  });
});
