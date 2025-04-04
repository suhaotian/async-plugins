import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAsyncPoller, PollError, type PollOptions, type AsyncPoller } from '../src/poll'; // Update with actual path

describe('AsyncPoller', () => {
  // Mock timers for predictable testing
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Basic functionality', () => {
    it('should resolve with the result when shouldContinue returns false', async () => {
      const mockFn = vi.fn().mockResolvedValue('success');
      const poller = createAsyncPoller(mockFn, {
        interval: 100,
        shouldContinue: () => false,
      });

      const promise = poller.start();
      await vi.runAllTimersAsync();

      const result = await promise;
      expect(result).toBe('success');
      expect(mockFn).toHaveBeenCalledTimes(1);
      expect(poller.isPolling()).toBe(false);
      expect(poller.currentAttempt()).toBe(1);
    });

    it('should poll multiple times until condition is met', async () => {
      const mockFn = vi
        .fn()
        .mockResolvedValueOnce('attempt1')
        .mockResolvedValueOnce('attempt2')
        .mockResolvedValue('final');

      const shouldContinue = vi
        .fn()
        .mockReturnValueOnce(true) // Continue after first attempt
        .mockReturnValueOnce(true) // Continue after second attempt
        .mockReturnValue(false); // Stop after third attempt

      const poller = createAsyncPoller(mockFn, {
        interval: 200,
        shouldContinue,
      });

      const promise = poller.start();

      // Run first timer cycle
      await vi.advanceTimersByTimeAsync(1);
      expect(mockFn).toHaveBeenCalledTimes(1);

      // Second attempt
      await vi.advanceTimersByTimeAsync(200);
      expect(mockFn).toHaveBeenCalledTimes(2);

      // Final attempt
      await vi.advanceTimersByTimeAsync(200);
      expect(mockFn).toHaveBeenCalledTimes(3);

      const result = await promise;
      expect(result).toBe('final');
      expect(shouldContinue).toHaveBeenCalledTimes(3);
      expect(poller.currentAttempt()).toBe(3);
      expect(poller.isPolling()).toBe(false);
    });
  });

  describe('Backoff strategies', () => {
    it('should use fixed backoff correctly', async () => {
      const mockFn = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValue(3);

      const shouldContinue = vi
        .fn()
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true)
        .mockReturnValue(false);

      const poller = createAsyncPoller(mockFn, {
        interval: 100,
        shouldContinue,
        backoff: { type: 'fixed' },
      });

      const promise = poller.start();

      // First attempt happens immediately
      await vi.advanceTimersByTimeAsync(1);
      expect(mockFn).toHaveBeenCalledTimes(1);

      // Fixed interval for second attempt
      await vi.advanceTimersByTimeAsync(100);
      expect(mockFn).toHaveBeenCalledTimes(2);

      // Fixed interval for third attempt
      await vi.advanceTimersByTimeAsync(100);
      expect(mockFn).toHaveBeenCalledTimes(3);

      await promise;
      expect(poller.isPolling()).toBe(false);
    });

    it('should use linear backoff correctly', async () => {
      const mockFn = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValue(3);

      const shouldContinue = vi
        .fn()
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true)
        .mockReturnValue(false);

      // Mock Math.random for predictable jitter
      const randomMock = vi.spyOn(Math, 'random').mockReturnValue(0.5);

      const poller = createAsyncPoller(mockFn, {
        interval: 100,
        shouldContinue,
        backoff: {
          type: 'linear',
          factor: 2,
          jitter: true,
        },
      });

      const promise = poller.start();

      // First attempt happens immediately
      await vi.advanceTimersByTimeAsync(1);
      expect(mockFn).toHaveBeenCalledTimes(1);

      // Linear backoff: 100 + 100 * (2-1) * 1 = 200 (for attempt 2)
      // With jitter at 0.5: 200 + (200*0.15*2-200*0.15) = 200 + 0 = 200
      await vi.advanceTimersByTimeAsync(200);
      expect(mockFn).toHaveBeenCalledTimes(2);

      // Linear backoff: 100 + 100 * (2-1) * 2 = 300 (for attempt 3)
      // With jitter at 0.5: 300 + (300*0.15*2-300*0.15) = 300 + 0 = 300
      await vi.advanceTimersByTimeAsync(300);
      expect(mockFn).toHaveBeenCalledTimes(3);

      await promise;
      expect(poller.isPolling()).toBe(false);

      randomMock.mockRestore();
    });

    it('should use exponential backoff with maxInterval correctly', async () => {
      const mockFn = vi
        .fn()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(3)
        .mockResolvedValue(4);

      const shouldContinue = vi
        .fn()
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true)
        .mockReturnValue(false);

      const poller = createAsyncPoller(mockFn, {
        interval: 100,
        shouldContinue,
        backoff: {
          type: 'exponential',
          factor: 2,
          maxInterval: 300,
        },
      });

      const promise = poller.start();

      // First attempt happens immediately
      await vi.advanceTimersByTimeAsync(1);
      expect(mockFn).toHaveBeenCalledTimes(1);

      // Exponential: 100 * 2^1 = 200
      await vi.advanceTimersByTimeAsync(200);
      expect(mockFn).toHaveBeenCalledTimes(2);

      // Exponential: 100 * 2^2 = 400, but capped at 300
      await vi.advanceTimersByTimeAsync(300);
      expect(mockFn).toHaveBeenCalledTimes(3);

      // Still capped at maxInterval: 300
      await vi.advanceTimersByTimeAsync(300);
      expect(mockFn).toHaveBeenCalledTimes(4);

      await promise;
      expect(poller.isPolling()).toBe(false);
    });
  });

  describe('Error handling', () => {
    it('should stop polling on error by default', async () => {
      const mockFn = vi
        .fn()
        .mockResolvedValueOnce('first')
        .mockRejectedValueOnce(new Error('Test error'));

      const poller = createAsyncPoller(mockFn, {
        interval: 100,
        shouldContinue: () => true,
      });

      const promise = poller.start();

      // Run first attempt successfully
      await vi.advanceTimersByTimeAsync(1);
      expect(mockFn).toHaveBeenCalledTimes(1);

      // Second attempt with error
      await vi.advanceTimersByTimeAsync(100);
      expect(mockFn).toHaveBeenCalledTimes(2);

      await expect(promise).rejects.toThrow(PollError);
      await expect(promise).rejects.toMatchObject({
        name: 'PollError',
        attempt: 2,
        cause: expect.objectContaining({ message: 'Test error' }),
      });

      expect(poller.isPolling()).toBe(false);
    });

    it('should continue polling after error when onError returns true', async () => {
      const mockFn = vi
        .fn()
        .mockResolvedValueOnce('first')
        .mockRejectedValueOnce(new Error('Temporary error'))
        .mockResolvedValue('success');

      const onError = vi.fn().mockReturnValue(true);
      const shouldContinue = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);

      const poller = createAsyncPoller(mockFn, {
        interval: 100,
        shouldContinue,
        onError,
      });

      const promise = poller.start();

      // First attempt
      await vi.advanceTimersByTimeAsync(1);
      expect(mockFn).toHaveBeenCalledTimes(1);

      // Second attempt with error
      await vi.advanceTimersByTimeAsync(100);
      expect(mockFn).toHaveBeenCalledTimes(2);
      expect(onError).toHaveBeenCalledWith(expect.any(Error), 2);

      // Third attempt succeeds
      await vi.advanceTimersByTimeAsync(100);
      expect(mockFn).toHaveBeenCalledTimes(3);

      const result = await promise;
      expect(result).toBe('success');
      expect(poller.isPolling()).toBe(false);
    });
  });

  describe('Maximum attempts', () => {
    it('should stop after maxAttempts is reached', async () => {
      const mockFn = vi.fn().mockResolvedValue('still running');
      const shouldContinue = vi.fn().mockReturnValue(true);

      const poller = createAsyncPoller(mockFn, {
        interval: 10, // Use a shorter interval for faster test execution
        maxAttempts: 3,
        shouldContinue,
      });

      const promise = poller.start();

      // Run all attempts
      await vi.runAllTimersAsync();

      await expect(promise).rejects.toThrow('Polling reached maximum attempts (3)');
      expect(mockFn).toHaveBeenCalledTimes(3);
      expect(poller.isPolling()).toBe(false);
    });
  });

  describe('Progress tracking', () => {
    it('should call onProgress with intermediate results', async () => {
      const mockFn = vi
        .fn()
        .mockResolvedValueOnce('progress1')
        .mockResolvedValueOnce('progress2')
        .mockResolvedValue('final');

      const onProgress = vi.fn();
      const shouldContinue = vi
        .fn()
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true)
        .mockReturnValue(false);

      const poller = createAsyncPoller(mockFn, {
        interval: 100,
        shouldContinue,
        onProgress,
      });

      const promise = poller.start();

      // Run all attempts
      await vi.advanceTimersByTimeAsync(1);
      expect(onProgress).toHaveBeenCalledWith('progress1', 1);

      await vi.advanceTimersByTimeAsync(100);
      expect(onProgress).toHaveBeenCalledWith('progress2', 2);

      await vi.advanceTimersByTimeAsync(100);
      expect(onProgress).toHaveBeenCalledWith('final', 3);

      await promise;
      expect(onProgress).toHaveBeenCalledTimes(3);
    });
  });

  describe('Abort control', () => {
    it('should abort polling when AbortSignal is triggered', async () => {
      const mockFn = vi.fn().mockResolvedValue('running');
      const shouldContinue = vi.fn().mockReturnValue(true);

      const abortController = new AbortController();

      const poller = createAsyncPoller(mockFn, {
        interval: 100,
        shouldContinue,
        abortSignal: abortController.signal,
      });

      const promise = poller.start();

      // First attempt
      await vi.advanceTimersByTimeAsync(1);
      expect(mockFn).toHaveBeenCalledTimes(1);

      // Abort before second attempt
      abortController.abort();

      // Should not make another attempt
      await vi.advanceTimersByTimeAsync(100);
      expect(mockFn).toHaveBeenCalledTimes(1);

      await expect(promise).rejects.toThrow(PollError);
      await expect(promise).rejects.toMatchObject({
        message: 'Polling operation aborted',
        attempt: 1,
      });

      expect(poller.isPolling()).toBe(false);
    });

    it('should not start if already aborted', async () => {
      const mockFn = vi.fn().mockResolvedValue('running');

      const abortController = new AbortController();
      abortController.abort();

      const poller = createAsyncPoller(mockFn, {
        interval: 100,
        abortSignal: abortController.signal,
      });

      await expect(() => poller.start()).rejects.toThrow('Polling operation aborted');
      expect(mockFn).not.toHaveBeenCalled();
      expect(poller.isPolling()).toBe(false);
    });
  });

  describe('Control methods', () => {
    it('should stop polling when stop() is called', async () => {
      const mockFn = vi.fn().mockResolvedValue('running');
      const shouldContinue = vi.fn().mockReturnValue(true);

      const poller = createAsyncPoller(mockFn, {
        interval: 1000,
        shouldContinue,
      });

      const promise = poller.start();

      // First attempt
      await vi.advanceTimersByTimeAsync(1);
      expect(mockFn).toHaveBeenCalledTimes(1);
      expect(poller.isPolling()).toBe(true);

      // Stop polling
      poller.stop();
      expect(poller.isPolling()).toBe(false);

      // Should not make another attempt
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockFn).toHaveBeenCalledTimes(1);

      await expect(promise).rejects.toThrow(PollError);
      await expect(promise).rejects.toMatchObject({
        message: 'Polling stopped',
        attempt: 1,
      });
    });

    it('should report current attempt count correctly', async () => {
      const mockFn = vi
        .fn()
        .mockResolvedValueOnce('first')
        .mockResolvedValueOnce('second')
        .mockResolvedValue('final');

      const shouldContinue = vi
        .fn()
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true)
        .mockReturnValue(false);

      const poller = createAsyncPoller(mockFn, {
        interval: 100,
        shouldContinue,
      });

      const promise = poller.start();

      expect(poller.currentAttempt()).toBe(0);

      await vi.advanceTimersByTimeAsync(1);
      expect(poller.currentAttempt()).toBe(1);

      await vi.advanceTimersByTimeAsync(100);
      expect(poller.currentAttempt()).toBe(2);

      await vi.advanceTimersByTimeAsync(100);
      expect(poller.currentAttempt()).toBe(3);

      await promise;
    });

    it('should change interval during polling', async () => {
      const mockFn = vi
        .fn()
        .mockResolvedValueOnce('first')
        .mockResolvedValueOnce('second')
        .mockResolvedValue('final');

      const shouldContinue = vi
        .fn()
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true)
        .mockReturnValue(false);

      const poller = createAsyncPoller(mockFn, {
        interval: 1000,
        shouldContinue,
      });

      const promise = poller.start();

      // First attempt
      await vi.advanceTimersByTimeAsync(1);
      expect(mockFn).toHaveBeenCalledTimes(1);

      // Change to a shorter interval
      poller.changeInterval(100);

      // Should trigger at the new interval
      await vi.advanceTimersByTimeAsync(100);
      expect(mockFn).toHaveBeenCalledTimes(2);

      // Final attempt at the new interval
      await vi.advanceTimersByTimeAsync(100);
      expect(mockFn).toHaveBeenCalledTimes(3);

      await promise;
    });

    it('should supersede previous polling operation when start() is called multiple times', async () => {
      const mockFn = vi.fn().mockResolvedValue('result');

      const poller = createAsyncPoller(mockFn, {
        interval: 100,
        shouldContinue: () => true,
      });

      // Start first polling operation
      const promise1 = poller.start();

      // Run first attempt
      await vi.advanceTimersByTimeAsync(1);
      expect(mockFn).toHaveBeenCalledTimes(1);

      // Start second polling operation
      const promise2 = poller.start();

      // The first promise should be rejected
      await expect(promise1).rejects.toThrow('Previous polling operation superseded');

      // First attempt of second operation
      await vi.advanceTimersByTimeAsync(1);
      expect(mockFn).toHaveBeenCalledTimes(2);

      // Stop and verify second operation is running
      poller.stop();
      expect(poller.isPolling()).toBe(false);

      await expect(promise2).rejects.toThrow('Polling stopped');
    });

    it('should handle consecutive start() calls with proper cleanup', async () => {
      const mockFn = vi.fn().mockResolvedValue('result');
      const shouldContinue = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);

      const poller = createAsyncPoller(mockFn, {
        interval: 100,
        shouldContinue,
      });

      // First polling operation - will be stopped
      const promise1 = poller.start();
      await vi.advanceTimersByTimeAsync(1);
      poller.stop();
      await expect(promise1).rejects.toThrow('Polling stopped');

      // Second polling operation - should complete normally
      const promise2 = poller.start();
      await vi.advanceTimersByTimeAsync(1);
      const result = await promise2;
      expect(result).toBe('result');
      expect(poller.isPolling()).toBe(false);

      // Third polling operation - should also work normally
      const promise3 = poller.start();
      await vi.advanceTimersByTimeAsync(1);
      const result2 = await promise3;
      expect(result2).toBe('result');
      expect(poller.isPolling()).toBe(false);
    });
  });
});
