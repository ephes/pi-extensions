# Changelog

## Unreleased

- Harden `web_content` against redirect-based SSRF
- Block IPv4-mapped IPv6 private and loopback addresses
- Enforce a streaming fetch-size limit before extraction
- Rename `kagi_content` to `web_content`
- Add initial unit tests for security-sensitive helpers
- Add a repository backlog for follow-up work
- Document `just` shorthands, linting, and repo guidance in `README.md` and `AGENTS.md`

## 0.1.0

- Scaffold initial Pi package structure
- Add `kagi_search` extension
- Add `kagi_content` extension
