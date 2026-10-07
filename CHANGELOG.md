# Changelog

## Unreleased

- Add a GitHub Actions CI workflow (Node 22, `npm ci`, `npm run check`) with SHA-pinned actions, npm caching and read-only permissions
- Refresh vulnerable transitive dev dependencies in `package-lock.json` (clears the critical `protobufjs` advisory); the remaining advisories need a breaking `@mariozechner/pi-*` upgrade
- Rename the workflow tool from `subagent` to `agent_workflow` to reduce collisions and better match its orchestration role
- Add an `agent_workflow` extension with bundled `implementer` and `reviewer` agent definitions
- Add `/implement`, `/review`, and `/implement-and-review` prompt templates for bundled agent workflows
- Fix package extension discovery for installed Pi sessions by registering the conventional `./extensions` directory in the manifest
- Register package prompt templates through the Pi package manifest
- Add a bundled-agent discovery test for the `agent_workflow` extension
- Harden agent workflow subprocesses with `--no-extensions`, `--no-prompt-templates`, and `--no-skills`
- Truncate chained `{previous}` context before handing it to the next delegated agent step
- Add authenticated model fallback for `agent_workflow` subprocesses when bundled model IDs are unavailable
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
