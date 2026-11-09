---
section: Fixed
audience: user
area: lsp
---

- **The LSP budget is charged per project root, with a machine-wide stop.** A fan-out of subagents across several roots no longer degrades a session whose own root is under its share; the machine total keeps its own ceiling.
