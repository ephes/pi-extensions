# Backlog

Keep this file short and actionable.

## Next

- [ ] Add offline `agent_workflow` tests for parallel-mode protocol failures and rendered tool output.
- [ ] Add more unit tests for redirect handling, fetch-size limiting, and Kagi response formatting.
- [ ] Align `kagi_search` limit handling between `extensions/kagi_search.ts` and `shared/kagi.ts`.
- [ ] Evaluate a more robust readability/extraction approach.
- [ ] Deduplicate shared constants such as the user agent string.

## Later

- [ ] Document the DNS TOCTOU limitation in `web_content` and decide whether a custom DNS-aware HTTP layer is worth the complexity.
- [ ] Revisit repo structure once the extension count grows enough to justify a multi-package workspace split.
