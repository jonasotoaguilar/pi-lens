---
section: Fixed
audience: user
area: lsp
---

- **Warm attach now reaches a parent whose temporary directory differs.** A Gentle Shell subagent runs in its own temporary directory, so it used to look for the parent's diagnostics socket somewhere the parent never created it, then fall back to its own language-server fleet. Each session now records the endpoint it actually listens on, and an attaching session connects to that. A peer that records nothing keeps the previous derivation, and a recorded endpoint that no longer answers falls back to the local fleet as before. (refs #713)
