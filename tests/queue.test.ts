// queue.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAsyncQueue, QueueOptions } from '../src/queue'; // Adjust path if needed

// Helper function for creating delayed tasks
const createTask = <T>(duration: number, value: T, shouldReject = false): (() => Promise<T>) => {
  return () =>
    new Promise<T>((resolve, reject) => {
      setTimeout(() => {
        if (shouldReject) {
          // console.log(`Task rejecting after ${duration}ms with value: ${value}`);
          reject(new Error(`Task failed with value: ${value}`));
        } else {
          // console.log(`Task resolving after ${duration}ms with value: ${value}`);
          resolve(value);
        }
      }, duration);
    });
};

// Helper delay function
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('createAsyncQueue', () => {
  beforeEach(() => {
    // Ensure we use real timers unless explicitly stated otherwise in a test
    vi.useRealTimers();
  });

  afterEach(() => {
    // Restore mocks and timers after each test
    vi.restoreAllMocks();
  });

  it('should create a queue with default options', () => {
    const queue = createAsyncQueue();
    expect(queue.isPaused()).toBe(false); // autoStart defaults to true
    expect(queue.stats().active).toBe(0);
    expect(queue.stats().pending).toBe(0);
    // Default concurrency is 1 - difficult to assert directly without adding tasks
  });

  it('should respect autoStart: false option', () => {
    const queue = createAsyncQueue({ autoStart: false });
    expect(queue.isPaused()).toBe(true);
  });

  it('should process a single task', async () => {
    const queue = createAsyncQueue();
    const task = createTask(10, 'task1');
    const promise = queue.add(task);

    expect(queue.size()).toBe(0); // Task moves immediately to active (concurrency 1)
    expect(queue.activeCount()).toBe(1);
    expect(queue.stats().pending).toBe(0);
    expect(queue.stats().active).toBe(1);
    expect(queue.stats().total).toBe(1);

    const result = await promise;

    expect(result).toBe('task1');
    expect(queue.size()).toBe(0);
    expect(queue.activeCount()).toBe(0);
    expect(queue.isIdle()).toBe(true);
    expect(queue.stats().completed).toBe(1);
    expect(queue.stats().active).toBe(0);
    expect(queue.stats().total).toBe(1);
  });

  it('should process tasks sequentially with concurrency 1', async () => {
    const queue = createAsyncQueue({ concurrency: 1 });
    const executionOrder: string[] = [];

    const task1 = () => delay(20).then(() => executionOrder.push('task1'));
    const task2 = () => delay(10).then(() => executionOrder.push('task2'));

    const p1 = queue.add(task1);
    const p2 = queue.add(task2);

    expect(queue.size()).toBe(1); // task2 is pending
    expect(queue.activeCount()).toBe(1); // task1 is active

    await Promise.all([p1, p2]);

    expect(executionOrder).toEqual(['task1', 'task2']);
    expect(queue.isIdle()).toBe(true);
    expect(queue.stats().completed).toBe(2);
  });

  it('should process tasks concurrently', async () => {
    vi.useFakeTimers();
    const queue = createAsyncQueue({ concurrency: 2 });
    const runningTasks = vi.fn();
    let maxConcurrent = 0;

    const task = (id: number, duration: number) => async () => {
      runningTasks(id, 'start');
      maxConcurrent = Math.max(maxConcurrent, queue.activeCount());
      await vi.advanceTimersByTimeAsync(duration); // Use async timer advancement
      runningTasks(id, 'end');
      return id;
    };

    const promises = [
      queue.add(task(1, 50)),
      queue.add(task(2, 50)),
      queue.add(task(3, 50)),
      queue.add(task(4, 50)),
    ];

    expect(queue.activeCount()).toBe(2);
    expect(queue.size()).toBe(2);

    // Allow first two tasks to finish
    await vi.advanceTimersByTimeAsync(50);
    // Check results of first two promises (they should resolve now)
    await expect(promises[0]).resolves.toBe(1);
    await expect(promises[1]).resolves.toBe(2);

    // By now, the next two should have started
    expect(queue.activeCount()).toBe(2); // 3 and 4 running
    expect(queue.size()).toBe(0);

    // Allow last two tasks to finish
    await vi.advanceTimersByTimeAsync(50);
    await expect(promises[2]).resolves.toBe(3);
    await expect(promises[3]).resolves.toBe(4);

    expect(queue.isIdle()).toBe(true);
    expect(maxConcurrent).toBe(2); // Check concurrency limit was respected
    expect(runningTasks).toHaveBeenCalledTimes(8); // start/end for 4 tasks
    expect(queue.stats().completed).toBe(4);

    vi.useRealTimers(); // Restore real timers
  });

  it('should respect priorities', async () => {
    const queue = createAsyncQueue({ concurrency: 1 });
    const executionOrder: string[] = [];

    const task = (id: string, duration: number) => () =>
      delay(duration).then(() => executionOrder.push(id));

    // Add tasks out of priority order
    const p1 = queue.add(task('low_1', 10), 0);
    const p2 = queue.add(task('high_1', 10), 10);
    const p3 = queue.add(task('medium_1', 10), 5);
    const p4 = queue.add(task('high_2', 10), 10);

    expect(queue.size()).toBe(3); // low_1 is running

    await Promise.all([p1, p2, p3, p4]);

    expect(executionOrder).toEqual(['low_1', 'high_1', 'high_2', 'medium_1']); // low_1 started first, then highest prio
    expect(queue.isIdle()).toBe(true);
  });

  it('should handle addAll correctly', async () => {
    const queue = createAsyncQueue({ concurrency: 2 });
    const tasks = [createTask(10, 'a'), createTask(10, 'b'), createTask(10, 'c')];

    const resultsPromise = queue.addAll(tasks);
    expect(queue.activeCount()).toBe(2);
    expect(queue.size()).toBe(1);
    expect(queue.stats().pending).toBe(1);
    expect(queue.stats().active).toBe(2);
    expect(queue.stats().total).toBe(3);

    const results = await resultsPromise;

    expect(results).toEqual(['a', 'b', 'c']);
    expect(queue.isIdle()).toBe(true);
    expect(queue.stats().completed).toBe(3);
  });

  it('should handle addAll with an empty array', async () => {
    const queue = createAsyncQueue();
    const resultsPromise = queue.addAll([]);
    const results = await resultsPromise;
    expect(results).toEqual([]);
    expect(queue.isIdle()).toBe(true);
    expect(queue.stats().total).toBe(0);
  });

  it('should pause and resume', async () => {
    vi.useFakeTimers();
    const queue = createAsyncQueue({ concurrency: 1 });
    const task1Spy = vi.fn();
    const task2Spy = vi.fn();

    const p1 = queue.add(() => delay(10).then(task1Spy));
    queue.pause();
    expect(queue.isPaused()).toBe(true);

    const p2 = queue.add(() => delay(10).then(task2Spy)); // Added while paused

    expect(queue.activeCount()).toBe(1); // task1 should still be running
    expect(queue.size()).toBe(1); // task2 is pending

    // Advance time, task1 finishes but task2 doesn't start
    await vi.advanceTimersByTimeAsync(15);
    await p1; // ensure p1 promise is resolved
    expect(task1Spy).toHaveBeenCalledTimes(1);
    expect(task2Spy).not.toHaveBeenCalled();
    expect(queue.activeCount()).toBe(0);
    expect(queue.size()).toBe(1); // task2 still pending
    expect(queue.isPaused()).toBe(true);

    queue.resume();
    expect(queue.isPaused()).toBe(false);
    expect(queue.activeCount()).toBe(1); // task2 should start now
    expect(queue.size()).toBe(0);

    // Advance time for task2 to finish
    await vi.advanceTimersByTimeAsync(15);
    await p2; // ensure p2 promise is resolved
    expect(task2Spy).toHaveBeenCalledTimes(1);
    expect(queue.isIdle()).toBe(true);

    vi.useRealTimers();
  });

  it('should clear pending tasks', async () => {
    const queue = createAsyncQueue({ concurrency: 1 });
    const task1Spy = vi.fn();
    const task2Spy = vi.fn();

    const p1 = queue.add(() => delay(50).then(task1Spy)); // Starts running
    const p2 = queue.add(() => delay(10).then(task2Spy)); // Pending

    expect(queue.activeCount()).toBe(1);
    expect(queue.size()).toBe(1);

    queue.clear();

    expect(queue.size()).toBe(0);
    expect(queue.stats().pending).toBe(0);
    // Active task continues running
    expect(queue.activeCount()).toBe(1);
    expect(queue.isEmpty()).toBe(true); // isEmpty refers to pending queue

    // p2 should be rejected
    await expect(p2).rejects.toThrow('Queue cleared');
    expect(task2Spy).not.toHaveBeenCalled();

    // p1 should eventually complete
    await p1;
    expect(task1Spy).toHaveBeenCalledTimes(1);
    expect(queue.activeCount()).toBe(0);
    expect(queue.isIdle()).toBe(true); // Now idle after active task finishes
  });

  it('should handle task errors and call onError', async () => {
    const errorSpy = vi.fn();
    const queue = createAsyncQueue({
      onError: (error, task) => {
        errorSpy(error.message, typeof task); // Basic check
      },
    });

    const failingTask = createTask(10, 'fail', true);
    const succeedingTask = createTask(10, 'success');

    const pFail = queue.add(failingTask);
    const pSuccess = queue.add(succeedingTask);

    await expect(pFail).rejects.toThrow('Task failed with value: fail');

    // Wait for onError callback if it's async (it's not here, but good practice)
    await delay(1); // Give microtask queue a chance to run callback
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('Task failed with value: fail', 'function');

    // The queue should continue processing other tasks
    await expect(pSuccess).resolves.toBe('success');

    expect(queue.isIdle()).toBe(true);
    expect(queue.stats().completed).toBe(1);
    expect(queue.stats().errors).toBe(1);
    expect(queue.stats().total).toBe(2);
  });

  it('should ignore errors in onError callback', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const queue = createAsyncQueue({
      onError: () => {
        throw new Error('Error inside onError');
      },
    });

    const failingTask = createTask(10, 'fail', true);
    await expect(queue.add(failingTask)).rejects.toThrow('Task failed with value: fail');

    // Wait briefly for potential async operations within queue logic
    await delay(1);

    expect(consoleErrorSpy).toHaveBeenCalledWith('Error in onError callback:', expect.any(Error));
    expect(queue.stats().errors).toBe(1);
    expect(queue.isIdle()).toBe(true); // Queue should still become idle

    consoleErrorSpy.mockRestore();
  });

  it('should resolve onEmpty promise when cleared', async () => {
    const queue = createAsyncQueue({ concurrency: 1 });
    const onEmptySpy = vi.fn();

    queue.add(createTask(50, 'a')); // Running task
    const p2 = queue.add(createTask(10, 'b')); // Pending task
    const onEmptyPromise = queue.onEmpty().then(onEmptySpy);

    expect(onEmptySpy).not.toHaveBeenCalled();

    queue.clear(); // Clears pending task 'b'

    await onEmptyPromise; // Clearing pending tasks makes it "empty"

    expect(onEmptySpy).toHaveBeenCalledTimes(1);
    await expect(p2).rejects.toThrow('Queue cleared'); // Verify task was rejected by clear

    // Active task 'a' still runs to completion
    await delay(55);
    expect(queue.isIdle()).toBe(true);
  });
  // For the onEmpty test:
  it('should emit onEmpty when queue becomes empty', async () => {
    const queue = createAsyncQueue({ concurrency: 1 });

    // First, add a task to ensure the queue is not empty
    const taskPromise = queue.add(createTask(10, 'task'));

    // Now get the promise and attach the spy
    const onEmptySpy = vi.fn();
    const emptyPromise = queue.onEmpty();
    emptyPromise.then(onEmptySpy);

    expect(onEmptySpy).not.toHaveBeenCalled(); // Should not be called until queue is empty

    // Complete the task to make the queue empty
    await taskPromise;

    // Wait for onEmpty to be triggered (may need a small delay to process)
    await emptyPromise;

    expect(onEmptySpy).toHaveBeenCalledTimes(1); // Now it should be called once
    expect(queue.isEmpty()).toBe(true);

    // Test that a new onEmpty promise resolves immediately when queue is already empty
    const immediateEmptySpy = vi.fn();
    await queue.onEmpty().then(immediateEmptySpy);
    expect(immediateEmptySpy).toHaveBeenCalledTimes(1);
  });

  // For the onDrain test:
  it('should emit onDrain when queue becomes idle', async () => {
    const queue = createAsyncQueue({ concurrency: 1 });

    // First, add a task to ensure the queue is not idle
    const taskPromise = queue.add(createTask(10, 'task'));

    // Now get the promise and attach the spy
    const onDrainSpy = vi.fn();
    const drainPromise = queue.onDrain();
    drainPromise.then(onDrainSpy);

    expect(onDrainSpy).not.toHaveBeenCalled(); // Should not be called until queue is drained

    // Complete the task to make the queue idle
    await taskPromise;

    // Wait for onDrain to be triggered
    await drainPromise;

    expect(onDrainSpy).toHaveBeenCalledTimes(1); // Now it should be called once
    expect(queue.isIdle()).toBe(true);

    // Test that a new onDrain promise resolves immediately when queue is already idle
    const immediateDrainSpy = vi.fn();
    await queue.onDrain().then(immediateDrainSpy);
    expect(immediateDrainSpy).toHaveBeenCalledTimes(1);
  });

  it('should handle user onDrain callback', async () => {
    const onDrainCallbackSpy = vi.fn();
    const queue = createAsyncQueue({
      concurrency: 1,
      onDrain: onDrainCallbackSpy,
    });

    const p1 = queue.add(createTask(10, 'a'));
    await p1;

    // Allow internal checks to run
    await delay(1);

    expect(onDrainCallbackSpy).toHaveBeenCalledTimes(1);
    expect(queue.isIdle()).toBe(true);
  });

  it('should abort processing via AbortSignal', async () => {
    const controller = new AbortController();
    const queue = createAsyncQueue({ concurrency: 1, abortSignal: controller.signal });
    const task1Spy = vi.fn();
    const task2Spy = vi.fn();
    const task3Spy = vi.fn();

    const p1 = queue.add(() => delay(50).then(task1Spy)); // Starts running
    const p2 = queue.add(() => delay(10).then(task2Spy)); // Pending
    const p3 = queue.add(() => delay(10).then(task3Spy)); // Pending

    expect(queue.activeCount()).toBe(1);
    expect(queue.size()).toBe(2);

    controller.abort();

    // Check adding after abort fails
    await expect(queue.add(() => delay(10))).rejects.toThrow('Queue aborted');

    // Pending tasks should be rejected
    await expect(p2).rejects.toThrow('Queue cleared'); // Abort triggers clear
    await expect(p3).rejects.toThrow('Queue cleared');
    expect(task2Spy).not.toHaveBeenCalled();
    expect(task3Spy).not.toHaveBeenCalled();

    expect(queue.size()).toBe(0);
    expect(queue.activeCount()).toBe(1); // Active task continues

    // Active task should still complete
    await p1;
    expect(task1Spy).toHaveBeenCalledTimes(1);
    expect(queue.activeCount()).toBe(0);
    expect(queue.isIdle()).toBe(true);
  });

  it('should initialize as aborted if signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(); // Abort immediately

    const queue = createAsyncQueue({ abortSignal: controller.signal });

    expect(queue.size()).toBe(0);
    expect(queue.isIdle()).toBe(true);

    await expect(queue.add(createTask(10, 'a'))).rejects.toThrow('Queue aborted');
  });

  // Corrected: should update stats correctly
  it('should update stats correctly', async () => {
    const queue = createAsyncQueue({ concurrency: 2 });
    expect(queue.stats()).toEqual({ pending: 0, active: 0, completed: 0, errors: 0, total: 0 });

    const p1 = queue.add(createTask(20, 'ok1'));
    const p2 = queue.add(createTask(10, 'fail1', true));
    const p3 = queue.add(createTask(10, 'ok2')); // p3 waits for p1 or p2

    expect(queue.stats()).toEqual({ pending: 1, active: 2, completed: 0, errors: 0, total: 3 });

    // p2 (fail1) finishes first (after 10ms)
    await expect(p2).rejects.toThrow();
    // p3 should start now. p1 still running (10ms left).
    // Wait for microtasks to settle stats after rejection/next task start
    await delay(1);
    expect(queue.stats()).toEqual({ pending: 0, active: 2, completed: 0, errors: 1, total: 3 });

    // p3 (ok2) finishes (at 10ms + 10ms = 20ms total time)
    await expect(p3).resolves.toBe('ok2');
    // p1 (ok1) also finishes (at 20ms total time)
    // Both p1 and p3 have likely finished. Stats updated in their respective .then handlers.
    // Wait for microtasks to settle stats after resolutions
    await delay(1);

    // *** FIX: Adjusted expectation ***
    expect(queue.stats()).toEqual({ pending: 0, active: 0, completed: 2, errors: 1, total: 3 });

    // Await p1 just to ensure test waits fully, though stats are likely already final
    await expect(p1).resolves.toBe('ok1');
    // Stats should remain the same
    expect(queue.stats()).toEqual({ pending: 0, active: 0, completed: 2, errors: 1, total: 3 });
    expect(queue.isIdle()).toBe(true);
  });

  it('should allow changing concurrency', async () => {
    vi.useFakeTimers();
    const queue = createAsyncQueue({ concurrency: 1 });
    let maxConcurrent = 0;

    const task = (id: number, duration: number) => async () => {
      maxConcurrent = Math.max(maxConcurrent, queue.activeCount());
      await vi.advanceTimersByTimeAsync(duration);
      return id;
    };

    const promises = [queue.add(task(1, 50)), queue.add(task(2, 50)), queue.add(task(3, 50))];

    expect(queue.activeCount()).toBe(1);
    expect(queue.size()).toBe(2);
    maxConcurrent = 0; // Reset for checking after concurrency change

    // Increase concurrency while task 1 is running
    queue.setConcurrency(3);
    expect(queue.activeCount()).toBe(3); // Tasks 2 and 3 should start immediately
    expect(queue.size()).toBe(0);

    await vi.advanceTimersByTimeAsync(50);
    await Promise.all(promises);

    expect(maxConcurrent).toBe(3); // Concurrency reached 3 after change
    expect(queue.isIdle()).toBe(true);
    expect(queue.stats().completed).toBe(3);

    // Test decreasing concurrency
    const p4 = queue.add(task(4, 50));
    const p5 = queue.add(task(5, 50));
    const p6 = queue.add(task(6, 50));
    expect(queue.activeCount()).toBe(3); // 4, 5, 6 start
    maxConcurrent = 0; // Reset

    queue.setConcurrency(1); // Decrease concurrency
    expect(queue.activeCount()).toBe(3); // Running tasks are not stopped

    await vi.advanceTimersByTimeAsync(50); // Let 4, 5, 6 finish
    await Promise.all([p4, p5, p6]);

    expect(queue.isIdle()).toBe(true);
    const p7 = queue.add(task(7, 50));
    expect(queue.activeCount()).toBe(1); // New task respects lower concurrency

    await vi.advanceTimersByTimeAsync(50);
    await p7;
    expect(queue.isIdle()).toBe(true);

    vi.useRealTimers();
  });
});

