# AGENTS.md

Guidance for coding agents working in this repository.

## Repo purpose

This repository contains Pi extensions for search, web access, and agent workflows.
It currently uses a single-package layout and may later grow into a multi-package monorepo.

## Structure

- `agents/` — bundled agent definitions used by the `agent_workflow` extension
- `extensions/` — Pi extension entry points
- `prompts/` — prompt templates registered through the Pi package manifest
- `shared/` — shared helpers used by multiple extensions
- `tests/` — unit tests for helpers and extension-facing behavior
- `justfile` — developer shorthands
- `BACKLOG.md` — short follow-up list using `Next` and `Later`

## Developer workflow

Run from the repository root.

### Install dependencies

```bash
npm install
```

### Validation

Preferred:

```bash
just check
```

Available shorthands:

```bash
just lint
just typecheck
just test
just check
just loc
```

Equivalent npm commands:

```bash
npm run lint
npm run typecheck
npm test
npm run check
```

## Conventions

- Keep tool names accurate and non-misleading.
- Kagi result URLs must be absolute HTTP(S) without userinfo; reject invalid response evidence with fixed diagnostics before output retention.
- Workflow process journeys must use an invented local `pi`, IPC barriers and synthetic prompts; never invoke subscription-backed delegates or providers. Check chain handoff ordering, literal bounded text and prompt/group cleanup on success and abort. Report sandbox signal-policy skips explicitly.
- Put reusable network/auth/parsing logic in `shared/`.
- Keep bundled agent prompts in `agents/` and workflow templates in `prompts/`.
- Add tests for security-sensitive helpers, parsing logic, and agent workflow behavior when practical.
- Keep `BACKLOG.md` short and actionable.
- Update `README.md` when developer commands, repo structure, or extension behavior changes.
- Update `CHANGELOG.md` for user-visible or developer-visible changes.

## Notes

- `web_content` is security-sensitive. Preserve redirect validation, private-IP blocking, and fetch-size limits when changing it.
- `agent_workflow` depends on bundled files in `agents/` and `prompts/`; keep package manifest entries and runtime discovery aligned.
- Preserve workflow admission before prompt creation/launch: 8 parallel tasks before discovery, 32 chain steps, 1 MiB per task and 4 MiB submitted input. Discovery must fail the entire generation above 256 entries or 4 MiB actual definition reads and close all descriptors.
- Keep agent workflow chain handoffs concise; oversized `{previous}` context should be truncated or summarized rather than passed through verbatim.
- Prefer small, composable extensions with shared helpers rather than duplicating logic across entry points.
