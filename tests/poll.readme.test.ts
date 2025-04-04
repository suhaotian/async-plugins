import { createAsyncPoller, PollError } from '../src/poll'; // Adjust the import path as needed
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Optionally, you can also terminate the process:
  // process.exit(1);
});

describe('AsyncPoller', () => {
  // Mock the global fetch and timers
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  it('should resolve when job completes successfully', async () => {
    // Mock fetch to simulate a job that completes after 3 attempts
    const mockResponses = [
      { status: 'running', progress: 30 },
      { status: 'running', progress: 60 },
      { status: 'completed', progress: 100 },
    ];

    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      const response = mockResponses[callCount];
      callCount++;
      return Promise.resolve({
        json: () => Promise.resolve(response),
      });
    });

    const onProgressSpy = vi.fn();

    const pollJobStatus = createAsyncPoller(
      async () => {
        const response = await fetch('/api/job/123');
        return response.json();
      },
      {
        interval: 1000,
        maxAttempts: 30,
        backoff: {
          type: 'exponential',
          factor: 2,
          maxInterval: 30000,
          jitter: true,
        },
        shouldContinue: (result) => result.status === 'running',
        onProgress: onProgressSpy,
      }
    );

    // Start polling
    const resultPromise = pollJobStatus.start();

    // Fast-forward time to trigger the poll attempts
    await vi.runOnlyPendingTimersAsync(); // First attempt
    await vi.runOnlyPendingTimersAsync(); // Second attempt
    await vi.runOnlyPendingTimersAsync(); // Third attempt

    // Get the final result
    const finalResult = await resultPromise;

    // Verify the result
    expect(finalResult).toEqual({ status: 'completed', progress: 100 });

    // Verify that fetch was called 3 times
    expect(fetch).toHaveBeenCalledTimes(3);

    // Verify onProgress was called for each attempt
    expect(onProgressSpy).toHaveBeenCalledTimes(3);
    expect(onProgressSpy).toHaveBeenCalledWith(mockResponses[0], 1);
    expect(onProgressSpy).toHaveBeenCalledWith(mockResponses[1], 2);
    expect(onProgressSpy).toHaveBeenCalledWith(mockResponses[2], 3);
  });

  it('should handle errors with onError callback', async () => {
    // Mock fetch to simulate errors followed by success
    const mockError = new Error('API error');
    const mockResponses = [
      { error: mockError },
      { error: mockError },
      { data: { status: 'completed', progress: 100 } },
    ];

    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      const response = mockResponses[callCount];
      callCount++;

      if ('error' in response) {
        return Promise.reject(response.error);
      }

      return Promise.resolve({
        json: () => Promise.resolve(response.data),
      });
    });

    const onErrorSpy = vi.fn().mockReturnValue(true); // Continue polling

    const pollJobStatus = createAsyncPoller(
      async () => {
        const response = await fetch('/api/job/123');
        return response.json();
      },
      {
        interval: 1000,
        maxAttempts: 5,
        onError: onErrorSpy,
      }
    );

    // Start polling
    const resultPromise = pollJobStatus.start();

    // Fast-forward time to trigger the poll attempts
    await vi.runOnlyPendingTimersAsync(); // First attempt (error)
    await vi.runOnlyPendingTimersAsync(); // Second attempt (error)
    await vi.runOnlyPendingTimersAsync(); // Third attempt (success)

    // Get the final result
    const finalResult = await resultPromise;

    // Verify the result
    expect(finalResult).toEqual({ status: 'completed', progress: 100 });

    // Verify onError was called for the failed attempts
    expect(onErrorSpy).toHaveBeenCalledTimes(2);
    expect(onErrorSpy).toHaveBeenCalledWith(mockError, 1);
    expect(onErrorSpy).toHaveBeenCalledWith(mockError, 2);
  });

  it('should respect maxAttempts and throw PollError', async () => {
    // Mock fetch to always return 'running' status
    global.fetch = vi.fn().mockImplementation(() => {
      return Promise.resolve({
        json: () => Promise.resolve({ status: 'running', progress: 50 }),
      });
    });

    const pollJobStatus = createAsyncPoller(
      async () => {
        const response = await fetch('/api/job/123');
        return response.json();
      },
      {
        interval: 1000,
        maxAttempts: 3, // Only try 3 times
        shouldContinue: () => true, // Always continue polling
      }
    );

    // Start polling - don't await the result yet
    const resultPromise = pollJobStatus.start();

    // Use runAllTimersAsync to run all pending timers until there are none left
    // or we hit maxAttempts
    await vi.advanceTimersByTimeAsync(5000); // Advance enough time to cover all attempts

    // Now await the promise which should reject
    await expect(resultPromise).rejects.toBeInstanceOf(PollError);
    await expect(resultPromise).rejects.toMatchObject({
      name: 'PollError',
      attempt: 3,
      message: expect.stringContaining('maximum attempts'),
    });

    // Verify that fetch was called exactly 3 times
    expect(fetch).toHaveBeenCalledTimes(3);
  }, 20000); // Increase timeout for this test

  it('should handle manual stopping of polling', async () => {
    // Mock fetch
    global.fetch = vi.fn().mockImplementation(() => {
      return Promise.resolve({
        json: () => Promise.resolve({ status: 'running', progress: 25 }),
      });
    });

    const pollJobStatus = createAsyncPoller(
      async () => {
        const response = await fetch('/api/job/123');
        return response.json();
      },
      {
        interval: 1000,
        shouldContinue: () => true, // Always continue polling
      }
    );

    // Start polling
    const resultPromise = pollJobStatus.start();

    // Run first attempt
    await vi.runOnlyPendingTimersAsync();

    // Stop polling manually
    pollJobStatus.stop();

    // Expect the promise to reject with PollError
    await expect(resultPromise).rejects.toBeInstanceOf(PollError);
    await expect(resultPromise).rejects.toMatchObject({
      message: 'Polling stopped',
      attempt: 1,
    });

    // Advance timers to ensure no more polling happens
    await vi.runAllTimersAsync();

    // Verify that fetch was called only once
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('should respect AbortSignal to cancel polling', async () => {
    // Mock fetch
    global.fetch = vi.fn().mockImplementation(() => {
      return Promise.resolve({
        json: () => Promise.resolve({ status: 'running', progress: 25 }),
      });
    });

    // Create an AbortController
    const abortController = new AbortController();

    const pollJobStatus = createAsyncPoller(
      async () => {
        const response = await fetch('/api/job/123');
        return response.json();
      },
      {
        interval: 1000,
        shouldContinue: () => true, // Always continue polling
        abortSignal: abortController.signal,
      }
    );

    // Start polling
    const resultPromise = pollJobStatus.start();

    // Run first attempt
    await vi.runOnlyPendingTimersAsync();

    // Abort the polling
    abortController.abort();

    // Expect the promise to reject with PollError
    await expect(resultPromise).rejects.toBeInstanceOf(PollError);
    await expect(resultPromise).rejects.toMatchObject({
      message: expect.stringContaining('aborted'),
      attempt: 1,
    });
  });

  it('should use backoff strategy correctly', async () => {
    // Mock fetch to always return 'running' status
    global.fetch = vi.fn().mockImplementation(() => {
      return Promise.resolve({
        json: () => Promise.resolve({ status: 'running', progress: 50 }),
      });
    });

    // Mock the setTimeout to track calls without actually waiting
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

    // Create a poller with exponential backoff
    const pollJobStatus = createAsyncPoller(
      async () => {
        const response = await fetch('/api/job/123');
        return response.json();
      },
      {
        interval: 1000,
        maxAttempts: 4,
        backoff: {
          type: 'exponential',
          factor: 2,
          jitter: false, // Disable jitter for predictable intervals
        },
        shouldContinue: () => true, // Always continue polling
      }
    );

    // Start polling but don't await yet
    pollJobStatus.start();

    // Run initial setTimeout (which is the immediate execution)
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);

    // After first execution, should schedule next attempt at 2000ms (1000 * 2^1)
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(2);

    // After second execution, should schedule next attempt at 4000ms (1000 * 2^2)
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetch).toHaveBeenCalledTimes(3);

    // After third execution, should schedule next attempt at 8000ms (1000 * 2^3)
    await vi.advanceTimersByTimeAsync(8000);
    expect(fetch).toHaveBeenCalledTimes(4);

    // Clean up - stop polling
    pollJobStatus.stop();
  }, 20000); // Increase timeout for this test

  it('should update interval with changeInterval method', async () => {
    // Mock fetch to always return 'running' status
    global.fetch = vi.fn().mockImplementation(() => {
      return Promise.resolve({
        json: () => Promise.resolve({ status: 'running', progress: 50 }),
      });
    });

    // Create a poller
    const pollJobStatus = createAsyncPoller(
      async () => {
        const response = await fetch('/api/job/123');
        return response.json();
      },
      {
        interval: 1000,
        shouldContinue: () => true, // Always continue polling
      }
    );

    // Spy on setTimeout
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

    // Start polling
    pollJobStatus.start().catch((e) => {
      console.log('pollJobStatus.start() error:', e);
    });

    // Clear initial calls to setTimeout
    setTimeoutSpy.mockClear();

    // Run first attempt
    await vi.runOnlyPendingTimersAsync();

    // Change the interval
    pollJobStatus.changeInterval(2000);

    // Ensure the poll loop continues (triggering setTimeout with new interval)
    await vi.runOnlyPendingTimersAsync();

    // Verify that setTimeout was called with the new interval
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2000);

    // Stop polling to clean up
    pollJobStatus.stop();
  });
});
