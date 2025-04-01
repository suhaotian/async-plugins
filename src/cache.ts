// ===== ASYNC CACHE =====

export interface CacheOptions<T> {
  ttl: number; // Time-to-live in milliseconds
  maxSize?: number; // Maximum number of items in cache
  onEvict?: (key: string, value: T) => void; // Called when an item is evicted
  staleWhileRevalidate?: boolean; // Return stale data while fetching fresh data
  getTimestamp?: () => number; // For testing and sync with external time sources
  cacheErrorResults?: boolean; // Whether to cache rejected promises/errors
}

export interface CacheEntry<T> {
  value: T;
  expiry: number;
  lastAccessed: number;
  isError?: boolean;
}

export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  staleHits: number;
  errors: number;
}

export interface AsyncCache<T> {
  (
    fn: (...args: any[]) => Promise<T>,
    keyGenerator?: (...args: any[]) => string
  ): (...args: any[]) => Promise<T>;
  clear: () => void;
  size: () => number;
  delete: (key: string) => boolean;
  has: (key: string) => boolean;
  get: <K extends string>(key: K) => T | undefined;
  set: <K extends string>(key: K, value: T, ttl?: number, isError?: boolean) => void;
  keys: () => string[];
  getEntry: <K extends string>(key: K) => CacheEntry<T> | undefined;
  updateTTL: <K extends string>(key: K, ttl: number) => boolean;
  stats: () => CacheStats;
  prune: () => number; // Manually remove expired entries, returns count of removed items
}

/**
 * Creates a cache wrapper for async functions with TTL expiry and LRU eviction
 * @param options Cache configuration options
 * @returns A function that wraps async functions with caching
 */
export function createAsyncCache<T = any>(options: Partial<CacheOptions<T>> = {}): AsyncCache<T> {
  const config: CacheOptions<T> = {
    ttl: 5 * 60 * 1000, // 5 minutes default
    maxSize: 1000,
    staleWhileRevalidate: false,
    getTimestamp: () => Date.now(),
    cacheErrorResults: false,
    ...options,
  };

  const cache = new Map<string, CacheEntry<T>>();
  const stats: CacheStats = {
    hits: 0,
    misses: 0,
    staleHits: 0,
    errors: 0,
    size: 0,
  };

  // LRU eviction helper
  function evictLRU() {
    if (cache.size <= 0) return;

    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of cache.entries()) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const entry = cache.get(oldestKey);
      if (entry && config.onEvict) {
        try {
          config.onEvict(oldestKey, entry.value);
        } catch (error) {
          console.error('Error in cache eviction callback:', error);
        }
      }
      cache.delete(oldestKey);
    }
  }

  // Helper to clean expired entries
  function pruneExpired(): number {
    const now = config.getTimestamp?.() || Date.now();
    let count = 0;

    for (const [key, entry] of cache.entries()) {
      if (entry.expiry < now) {
        if (config.onEvict) {
          try {
            config.onEvict(key, entry.value);
          } catch (error) {
            console.error('Error in cache eviction callback:', error);
          }
        }
        cache.delete(key);
        count++;
      }
    }

    return count;
  }

  /**
   * Wraps an async function with caching capabilities
   * @param fn The async function to cache
   * @param keyGenerator Optional function to generate a cache key from arguments
   * @returns A wrapped function that uses the cache
   */
  function asyncCache<Args extends any[]>(
    fn: (...args: Args) => Promise<T>,
    keyGenerator?: (...args: Args) => string
  ): (...args: Args) => Promise<T> {
    const safeFn = async function (...args: Args): Promise<T> {
      const key = keyGenerator ? keyGenerator(...args) : JSON.stringify(args);

      const now = config.getTimestamp?.() || Date.now();

      // Clean expired entries occasionally (10% chance to avoid performance impact)
      if (Math.random() < 0.1) {
        pruneExpired();
      }

      // Enforce max size if needed
      if (config.maxSize && cache.size >= config.maxSize) {
        evictLRU();
      }

      // Check for valid cache entry
      const existing = cache.get(key);

      // Handle stale-while-revalidate pattern
      if (existing) {
        if (existing.expiry > now) {
          // Valid cache hit - update last accessed time and return
          existing.lastAccessed = now;
          stats.hits++;

          // If it's a cached error, we need to throw it
          if (existing.isError) {
            throw existing.value;
          }

          return existing.value;
        } else if (config.staleWhileRevalidate) {
          // Stale but usable - trigger background refresh and return stale data
          const staleValue = existing.value;
          stats.staleHits++;

          // If it's a cached error, we should still try to refresh
          if (!existing.isError) {
            // Refresh in background
            fn(...args)
              .then((freshValue) => {
                cache.set(key, {
                  value: freshValue,
                  expiry: now + config.ttl,
                  lastAccessed: now,
                });
              })
              .catch((error) => {
                // If refresh fails and we're caching errors, update the cache
                if (config.cacheErrorResults) {
                  stats.errors++;
                  cache.set(key, {
                    value: error,
                    expiry: now + config.ttl,
                    lastAccessed: now,
                    isError: true,
                  });
                }
              });

            return staleValue;
          }

          // For cached errors, we don't return the stale error
          // Instead, we continue to a fresh execution
        }
      }

      // Cache miss or expired without stale-while-revalidate - execute the function
      stats.misses++;

      try {
        const result = await fn(...args);

        cache.set(key, {
          value: result,
          expiry: now + config.ttl,
          lastAccessed: now,
        });

        return result;
      } catch (error) {
        // Cache errors if configured to do so
        if (config.cacheErrorResults) {
          stats.errors++;
          cache.set(key, {
            value: error as T,
            expiry: now + config.ttl,
            lastAccessed: now,
            isError: true,
          });
        }

        throw error;
      }
    };

    return safeFn;
  }

  // Add methods to manage cache
  asyncCache.clear = () => cache.clear();
  asyncCache.size = () => cache.size;
  asyncCache.delete = (key: string) => {
    const entry = cache.get(key);
    if (entry && config.onEvict) {
      try {
        config.onEvict(key, entry.value);
      } catch (error) {
        console.error('Error in cache eviction callback:', error);
      }
    }
    return cache.delete(key);
  };
  asyncCache.has = (key: string) => cache.has(key);
  asyncCache.get = <K extends string>(key: K) => {
    const entry = cache.get(key);
    if (!entry) return undefined;

    // Don't return cached errors through direct get
    if (entry.isError) return undefined;

    const now = config.getTimestamp?.() || Date.now();
    if (entry.expiry > now) {
      entry.lastAccessed = now;
      stats.hits++;
      return entry.value;
    } else if (config.staleWhileRevalidate) {
      stats.staleHits++;
      return entry.value;
    }
    return undefined;
  };
  asyncCache.set = <K extends string>(key: K, value: T, ttl?: number, isError?: boolean) => {
    const now = config.getTimestamp?.() || Date.now();
    cache.set(key, {
      value,
      expiry: now + (ttl || config.ttl),
      lastAccessed: now,
      isError,
    });
  };
  asyncCache.keys = () => Array.from(cache.keys());
  asyncCache.getEntry = <K extends string>(key: K) => cache.get(key);
  asyncCache.updateTTL = <K extends string>(key: K, ttl: number) => {
    const entry = cache.get(key);
    if (!entry) return false;

    const now = config.getTimestamp?.() || Date.now();
    entry.expiry = now + ttl;
    return true;
  };
  asyncCache.stats = () => ({ ...stats, size: cache.size });
  asyncCache.prune = () => pruneExpired();

  return asyncCache;
}
