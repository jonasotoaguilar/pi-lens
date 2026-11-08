---
section: Fixed
audience: user
area: installer
---

- **A session that lost the install-lock race now uses the tool the winner installed.** It asks discovery once more before recording a skip, so a fan-out of subagents no longer runs without a tool that is already on disk.
