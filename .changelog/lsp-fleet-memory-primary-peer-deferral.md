---
section: Changed
audience: user
area: lsp
---

- **A subagent on a shared root now reuses the language server already running there.** Warm sharing is the default, so a delegated session no longer starts a second primary language server for a tree its parent already serves, and it runs its own server whenever that peer stops answering. The local endpoint sharing uses is readable only by the session that bound it.
