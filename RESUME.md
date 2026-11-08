# Resume scout round 84 bundle B16

Status: implemented and locally validated, **not reviewed and not merged**.

Slices, in report order:
1. `pi-agent-explicit-empty-tool-policy`
2. `pi-agent-task-prompt-outside-process-argv`

Both defects were reverified against main at
`535b54a644f9ac2e1908c1895a6c41f336e469f2`; neither was already fixed.
New installed-layout regressions failed on that baseline for both defects.

Implementation rejects explicit empty/unknown/wildcard/additive built-in capability
policies while preserving omitted defaults and bundled exact allowlists. Delegated
tasks now use owner-private `task.md` with Pi's public `@file` input, preserving
literal task contents and the existing Task: prefix. Pi supplies a file attachment
wrapper. Both prompt files share the existing owned directory and cleanup lifetime.
README and CHANGELOG Unreleased describe the changes; no version bump.

Local validation before parking:
- `npm ci --cache ../.cache/npm`: passed.
- `npm run check`: lint, TypeScript and all 274 tests passed, zero skips.
- `npm run audit:prod -- --cache ../.cache/npm`: zero vulnerabilities.
- `git diff --check`: passed.

Installed tests use fake children, synthetic definitions and >1 MiB literal task
text, checking argv, exact file contents, permissions, omitted defaults and valid
allowlists. Lifecycle regressions cover first/second-file partial write failures,
cancellation, spawn errors and existing chain handoff limits without real signals.

The required claude-review-loop invocation used `--model claude-opus-5-5
--effort high`. It exited 2, PROVIDER_ERROR/api_error. The provider reported:
“Failed to authenticate: OAuth session expired and could not be refreshed”.
No completed review, findings or clean verdict exists. No alternate reviewer was
used. Local review artifacts are outside the clone in
`../.cache/review-b16-round1/`; they are not committed.

After Claude authentication is repaired:
1. Fetch origin, verify the ephes remote, rebase this branch on current origin/main,
   and reverify both slices against updated main before continuing.
2. Remove this parking note before the final review. Run `npm run check` and
   `npm run audit:prod` using a workspace-local npm cache.
3. Review the entire committed branch delta, not an empty clean worktree:

   ```sh
   python3 /Users/jochen/projects/agent-stuff/codex/skills/claude-review-loop/bin/claude-review-loop \
     --repo "$PWD" --run-dir "$(mktemp -d)/review" \
     --baseline-ref origin/main --record-baseline --slice-id r84-pi-b16 \
     --model claude-opus-5-5 --effort high \
     --ledger-dir ../.cache/review-ledger --lock-dir ../.cache/review-locks
   ```

   Include caller-authored scope and validation evidence using `--context-file`.
   Fix findings and review repair deltas, at most four rounds; stop on a recurring
   required finding. Never treat a failed review as clean.
4. Only after a clean or suggestion-only passing gate, fetch immediately before
   merge. If origin moved, rebase and rerun checks. Merge locally into main with
   `--no-ff`, rerun full local checks and audit after merge before pushing main,
   then verify the remote SHA with `git ls-remote`.

Owner restrictions persist: no paid Actions reliance, workflow additions, PRs,
releases/tags, deployments, host access, work-app writes, remote-branch deletion
or writes under ~/projects. Feature pushes are allowed only to park unfinished
work. This parking commit uses [skip ci] to suppress existing push workflows.