describe('README Examples', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should work with the API rate limiting example', async () => {
    const mockFetch = vi.fn();
    const originalFetch = global.fetch;
    (global as any).fetch = mockFetch;

    const queue = createAsyncQueue({
      concurrency: 2,
      autoStart: true,
    });

    // Mock successful responses with a delay
    mockFetch.mockImplementation(async (url: string) => {
      // Add a small delay to simulate network request
      await new Promise(resolve => setTimeout(resolve, 10));
      return {
        json: () => Promise.resolve({ id: url.split('/').pop(), name: 'Test User' })
      };
    });

    // Create array of user IDs
    const userIds = ['123', '456', '789', '012'];

    // Track empty and drain events
    const onEmptySpy = vi.fn();
    const onDrainSpy = vi.fn();

    queue.onEmpty().then(onEmptySpy);
    queue.onDrain().then(onDrainSpy);

    // Process users with rate limiting
    const processUsers = async (ids: string[]) => {
      const results = await queue.addAll(
        ids.map(id => async () => {
          const response = await fetch(`/api/users/${id}`);
          return response.json();
        })
      );
      return results;
    };

    // Start processing
    const processPromise = processUsers(userIds);

    // Initially should have 2 active and 2 pending tasks
    expect(queue.stats()).toEqual({
      active: 2,
      pending: 2,
      completed: 0,
      errors: 0,
      total: 4
    });

    // Let first two tasks complete
    await vi.advanceTimersByTimeAsync(10);

    // Should now have 2 new active tasks from the pending queue
    expect(queue.stats()).toEqual({
      active: 2,
      pending: 0,
      completed: 2,
      errors: 0,
      total: 4
    });

    // Complete final tasks
    await vi.advanceTimersByTimeAsync(10);
    
    const results = await processPromise;

    // Verify results
    expect(results).toEqual([
      { id: '123', name: 'Test User' },
      { id: '456', name: 'Test User' },
      { id: '789', name: 'Test User' },
      { id: '012', name: 'Test User' }
    ]);

    // Verify final stats
    expect(queue.stats()).toEqual({
      active: 0,
      pending: 0,
      completed: 4,
      errors: 0,
      total: 4
    });

    // Verify events were triggered
    expect(onEmptySpy).toHaveBeenCalled();
    expect(onDrainSpy).toHaveBeenCalled();

    // Verify concurrency was respected
    expect(mockFetch).toHaveBeenCalledTimes(4);
    
    // Restore fetch
    (global as any).fetch = originalFetch;
  });
});
