---
section: Fixed
audience: user
area: lsp
---

- **A subagent skips the auxiliary LSP fleet only while it is attached to a peer.** The skip used to need a live peer instance on the child's own project root alone, which a child that never attached could not read from. It now also requires that warm attach (`PI_LENS_WARM_ATTACH=1`) reads that peer for that same root, and the answer is re-checked on each use: once the attachment or the peer is gone, the child enables its own opengrep/ast-grep/zizmor/typos fleet and stays enabled. A child with no warm attach now runs that fleet, while the LSP pre-warm and the eight startup scans stay skipped. (refs #713)
