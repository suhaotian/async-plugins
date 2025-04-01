[![Build](https://github.com/suhaotian/async-plugins/actions/workflows/check.yml/badge.svg)](https://github.com/suhaotian/async-plugins/actions/workflows/check.yml)
[![Size](https://deno.bundlejs.com/badge?q=async-plugins@0.0.1&badge=detailed&treeshake=%5B%7B+default+%7D%5D)](https://bundlejs.com/?q=async-plugins%400.0.1&treeshake=%5B%7B+default+%7D%5D)
[![npm version](https://badgen.net/npm/v/async-plugins?color=green)](https://www.npmjs.com/package/async-plugins)
![Downloads](https://img.shields.io/npm/dm/async-plugins.svg?style=flat)
![typescript](https://badgen.net/badge/icon/typescript?icon=typescript&label&color=blue)

## Intro

🛠 A collection of helpful functions for async operations.

**Features:**

- [ ] **async-retry**: Retry async operations with configurable backoff
- [ ] **async-cache**: Cache results of async operations with LRU eviction
- [ ] **async-dedupe**: Deduplicate simultaneous identical async operations
- [ ] **async-queue**: Process operations sequentially or with configurable concurrency limits.
- [ ] **async-timeout**: Add timeouts to async operations that might hang.
- [ ] **async-poll**: Periodically check for a condition with configurable intervals.

- ~~[ ] **async-throttle**: Limit the number of concurrent operations to prevent overwhelming resources.~~
- ~~[ ] **async-debounce**: Delay execution until after a period of inactivity, useful for handling user input.~~
- ~~[ ] **async-memoize**: Remember results of expensive operations based on input parameters.~~
- ~~[ ] **async-semaphore**: Control access to limited resources across asynchronous operations.~~
- ~~[ ] **async-circuit-breaker**: Prevent cascading failures by stopping operations when error rates exceed thresholds.~~
- ~~[ ] **async-rate-limit**: Enforce operation limits per time window.~~
- 👊 Unit tested and strongly typed 💪
- 🚀 Lightweight and Tree-shakeable (~?KB, Gzip ~?kb)

## Table of Contents

- [Intro](#intro)
- [Table of Contents](#table-of-contents)
- [Getting Started](#getting-started)
  - [Installing](#installing)
    - [Package manager](#package-manager)
- [Helper functions](#helper-functions)
- [FAQ](#faq)
  - [1. Why is named **"async-plugins"**?](#1-why-is-named-async-plugins)
  - [2. Where can I ask additional questions?](#2-where-can-i-ask-additional-questions)
- [API Reference](#api-reference)
- [Star History](#star-history)
- [Thanks](#thanks)

## Getting Started

### Installing

#### Package manager

```sh
# npm
npm install async-plugins

# pnpm
pnpm add async-plugins

# bun
bun add async-plugins

# yarn
yarn add async-plugins

# deno
deno install npm:async-plugins
```

## Helper functions

**async-plugins** has some built-in helper functions, may useful for you:

```ts
import {
  // ....
} from 'async-plugins';
```

## FAQ

**async-plugins** frequently asked questions.

### 1. Why is named **"async-plugins"**?

**async-utils** or **async-helpers** already used

### 2. Where can I ask additional questions?

If you have any questions, feel free to create issues.

## API Reference

- https://www.jsdocs.io/package/async-plugins

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=suhaotian/async-plugins&type=Date)](https://star-history.com/#suhaotian/async-plugins&Date)

## Thanks

Without the support of these resources, **async-plugins** wouldn't be possible:

- Claude 3.7 Sonnet
- Gemini 2.5 Pro
