---
section: Fixed
audience: user
area: lsp
---

- **An idle language server now stops on its own per-project timer.** A project whose servers were never measured for eviction used to wait for a whole-session reset, so a client the session had just used could be released in the same sweep as one idle for minutes. Each client now carries its own bound and its release names the root. Servers declared to stay resident keep waiting for the session reset. (refs #449)
