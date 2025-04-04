import { lru } from 'tiny-lru'; 

// ===== ASYNC CACHE =====

export interface CacheOptions<T> {
  ttl: number; // Time-to-live in milliseconds
  maxSize?: number; // Maximum number of items in cache
  // onEvict?: (key: string, value: T) => void; // NOTE: onEvict is not supported when using tiny-lru
  staleWhileRevalidate?: boolean; // Return stale data while fetching fresh data
  getTimestamp?: () => number; // For testing and sync with external time sources
  cacheErrorResults?: boolean; // Whether to cache rejected promises/errors
}

export interface CacheEntry<T> {
  value: T;
  expiry: number;
  lastAccessed: number; // Note: tiny-lru manages LRU internally, this might become redundant unless used elsewhere
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

  // Use tiny-lru for LRU eviction based on maxSize
  // TTL is handled manually via CacheEntry.expiry to support staleWhileRevalidate
  const cache = lru<CacheEntry<T>>(config.maxSize || 1000); // Ensure maxSize is defined
  const refreshingKeys = new Set<string>(); // Track keys being refreshed
  const stats: CacheStats = {
    hits: 0,
    misses: 0,
    staleHits: 0,
    errors: 0,
    size: 0, // size will be derived from cache.size
  };

  // Helper to clean expired entries based on manual expiry time
  function pruneExpired(): number {
    const now = config.getTimestamp?.() || Date.now();
    let count = 0;

    // Iterate over a copy of keys as we might delete during iteration
    const keys = Array.from(cache.keys());
    for (const key of keys) {
      const entry = cache.get(key); // Use get instead of peek (updates LRU order)
      if (entry && entry.expiry < now) {
        // NOTE: onEvict callback removed
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

      // Check for cache entry (tiny-lru's get updates LRU order)
      const existing = cache.get(key);

      // Handle stale-while-revalidate pattern
      if (existing) {
        // Update lastAccessed for consistency if needed elsewhere, though tiny-lru handles LRU
        existing.lastAccessed = now;

        if (existing.expiry > now) {
          // Valid cache hit
          stats.hits++;
          if (existing.isError) {
            throw existing.value;
          }
          return existing.value;
        } else if (config.staleWhileRevalidate) {
          // Stale but usable
          const staleValue = existing.value;
          stats.staleHits++;

          if (!refreshingKeys.has(key)) {
            refreshingKeys.add(key);
            // Refresh in background
            fn(...args)
              .then((freshValue) => {
                // tiny-lru handles eviction if maxSize is reached on set
                cache.set(key, {
                  value: freshValue,
                  expiry: now + config.ttl,
                  lastAccessed: now,
                });
              })
              .catch((error) => {
                console.error(`Cache refresh failed for key "${key}":`, error);
                // Decide whether to cache the error or remove the stale entry
                if (config.cacheErrorResults) {
                   cache.set(key, {
                     value: error as T,
                     expiry: now + config.ttl, // Cache error with standard TTL
                     lastAccessed: now,
                     isError: true,
                   });
                   stats.errors++;
                } else {
                  // Optionally remove the stale entry if refresh fails and errors aren't cached
                  // cache.delete(key);
                }
              })
              .finally(() => {
                refreshingKeys.delete(key);
              });
          }

          // Return stale value (including stale errors)
          if (existing.isError) {
            throw staleValue;
          }
          return staleValue;
        }
        // Entry exists but is expired and staleWhileRevalidate is false
        // Fall through to cache miss logic
      }

      // Cache miss or expired without stale-while-revalidate
      stats.misses++;

      // Occasional pruning of manually expired items
      if (Math.random() < 0.1) {
        pruneExpired();
      }

      try {
        const result = await fn(...args);
        // tiny-lru handles eviction if maxSize is reached on set
        cache.set(key, {
          value: result,
          expiry: now + config.ttl,
          lastAccessed: now,
        });
        return result;
      } catch (error) {
        if (config.cacheErrorResults) {
          stats.errors++;
          // tiny-lru handles eviction if maxSize is reached on set
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
  asyncCache.size = () => cache.size; // Fix: Access size as a property
  asyncCache.delete = (key: string) => {
    // NOTE: onEvict callback removed
    const existed = cache.has(key);
    cache.delete(key); // tiny-lru delete returns the instance, not boolean
    return existed; // Return whether it existed before deletion
  };
  asyncCache.has = (key: string) => cache.has(key);
  asyncCache.get = <K extends string>(key: K) => {
    const entry = cache.get(key); // Updates LRU order
    if (!entry) return undefined;

    const now = config.getTimestamp?.() || Date.now();
    entry.lastAccessed = now; // Update for consistency if needed

    if (entry.expiry > now) {
      stats.hits++;
      // Don't throw errors in get method - this is correct API behavior
      if (entry.isError) {
        return undefined;
      }
      return entry.value;
    } else {
      // Expired
      if (config.staleWhileRevalidate) {
        stats.staleHits++;
        // Return stale data, but don't throw errors from get
        if (entry.isError) {
          return undefined;
        }
        return entry.value;
      }
      // Expired and not SWR
      return undefined;
    }
  };
  asyncCache.set = <K extends string>(key: K, value: T, ttl?: number, isError?: boolean) => {
    const now = config.getTimestamp?.() || Date.now();
    // tiny-lru handles eviction if maxSize is reached on set
    cache.set(key, {
      value,
      expiry: now + (ttl ?? config.ttl),
      lastAccessed: now,
      isError,
    });
  };
  asyncCache.keys = () => Array.from(cache.keys()); // Remove redundant type casting
  // Use get for getEntry (updates LRU order, unlike peek)
  asyncCache.getEntry = <K extends string>(key: K) => cache.get(key);
  asyncCache.updateTTL = <K extends string>(key: K, ttl: number) => {
    const entry = cache.get(key); // Use get instead of peek (updates LRU order)
    if (!entry) return false;

    const now = config.getTimestamp?.() || Date.now();
    entry.expiry = now + ttl;
    // Re-set to ensure the update is stored correctly by tiny-lru
    cache.set(key, entry);
    return true;
  };
  asyncCache.stats = () => ({ ...stats, size: cache.size }); // Fix: Access size as a property
  asyncCache.prune = () => pruneExpired();

  return asyncCache;
}