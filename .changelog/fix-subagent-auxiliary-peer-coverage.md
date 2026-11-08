---
section: Fixed
audience: user
area: lsp
---

- **A subagent session keeps its auxiliary scanners unless a peer covers its root.** Opengrep, ast-grep, zizmor and typos no longer go dark in a child agent started in another worktree or repository, where no other session scans that tree. (refs #713)
