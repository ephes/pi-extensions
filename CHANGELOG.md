# Changelog

## Unreleased

- Add a `subagent` extension with bundled `implementer` and `reviewer` agent definitions
- Add `/implement`, `/review`, and `/implement-and-review` prompt templates for bundled subagent workflows
- Register package prompt templates through the Pi package manifest
- Add a bundled-agent discovery test for the `subagent` extension
- Harden subagent subprocesses with `--no-extensions`, `--no-prompt-templates`, and `--no-skills`
- Truncate chained `{previous}` context before handing it to the next subagent step
- Document bundled model ID assumptions and reviewer bash limitations
- Harden `web_content` against redirect-based SSRF
- Block IPv4-mapped IPv6 private and loopback addresses
- Enforce a streaming fetch-size limit before extraction
- Rename `kagi_content` to `web_content`
- Add initial unit tests for security-sensitive helpers
- Add a repository backlog for follow-up work
- Add `just` shorthands for linting, type-checking, tests, repo line counts, and aggregate checks
- Document repo guidance in `README.md` and `AGENTS.md`

## 0.1.0

- Scaffold initial Pi package structure
- Add `kagi_search` extension
- Add `kagi_content` extension
