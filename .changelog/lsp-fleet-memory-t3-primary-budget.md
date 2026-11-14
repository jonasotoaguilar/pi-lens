---
section: Changed
audience: user
area: lsp
---

- **A session over its language-server budget now starts no new primary server.** Servers it already owns keep answering, and one row names the root and the ceiling that refused the spawn. A root that is inside its own share still starts nothing new once the machine reaches its own stop, because a budget that must never evict another instance's live server can only turn the newcomer away. `PI_LENS_LSP_BUDGET_CEILING` and `PI_LENS_LSP_BUDGET_ROOT_CEILING` raise both count ceilings, `PI_LENS_LSP_BUDGET_RSS_MB` sets a memory stop that is off while unset, and `PI_LENS_CROSS_PROCESS_BUDGET=0` or `PI_LENS_INSTANCE_REGISTRY=0` turns the budget off. (refs #449)
