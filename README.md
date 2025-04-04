[![Build](https://github.com/suhaotian/async-plugins/actions/workflows/check.yml/badge.svg)](https://github.com/suhaotian/async-plugins/actions/workflows/check.yml)
[![Size](https://deno.bundlejs.com/badge?q=async-plugins@0.0.1&badge=detailed&treeshake=%5B%7B+default+%7D%5D)](https://bundlejs.com/?q=async-plugins%400.0.1&treeshake=%5B%7B+default+%7D%5D)
[![npm version](https://badgen.net/npm/v/async-plugins?color=green)](https://www.npmjs.com/package/async-plugins)
![Downloads](https://img.shields.io/npm/dm/async-plugins.svg?style=flat)
![typescript](https://badgen.net/badge/icon/typescript?icon=typescript&label&color=blue)

## Intro

🛠 A lightweight collection of TypeScript utilities for common async operation patterns. Each utility is optimized for performance and provides a clean, type-safe API.

**Features:**

- ⚡️ **async-retry**: Smart retry logic with exponential backoff for API calls and network operations
- 🗄️ **async-cache**: Fast LRU caching with TTL support for expensive operations
- 🎯 **async-dedupe**: Prevent duplicate API calls and redundant operations
- 📊 **async-queue**: Control concurrency and resource usage with priority queues
- 🔄 **async-poll**: Reliable polling with configurable intervals and backoff
- 👊 Fully typed with TypeScript
- 🎭 Comprehensive test coverage
- 📦 Tree-shakeable and lightweight
- 🚫 Zero dependencies (except tiny-lru)

## Getting Started

### Installing

```sh
npm install async-plugins   # npm
pnpm add async-plugins     # pnpm
bun add async-plugins      # bun
yarn add async-plugins     # yarn
```

## Usage Examples

### Retry

Perfect for handling flaky API calls or network operations:

```ts
import { createAsyncRetry } from 'async-plugins';

const fetchWithRetry = createAsyncRetry({
  retries: 3,                    // Try up to 3 times
  minTimeout: 1000,             // Start with 1s delay
  maxTimeout: 10000,            // Cap at 10s delay
  factor: 2,                    // Double the delay each time
  jitter: true,                 // Add randomness to prevent thundering herd
  shouldRetry: (error) => {     // Only retry on network/5xx errors
    return error.name === 'NetworkError' || 
           (error.status && error.status >= 500);
  },
  onRetry: (error, attempt) => {
    console.warn(`Retry attempt ${attempt} after error:`, error);
  }
});

// Example: Fetch user data with retries
const getUserData = async (userId: string) => {
  try {
    const response = await fetchWithRetry(() => 
      fetch(`/api/users/${userId}`).then(r => r.json())
    );
    return response;
  } catch (error) {
    // All retries failed
    console.error('Failed to fetch user data:', error);
    throw error;
  }
};
```

### Cache

Optimize expensive operations and API calls with smart caching:

```ts
import { createAsyncCache } from 'async-plugins';

const cache = createAsyncCache({
  ttl: 300000,                // Cache for 5 minutes
  maxSize: 1000,              // Store up to 1000 items
  staleWhileRevalidate: true, // Return stale data while refreshing
});

// Example: Cache expensive API calls
const getUserProfile = cache(
  async (userId: string) => {
    const response = await fetch(`/api/users/${userId}`);
    return response.json();
  },
  // Optional: Custom cache key generator
  (userId) => `user_profile:${userId}`
);

// First call fetches and caches
const profile1 = await getUserProfile('123');

// Subsequent calls within TTL return cached data
const profile2 = await getUserProfile('123'); // instant return

// After TTL expires, returns stale data and refreshes in background
const profile3 = await getUserProfile('123'); // instant return with stale data
```

### Dedupe

Prevent duplicate API calls and redundant operations:

```ts
import { createAsyncDedupe } from 'async-plugins';

const dedupe = createAsyncDedupe({
  timeout: 5000,      // Auto-expire after 5s
  errorSharing: true, // Share errors between duplicate calls
});

// Example: Prevent duplicate API calls
const fetchUserData = dedupe(async (userId: string) => {
  const response = await fetch(`/api/users/${userId}`);
  return response.json();
});

// Multiple simultaneous calls with same ID
const [user1, user2] = await Promise.all([
  fetchUserData('123'),  // Makes API call
  fetchUserData('123'),  // Uses result from first call
]);

// Check if operation is in progress
if (dedupe.isInProgress('123')) {
  console.log('Fetch in progress...');
}
```

### Queue

Control concurrency and manage resource usage:

```ts
import { createAsyncQueue } from 'async-plugins';

const queue = createAsyncQueue({
  concurrency: 2,     // Process 2 tasks at once
  autoStart: true,    // Start processing immediately
});

// Example: Rate-limit API calls
const processUsers = async (userIds: string[]) => {
  const results = await queue.addAll(
    userIds.map(id => async () => {
      const response = await fetch(`/api/users/${id}`);
      return response.json();
    })
  );
  return results;
};

// Monitor queue status
queue.onEmpty().then(() => {
  console.log('Queue is empty');
});

queue.onDrain().then(() => {
  console.log('All tasks completed');
});

// Queue stats
console.log(queue.stats());
// { pending: 0, active: 2, completed: 10, errors: 0, total: 12 }
```

### Poll

Reliable polling with configurable intervals:

```ts
import { createAsyncPoller } from 'async-plugins';

// Example: Poll for job completion
const pollJobStatus = createAsyncPoller(
  // Function to poll
  async () => {
    const response = await fetch('/api/job/123');
    return response.json();
  },
  {
    interval: 1000,   // Poll every second
    maxAttempts: 30,  // Try up to 30 times
    backoff: {
      type: 'exponential',
      factor: 2,
      maxInterval: 30000,
      jitter: true,
    },
    shouldContinue: (result) => result.status === 'running',
    onProgress: (result) => {
      console.log('Job progress:', result.progress);
    }
  }
);

try {
  const finalResult = await pollJobStatus.start();
  console.log('Job completed:', finalResult);
} catch (error) {
  console.error('Polling failed:', error);
}

// Can stop polling manually if needed
pollJobStatus.stop();
```

## FAQ

### 1. Why choose async-plugins?

- 🎯 **Focused Purpose**: Each utility solves a specific async pattern problem
- 📦 **Lightweight**: Minimal bundle size impact with tree-shaking support
- 💪 **Type-Safe**: Written in TypeScript with comprehensive type definitions
- 🔧 **Customizable**: Flexible configuration options for each utility
- 🚀 **Production-Ready**: Well-tested and actively maintained

### 2. Where can I get help?

If you have questions or run into issues:

1. Check the [API Reference](https://www.jsdocs.io/package/async-plugins)
2. Create an issue on [GitHub](https://github.com/suhaotian/async-plugins/issues)
3. For security issues, please email me directly

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) for details.

## License

MIT License. See [LICENSE](LICENSE) for details.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=suhaotian/async-plugins&type=Date)](https://star-history.com/#suhaotian/async-plugins&Date)

## Acknowledgements

This project wouldn't be possible without:

- [tiny-lru](https://github.com/avoidwork/tiny-lru) for LRU cache implementation
- Claude 3.7 Sonnet
- Gemini 2.5 Pro
