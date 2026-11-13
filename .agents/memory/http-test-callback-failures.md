---
name: HTTP test callback failures
description: Why exceptions in Node HTTP response callbacks can hang route tests instead of reporting failures.
---

When a test wraps Node HTTP callbacks in a Promise, guard parsing or explicitly reject on callback errors. Do not assume every Express response is JSON: unmatched routes return HTML by default.

**Why:** An exception thrown in a response `end` callback does not reject the surrounding Promise. A malformed JSON assumption can make the test runner wait indefinitely and obscure the original error.

**How to apply:** In future route tests with native `http.request`, handle non-JSON responses and route any callback exceptions to the Promise's reject function.