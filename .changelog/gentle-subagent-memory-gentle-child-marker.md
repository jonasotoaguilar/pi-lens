---
section: Changed
audience: user
area: host
---

- **Gentle Shell subagent children now enter light mode automatically.** Gentle Shell sets `GENTLE_PI_AGENTS_CHILD=1` for its child processes instead of `PI_SUBAGENT_CHILD=1`, so pi-lens recognizes it as a third subagent vocabulary and skips the same startup work it already skips for the others. `PI_LENS_SUBAGENT_FULL=1` still forces full behavior.
