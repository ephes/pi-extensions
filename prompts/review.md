---
description: Review the current diff with the bundled reviewer agent workflow
---
Use the `agent_workflow` tool in single-agent mode.

Agent: `reviewer`
Task:
Review the current uncommitted diff in the current repository. Focus on bugs, regressions, hidden coupling, incorrect abstractions, maintainability risks, and security issues. Use read-only bash commands only if needed (`git diff`, `git log`, `git show`).

Additional review instructions:
$@
