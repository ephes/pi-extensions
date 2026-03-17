---
description: Implement a change, review it, then apply the review feedback
---
Use the `agent_workflow` tool with the chain parameter to execute this workflow:

1. First, use the `implementer` agent to implement the following in the current repository and run `just check` before finishing:
   $@
2. Then, use the `reviewer` agent to review the implementation and the current diff. Use the previous step's output as supplementary context via `{previous}`, but review the actual current diff rather than relying only on the implementer's summary.
3. Finally, use the `implementer` agent to apply the review feedback from the previous step via `{previous}`, update docs if needed, and run `just check` again before finishing.

Execute this as a chain, passing output between steps via `{previous}`.
