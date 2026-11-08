---
section: Fixed
audience: user
area: host
---

- **Sibling subagent sessions no longer block each other's git commands.** A child sharing a worktree with other children can switch, pull or rebase; a live non-subagent session on the same tree still blocks, and an unrecognised peer still fails toward refusal.
