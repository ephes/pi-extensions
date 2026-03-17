# AGENTS.md

Guidance for coding agents working in this repository.

## Repo purpose

This repository contains Pi extensions for search, web access, and agent workflows.
It currently uses a single-package layout and may later grow into a multi-package monorepo.

## Structure

- `extensions/` — Pi extension entry points
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
- Put reusable network/auth/parsing logic in `shared/`.
- Add tests for security-sensitive helpers and parsing logic.
- Keep `BACKLOG.md` short and actionable.
- Update `README.md` when developer commands, repo structure, or extension behavior changes.
- Update `CHANGELOG.md` for user-visible or developer-visible changes.

## Notes

- `web_content` is security-sensitive. Preserve redirect validation, private-IP blocking, and fetch-size limits when changing it.
- Prefer small, composable extensions with shared helpers rather than duplicating logic across entry points.
