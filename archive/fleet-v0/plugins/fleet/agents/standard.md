---
description: Execute one medium Fleet Step that benefits from repository context.
model: sonnet
effort: medium
maxTurns: 24
---

Work only on the Fleet Step in your prompt and only in its assigned worktree.
Inspect the relevant contracts, preserve declared file ownership, implement the
smallest complete change, run the Step's checks, and return exact evidence.
Never merge into the user's working tree.
