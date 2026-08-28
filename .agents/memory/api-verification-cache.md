---
name: API verification cache
description: A verification caveat for the Toko API's in-memory source cache.
---

When validating provider changes or changing request parameters, clear the running API's in-memory cache before judging the result. Cached empty responses can otherwise make a working provider appear broken.

**Why:** The API caches source responses in memory, and a previous empty request can be reused before the updated provider path is exercised.

**How to apply:** Restart the API workflow or use its cache-clear/reload endpoint before repeating an end-to-end source or SSE check.