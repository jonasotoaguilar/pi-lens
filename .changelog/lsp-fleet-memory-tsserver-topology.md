---
section: Changed
audience: user
area: lsp
---

- **One TypeScript project now runs one language server process.** TypeScript projects forked an extra syntax server beside the semantic one. Each launch now records the variant and the topology pi-lens asked for, so the process count is visible. (refs #449)
