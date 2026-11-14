---
section: Fixed
audience: user
area: lsp
---

- **A language server no longer starts inside pi-lens' own data directories.** A file kept under the extension's own storage used to root a server there, so the fleet indexed our caches and reports; it is now declined once per session with the reason naming which directory refused it, and a normal project still starts normally.
