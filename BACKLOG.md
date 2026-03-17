# Backlog

Keep this file short and actionable.

## Next

- [ ] Add integration tests for the `agent_workflow` extension, especially chained workflow behavior, model fallback, and subprocess error handling.
- [ ] Add more unit tests for redirect handling, fetch-size limiting, and Kagi response formatting.
- [ ] Align `kagi_search` limit handling between `extensions/kagi_search.ts` and `shared/kagi.ts`.
- [ ] Improve HTML entity decoding and evaluate a more robust readability/extraction approach.
- [ ] Deduplicate shared constants such as the user agent string.

## Later

- [ ] Document the DNS TOCTOU limitation in `web_content` and decide whether a custom DNS-aware HTTP layer is worth the complexity.
- [ ] Add a small integration-test harness for Pi package loading and basic tool registration.
- [ ] Revisit repo structure once the extension count grows enough to justify a multi-package workspace split.
