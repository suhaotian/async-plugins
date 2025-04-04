import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAsyncCache, type AsyncCache } from '../src/cache'; // Update with correct import path

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Optionally, you can also terminate the process:
  // process.exit(1);
});

describe('createAsyncCache', () => {
  let mockTime = 1000;
  const getTimestamp = vi.fn(() => mockTime);
  let cache: AsyncCache<any>;

  // Helper to advance mock time
  const advanceTime = (ms: number) => {
    mockTime += ms;
  };

  // Helper to create a simple async function that returns its input
  const createMockFn = () => {
    return vi.fn(async (input: any) => input);
  };

  beforeEach(() => {
    mockTime = 1000;
    getTimestamp.mockImplementation(() => mockTime);
    vi.useFakeTimers(); // Add this line to mock timers
    cache = createAsyncCache({
      ttl: 100,
      maxSize: 10,
      getTimestamp,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers(); // Add this line to restore real timers
    if (cache) cache.clear();
  });

  it('should cache function results', async () => {
    const mockFn = createMockFn();
    const cachedFn = cache(mockFn);

    // First call should invoke the original function
    const result1 = await cachedFn('test');
    expect(result1).toBe('test');
    expect(mockFn).toHaveBeenCalledTimes(1);

    // Second call should return from cache without invoking the original function
    const result2 = await cachedFn('test');
    expect(result2).toBe('test');
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('should respect TTL for cached values', async () => {
    const mockFn = createMockFn();
    const cachedFn = cache(mockFn);

    // First call caches the result
    await cachedFn('test');
    expect(mockFn).toHaveBeenCalledTimes(1);

    // Advance time beyond TTL
    advanceTime(200);

    // Should invoke the original function again
    await cachedFn('test');
    expect(mockFn).toHaveBeenCalledTimes(2);
  });

  it('should use custom key generator if provided', async () => {
    const mockFn = createMockFn();
    const keyGenerator = vi.fn((...args) => args.join('-'));
    const cachedFn = cache(mockFn, keyGenerator);

    await cachedFn('a', 'b', 'c');
    expect(keyGenerator).toHaveBeenCalledWith('a', 'b', 'c');
    expect(mockFn).toHaveBeenCalledTimes(1);

    await cachedFn('a', 'b', 'c');
    expect(mockFn).toHaveBeenCalledTimes(1); // Cache hit
  });

  it('should handle stale-while-revalidate behavior', async () => {
    const mockFn = vi.fn(async (input) => `${input}-${mockTime}`);
    const swrCache = createAsyncCache({
      ttl: 100,
      staleWhileRevalidate: true,
      getTimestamp,
    });

    const cachedFn = swrCache(mockFn);

    // First call, cache the result
    const result1 = await cachedFn('test');
    expect(result1).toBe('test-1000');
    expect(mockFn).toHaveBeenCalledTimes(1);

    // Advance time beyond TTL
    advanceTime(150);

    // Should return stale data
    const result2 = await cachedFn('test');
    expect(result2).toBe('test-1000'); // Stale value

    // Allow background refresh to complete
    await vi.runAllTimersAsync();

    // Function should have been called to refresh the cache
    expect(mockFn).toHaveBeenCalledTimes(2);

    // Next call should get fresh data
    const result3 = await cachedFn('test');
    expect(result3).toBe('test-1150'); // Fresh value with new timestamp
  });

  it('should respect maxSize by evicting least recently used items', async () => {
    const smallCache = createAsyncCache({
      ttl: 100,
      maxSize: 2,
      getTimestamp,
    });

    const mockFn = createMockFn();
    const cachedFn = smallCache(mockFn);

    // Fill the cache with 2 items
    await cachedFn('item1');
    await cachedFn('item2');
    expect(mockFn).toHaveBeenCalledTimes(2);
    expect(smallCache.size()).toBe(2);

    // Access item1 to make item2 the LRU
    await cachedFn('item1');

    // Add a third item, should evict item2
    await cachedFn('item3');
    expect(smallCache.size()).toBe(2);

    // Check if item2 was evicted
    expect(smallCache.has(JSON.stringify(['item2']))).toBe(false);
    expect(smallCache.has(JSON.stringify(['item1']))).toBe(true);
    expect(smallCache.has(JSON.stringify(['item3']))).toBe(true);
  });

  it('should handle errors according to cacheErrorResults option', async () => {
    const errorFn = vi.fn(async (input) => {
      if (input === 'error') throw new Error('Test error');
      return input;
    });

    // Test with cacheErrorResults = false (default)
    const defaultCache = cache(errorFn);

    // Success path
    const success = await defaultCache('success');
    expect(success).toBe('success');

    // Error path
    await expect(defaultCache('error')).rejects.toThrow('Test error');
    expect(errorFn).toHaveBeenCalledTimes(2);

    // Try error again - should not be cached
    await expect(defaultCache('error')).rejects.toThrow('Test error');
    expect(errorFn).toHaveBeenCalledTimes(3);

    // Test with cacheErrorResults = true
    const errorCachingCache = createAsyncCache({
      ttl: 100,
      cacheErrorResults: true,
      getTimestamp,
    });

    const cachedErrorFn = errorCachingCache(errorFn);

    // First error - should be cached
    await expect(cachedErrorFn('error')).rejects.toThrow('Test error');
    expect(errorFn).toHaveBeenCalledTimes(4);

    // Second error - should be served from cache
    await expect(cachedErrorFn('error')).rejects.toThrow('Test error');
    expect(errorFn).toHaveBeenCalledTimes(4); // No change, cached error
  });

  it('should provide correct cache stats', async () => {
    const mockFn = createMockFn();
    const cachedFn = cache(mockFn);

    // Initial stats
    const initialStats = cache.stats();
    expect(initialStats.hits).toBe(0);
    expect(initialStats.misses).toBe(0);
    expect(initialStats.staleHits).toBe(0);
    expect(initialStats.errors).toBe(0);
    expect(initialStats.size).toBe(0);

    // First call - miss
    await cachedFn('test');
    expect(cache.stats().misses).toBe(1);
    expect(cache.stats().hits).toBe(0);
    expect(cache.stats().size).toBe(1);

    // Second call - hit
    await cachedFn('test');
    expect(cache.stats().hits).toBe(1);
    expect(cache.stats().misses).toBe(1);
  });

  it('should properly handle direct cache management methods', async () => {
    // Set a value directly
    cache.set('manual-key', 'manual-value');
    expect(cache.has('manual-key')).toBe(true);
    expect(cache.get('manual-key')).toBe('manual-value');

    // Update TTL
    const updated = cache.updateTTL('manual-key', 200);
    expect(updated).toBe(true);

    // Delete a key
    const deleted = cache.delete('manual-key');
    expect(deleted).toBe(true);
    expect(cache.has('manual-key')).toBe(false);

    // Try to delete a non-existent key
    const deletedNonExistent = cache.delete('non-existent');
    expect(deletedNonExistent).toBe(false);
  });

  it('should prune expired entries', async () => {
    // Add some entries
    cache.set('key1', 'value1');
    cache.set('key2', 'value2');
    cache.set('key3', 'value3');

    // Advance time beyond TTL
    advanceTime(150);

    // Add one more fresh entry
    cache.set('key4', 'value4');

    // Check size before pruning
    expect(cache.size()).toBe(4);

    // Prune expired entries
    const prunedCount = cache.prune();
    expect(prunedCount).toBe(3); // key1, key2, key3 should be pruned
    expect(cache.size()).toBe(1); // Only key4 should remain
    expect(cache.has('key4')).toBe(true);
  });

  it('should handle getEntry correctly', async () => {
    cache.set('test-key', 'test-value');

    const entry = cache.getEntry('test-key');
    expect(entry).toBeDefined();
    expect(entry?.value).toBe('test-value');
    expect(entry?.expiry).toBeGreaterThan(mockTime);
    expect(entry?.lastAccessed).toBe(mockTime);
    expect(entry?.isError).toBeUndefined();

    // Non-existent key
    const nonExistentEntry = cache.getEntry('non-existent');
    expect(nonExistentEntry).toBeUndefined();
  });

  it('should handle error entries in get method', async () => {
    // Set an error entry directly
    cache.set('error-key', new Error('Test error') as any, undefined, true);

    // get method should return undefined for error entries
    const errorResult = cache.get('error-key');
    expect(errorResult).toBeUndefined();

    // But getEntry should return the full entry
    const errorEntry = cache.getEntry('error-key');
    expect(errorEntry).toBeDefined();
    expect(errorEntry?.isError).toBe(true);
  });

  it('should handle stale error entries correctly', async () => {
    const swrCache = createAsyncCache({
      ttl: 100,
      staleWhileRevalidate: true,
      cacheErrorResults: true,
      getTimestamp,
    });

    // Set an error entry
    swrCache.set('stale-error', new Error('Stale error') as any, undefined, true);

    // Advance time to make it stale
    advanceTime(150);

    // get should return undefined for stale error entries too
    const staleErrorResult = swrCache.get('stale-error');
    expect(staleErrorResult).toBeUndefined();
  });

  it('should return keys correctly', async () => {
    cache.set('key1', 'value1');
    cache.set('key2', 'value2');

    const keys = cache.keys();
    expect(keys).toHaveLength(2);
    expect(keys).toContain('key1');
    expect(keys).toContain('key2');
  });

  it('should clear all cache entries', async () => {
    cache.set('key1', 'value1');
    cache.set('key2', 'value2');
    expect(cache.size()).toBe(2);

    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.has('key1')).toBe(false);
    expect(cache.has('key2')).toBe(false);
  });

  it('should handle background errors in stale-while-revalidate mode', async () => {
    const failOnSecondCall = vi.fn(async (input) => {
      if (mockTime > 1100) throw new Error('Refresh failed');
      return input;
    });

    const swrCache = createAsyncCache({
      ttl: 100,
      staleWhileRevalidate: true,
      cacheErrorResults: true,
      getTimestamp,
    });

    const cachedFn = swrCache(failOnSecondCall);

    // First call succeeds
    const result1 = await cachedFn('test');
    expect(result1).toBe('test');

    // Advance time to make it stale
    advanceTime(150);

    // Mock console.error to verify it's called
    const originalConsoleError = console.error;
    console.error = vi.fn();

    // Get stale value while refresh happens in background
    const result2 = await cachedFn('test');
    expect(result2).toBe('test'); // Return stale value

    // Allow background refresh to complete
    await vi.runAllTimersAsync();

    // Verify console.error was called
    expect(console.error).toHaveBeenCalled();

    // Restore console.error
    console.error = originalConsoleError;

    // Stats should show the error
    expect(swrCache.stats().errors).toBe(1);
  });
});

describe('README Examples', () => {
  let mockTime = 1000;
  const getTimestamp = vi.fn(() => mockTime);

  // Helper to advance mock time
  const advanceTime = (ms: number) => {
    mockTime += ms;
  };

  beforeEach(() => {
    mockTime = 1000;
    getTimestamp.mockImplementation(() => mockTime);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should work with the API caching example', async () => {
    const mockFetch = vi.fn();
    const originalFetch = global.fetch;
    (global as any).fetch = mockFetch;

    const cache = createAsyncCache({
      ttl: 300000,               // 5 minutes
      maxSize: 1000,
      staleWhileRevalidate: true,
      getTimestamp,
    });

    // Mock fetch implementation
    mockFetch.mockImplementation(async (url: string) => ({
      json: () => Promise.resolve({ id: url.split('/').pop(), name: 'Test User' })
    }));

    const getUserProfile = cache(
      async (userId: string) => {
        const response = await fetch(`/api/users/${userId}`);
        return response.json();
      },
      (userId) => `user_profile:${userId}`
    );

    // First call - should fetch
    const profile1 = await getUserProfile('123');
    expect(profile1).toEqual({ id: '123', name: 'Test User' });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second call within TTL - should return cached
    const profile2 = await getUserProfile('123');
    expect(profile2).toEqual({ id: '123', name: 'Test User' });
    expect(mockFetch).toHaveBeenCalledTimes(1); // No additional fetch

    // Advance time beyond TTL but within staleWhileRevalidate
    advanceTime(300001);

    // Should return stale data immediately
    const profile3Promise = getUserProfile('123');
    const profile3 = await profile3Promise;
    expect(profile3).toEqual({ id: '123', name: 'Test User' });

    // Allow background refresh to complete
    await vi.runAllTimersAsync();
    expect(mockFetch).toHaveBeenCalledTimes(2); // Background refresh occurred

    // Verify cache stats
    const stats = cache.stats();
    expect(stats.hits).toBeGreaterThan(0);
    expect(stats.staleHits).toBeGreaterThan(0);

    // Restore fetch
    (global as any).fetch = originalFetch;
  });
});
