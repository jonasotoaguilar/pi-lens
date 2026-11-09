import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LSPDiagnostic } from "../../../clients/lsp/client.js";
import {
	AUXILIARY_LSP_PROFILES,
	applyAuxiliarySuppressions,
	configDisabledAuxiliaryLspServerIds,
	dropExcludedServers,
	enabledAuxiliaryLspServerIds,
	findAuxiliaryProfileForSource,
	isAuxiliaryDiagnosticSuppressed,
	retagAuxiliaryDiagnostics,
} from "../../../clients/dispatch/auxiliary-lsp.js";
import { convertLspDiagnostics } from "../../../clients/dispatch/utils/lsp-diagnostics.js";
import { resolvePiLensFlag } from "../../../clients/lens-config.js";
import { getLensFlagSpec } from "../../../clients/lens-flag-registry.js";
import { removeTempDirSync } from "../test-utils.js";
import { _resetSubagentModeForTests } from "../../../clients/subagent-mode.js";
import {
	checkCrossProcessLspBudget,
	_resetLspBudgetDecisionForTests,
} from "../../../clients/lsp-budget.js";

const diag = (over: Partial<LSPDiagnostic>): LSPDiagnostic =>
	({
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
		message: "x",
		severity: 2,
		...over,
	}) as LSPDiagnostic;

describe("auxiliary LSP enablement", () => {
	// #713: reset subagent classification between tests so env changes are picked up.
	beforeEach(() => {
		_resetSubagentModeForTests();
	});
	afterEach(() => {
		_resetSubagentModeForTests();
	});

	it("opengrep is default-on (no kill-switch flag set)", () => {
		const ids = enabledAuxiliaryLspServerIds(() => undefined);
		expect(ids).toContain("opengrep");
	});

	it("the no-opengrep kill switch disables it", () => {
		const ids = enabledAuxiliaryLspServerIds((f) => f === "no-opengrep");
		expect(ids).not.toContain("opengrep");
	});

	it("zizmor is default-on and the no-zizmor kill switch disables it (#272)", () => {
		expect(enabledAuxiliaryLspServerIds(() => undefined)).toContain("zizmor");
		expect(
			enabledAuxiliaryLspServerIds((f) => f === "no-zizmor"),
		).not.toContain("zizmor");
	});

	it("typos is default-on and the no-typos kill switch disables it (#283)", () => {
		expect(enabledAuxiliaryLspServerIds(() => undefined)).toContain("typos");
		expect(enabledAuxiliaryLspServerIds((f) => f === "no-typos")).not.toContain(
			"typos",
		);
	});

	// #713 + the peer-coverage premise: light mode skips the auxiliary fleet
	// only while a live peer instance serves THIS session's own project root —
	// the same-cwd parent the skip was written for. With no peer covering the
	// root the fleet must run here, or a delegated child (a different worktree,
	// an independent repository) loses opengrep/ast-grep/typos/zizmor coverage
	// of a tree nothing else scans.
	it("a subagent session with no peer on its root keeps the auxiliary fleet", () => {
		process.env.PI_SUBAGENT_CHILD = "1";
		_resetSubagentModeForTests();
		try {
			expect(enabledAuxiliaryLspServerIds(() => undefined)).toEqual([
				"opengrep",
				"ast-grep",
				"zizmor",
				"typos",
			]);
		} finally {
			delete process.env.PI_SUBAGENT_CHILD;
			_resetSubagentModeForTests();
		}
	});

	it("a subagent session with no peer on its root is gated exactly like a primary session", () => {
		process.env.PI_SUBAGENT_CHILD = "1";
		_resetSubagentModeForTests();
		try {
			const primary = enabledAuxiliaryLspServerIds(
				(flag) => flag === "no-zizmor",
			);
			delete process.env.PI_SUBAGENT_CHILD;
			_resetSubagentModeForTests();
			expect(
				enabledAuxiliaryLspServerIds((flag) => flag === "no-zizmor"),
			).toEqual(primary);
			expect(primary).toEqual(["opengrep", "ast-grep", "typos"]);
		} finally {
			delete process.env.PI_SUBAGENT_CHILD;
			_resetSubagentModeForTests();
		}
	});

	it("PI_LENS_SUBAGENT_FULL=1 restores auxiliaries inside a subagent session (#713)", () => {
		process.env.PI_SUBAGENT_CHILD = "1";
		process.env.PI_LENS_SUBAGENT_FULL = "1";
		_resetSubagentModeForTests();
		try {
			const ids = enabledAuxiliaryLspServerIds(() => undefined);
			expect(ids).toContain("opengrep");
			expect(ids).toContain("zizmor");
			expect(ids).toContain("typos");
		} finally {
			delete process.env.PI_SUBAGENT_CHILD;
			delete process.env.PI_LENS_SUBAGENT_FULL;
			_resetSubagentModeForTests();
		}
	});

	// The cross-process budget is charged per project root, so a Gentle Shell
	// fan-out no longer strips the fleet from a peer whose own root runs three
	// servers. Every case here runs as a primary session: this is the fleet gate
	// every session reads, not a subagent-only path.
	describe("cross-process budget", () => {
		const OWN_ROOT = "/worktrees/gentle-a";
		const PEER_ROOT = "/worktrees/gentle-b";
		const budgetChild = (pid: number) => ({
			pid,
			serverId: "typescript",
			command: "typescript-language-server",
			spawnedAt: new Date().toISOString(),
		});
		const budgetRoot = (pid: number, root: string, childCount: number) => ({
			pid,
			startedAt: new Date().toISOString(),
			projectRoot: root,
			projectRoots: [root],
			lspChildren: Array.from({ length: childCount }, (_, i) =>
				budgetChild(pid * 100 + i),
			),
			lspChildCount: childCount,
			rssBytes: 0,
			heartbeatAt: new Date().toISOString(),
		});

		beforeEach(() => {
			_resetLspBudgetDecisionForTests();
		});
		afterEach(() => {
			_resetLspBudgetDecisionForTests();
		});

		it("keeps the fleet for a peer whose own root is under its share in a fan-out", async () => {
			await checkCrossProcessLspBudget({
				registry: Array.from({ length: 8 }, (_, i) =>
					budgetRoot(10 + i, `/worktrees/fan-${i}`, 3),
				),
				isPidAlive: () => true,
				ownRoots: ["/worktrees/fan-3"],
			});

			expect(enabledAuxiliaryLspServerIds(() => undefined)).toEqual([
				"opengrep",
				"ast-grep",
				"zizmor",
				"typos",
			]);
		});

		it("skips the fleet for a session whose own root is at its budget", async () => {
			await checkCrossProcessLspBudget({
				registry: [budgetRoot(1, OWN_ROOT, 17), budgetRoot(2, PEER_ROOT, 2)],
				isPidAlive: () => true,
				ownRoots: [OWN_ROOT],
			});

			expect(enabledAuxiliaryLspServerIds(() => undefined)).toEqual([]);
		});
	});

	// Gentle Shell's vocabulary reaches the same #713 seam, so the existing gate
	// and its escape hatch apply without a second skip mechanism here. Each case
	// below sets its marker itself: the runner's own subagent vocabulary never
	// reaches a case, because `tests/support/vitest-setup.ts` deletes it for
	// every test file (a Gentle Shell child lane inherits
	// `GENTLE_PI_AGENTS_CHILD=1`, which turned the three default-on cases above
	// into light-mode cases: 3 red there, 0 with the marker unset).
	it("a Gentle Shell child with no peer on its root keeps the auxiliary fleet (#713 vocabulary)", () => {
		process.env.GENTLE_PI_AGENTS_CHILD = "1";
		_resetSubagentModeForTests();
		try {
			expect(enabledAuxiliaryLspServerIds(() => undefined)).toEqual([
				"opengrep",
				"ast-grep",
				"zizmor",
				"typos",
			]);
		} finally {
			delete process.env.GENTLE_PI_AGENTS_CHILD;
			_resetSubagentModeForTests();
		}
	});

	it("PI_LENS_SUBAGENT_FULL=1 restores auxiliaries inside a Gentle Shell child", () => {
		process.env.GENTLE_PI_AGENTS_CHILD = "1";
		process.env.PI_LENS_SUBAGENT_FULL = "1";
		_resetSubagentModeForTests();
		try {
			const ids = enabledAuxiliaryLspServerIds(() => undefined);
			expect(ids).toContain("opengrep");
			expect(ids).toContain("zizmor");
			expect(ids).toContain("typos");
		} finally {
			delete process.env.GENTLE_PI_AGENTS_CHILD;
			delete process.env.PI_LENS_SUBAGENT_FULL;
			_resetSubagentModeForTests();
		}
	});
});

describe("configDisabledAuxiliaryLspServerIds (#4323)", () => {
	beforeEach(() => {
		_resetSubagentModeForTests();
	});
	afterEach(() => {
		_resetSubagentModeForTests();
	});

	it("lists nothing when no kill switch is set", () => {
		expect([...configDisabledAuxiliaryLspServerIds(() => undefined)]).toEqual(
			[],
		);
	});

	it("lists opengrep when the no-opengrep kill switch is set", () => {
		expect([
			...configDisabledAuxiliaryLspServerIds((f) => f === "no-opengrep"),
		]).toEqual(["opengrep"]);
	});

	it("lists each profile whose kill switch is set, and only those", () => {
		const switches = new Set(["no-zizmor", "no-typos"]);
		expect(
			[...configDisabledAuxiliaryLspServerIds((f) => switches.has(f))].sort(),
		).toEqual(["typos", "zizmor"]);
	});

	it("treats a non-true flag value as not set", () => {
		expect([
			...configDisabledAuxiliaryLspServerIds((f) =>
				f === "no-opengrep" ? "false" : undefined,
			),
		]).toEqual([]);
	});

	// The resource degrade is not a configuration decision: an explicit check
	// still asks those scanners, so a subagent session excludes nothing.
	it("excludes nothing for a subagent session's light mode alone", () => {
		process.env.PI_SUBAGENT_CHILD = "1";
		_resetSubagentModeForTests();
		try {
			expect([...configDisabledAuxiliaryLspServerIds(() => undefined)]).toEqual(
				[],
			);
		} finally {
			delete process.env.PI_SUBAGENT_CHILD;
			_resetSubagentModeForTests();
		}
	});

	it("is the complement of the enabled set for every default-on profile outside the degrade", () => {
		const switches = new Set(["no-opengrep", "no-ast-grep"]);
		const getFlag = (f: string) => switches.has(f);
		const enabled = new Set(enabledAuxiliaryLspServerIds(getFlag));
		const disabled = configDisabledAuxiliaryLspServerIds(getFlag);
		for (const profile of AUXILIARY_LSP_PROFILES.filter(
			(p) => p.enabledByDefault,
		)) {
			expect(enabled.has(profile.serverId)).toBe(
				!disabled.has(profile.serverId),
			);
		}
		// #4929: an opt-in profile that is not enabled was not "switched off", so
		// it is never reported (auxiliary-lsp-opt-in-4929.test.ts names why).
		for (const profile of AUXILIARY_LSP_PROFILES.filter(
			(p) => !p.enabledByDefault,
		)) {
			expect(disabled.has(profile.serverId)).toBe(false);
		}
	});
});

describe("auxiliary profile skipTestFiles (#687)", () => {
	it("ast-grep skips test files (matches the in-process runner's own skipTestFiles)", () => {
		expect(
			AUXILIARY_LSP_PROFILES.find((p) => p.tool === "ast-grep")?.skipTestFiles,
		).toBe(true);
	});
});

describe("auxiliary profile source routing", () => {
	it("routes Opengrep's 'Semgrep' source to the opengrep profile", () => {
		expect(findAuxiliaryProfileForSource("Semgrep")?.tool).toBe("opengrep");
		expect(findAuxiliaryProfileForSource("opengrep")?.tool).toBe("opengrep");
	});

	it("routes zizmor's 'zizmor' source to the zizmor profile (#272)", () => {
		expect(findAuxiliaryProfileForSource("zizmor")?.tool).toBe("zizmor");
	});

	it("routes typos-lsp's 'typos' source to the typos profile (#283)", () => {
		expect(findAuxiliaryProfileForSource("typos")?.tool).toBe("typos");
	});

	it("ignores language-server sources and missing source", () => {
		expect(findAuxiliaryProfileForSource("typescript")).toBeUndefined();
		expect(findAuxiliaryProfileForSource("eslint")).toBeUndefined();
		expect(findAuxiliaryProfileForSource(undefined)).toBeUndefined();
	});
});

describe("opengrep semantic policy", () => {
	const opengrep = AUXILIARY_LSP_PROFILES.find(
		(p) => p.serverId === "opengrep",
	);

	it("blocks ERROR only where blocking is allowed (curated repo rules)", () => {
		expect(opengrep).toBeDefined();
		// blocking allowed (repo has its own rules): ERROR → blocking, else warning.
		expect(
			opengrep?.semantic(diag({ severity: 1 }), { blockingAllowed: true }),
		).toBe("blocking");
		expect(
			opengrep?.semantic(diag({ severity: 2 }), { blockingAllowed: true }),
		).toBe("warning");
	});

	it("never blocks the auto Community set (no local rules) — advisory only", () => {
		// blocking NOT allowed (auto): even ERROR stays a warning (surfaced in lens_diagnostics).
		expect(
			opengrep?.semantic(diag({ severity: 1 }), { blockingAllowed: false }),
		).toBe("warning");
		expect(
			opengrep?.semantic(diag({ severity: 2 }), { blockingAllowed: false }),
		).toBe("warning");
	});
});

describe("ast-grep semantic policy", () => {
	const astGrep = AUXILIARY_LSP_PROFILES.find((p) => p.serverId === "ast-grep");

	it("uses ast-grep severity for the shipped baseline as well as project sgconfig", () => {
		expect(astGrep).toBeDefined();
		expect(astGrep?.allowBlocking?.("/repo")).toBe(true);
		expect(
			astGrep?.semantic(diag({ severity: 1 }), { blockingAllowed: true }),
		).toBe("blocking");
		expect(
			astGrep?.semantic(diag({ severity: 2 }), { blockingAllowed: true }),
		).toBe("warning");
	});
});

describe("zizmor semantic policy (#272)", () => {
	const zizmor = AUXILIARY_LSP_PROFILES.find((p) => p.serverId === "zizmor");

	it("blocks High (ERROR) only where a repo zizmor.yml opts in; advisory otherwise", () => {
		expect(zizmor).toBeDefined();
		// curated repo config present → High blocks, Medium/Low stays advisory.
		expect(
			zizmor?.semantic(diag({ severity: 1 }), { blockingAllowed: true }),
		).toBe("blocking");
		expect(
			zizmor?.semantic(diag({ severity: 2 }), { blockingAllowed: true }),
		).toBe("warning");
		// no curated config → even High stays a warning (surfaced in lens_diagnostics).
		expect(
			zizmor?.semantic(diag({ severity: 1 }), { blockingAllowed: false }),
		).toBe("warning");
	});

	it("derives a defect class from the rule id", () => {
		const dc = zizmor?.defectClass?.(
			diag({
				code: "template-injection",
				message: "code injection via template",
			}),
		);
		expect(typeof dc === "string" || dc === undefined).toBe(true);
	});
});

describe("typos semantic policy (#283)", () => {
	const typos = AUXILIARY_LSP_PROFILES.find((p) => p.serverId === "typos");

	it("is advisory by default; blocks only ERROR where a repo typos.toml opts in", () => {
		expect(typos).toBeDefined();
		// no repo typos config → even an ERROR-severity finding stays advisory
		// (typos-lsp's own default severity is WARNING anyway).
		expect(
			typos?.semantic(diag({ severity: 1 }), { blockingAllowed: false }),
		).toBe("warning");
		expect(
			typos?.semantic(diag({ severity: 2 }), { blockingAllowed: false }),
		).toBe("warning");
		// repo opts in with a typos.toml AND raised severity to Error → blocks.
		expect(
			typos?.semantic(diag({ severity: 1 }), { blockingAllowed: true }),
		).toBe("blocking");
		expect(
			typos?.semantic(diag({ severity: 2 }), { blockingAllowed: true }),
		).toBe("warning");
	});

	it("classifies a misspelling as a style (docs/quality) defect — not security", () => {
		expect(
			typos?.defectClass?.(diag({ message: "`recieve` should be `receive`" })),
		).toBe("style");
	});
});

// #586: the single, generic lookup+apply helper every call site (per-edit
// dispatch runner, `tools/lsp-diagnostics.ts`, `runWorkspaceDiagnostics`)
// should use instead of re-deriving "find the profile by source, then check
// isSuppressed" independently.
describe("isAuxiliaryDiagnosticSuppressed / applyAuxiliarySuppressions (#586)", () => {
	const RULE =
		"python.lang.security.audit.subprocess-shell-true.subprocess-shell-true";

	it("drops an opengrep (Semgrep-sourced) diagnostic suppressed by `// nosemgrep`", () => {
		const content = "subprocess.run('ls', shell=True)  // nosemgrep\n";
		const d = diag({
			source: "Semgrep",
			code: RULE,
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			},
		});
		expect(isAuxiliaryDiagnosticSuppressed(d, content)).toBe(true);
		expect(applyAuxiliarySuppressions([d], content)).toEqual([]);
	});

	it("keeps the same diagnostic when there is no nosemgrep comment", () => {
		const content = "subprocess.run('ls', shell=True)\n";
		const d = diag({
			source: "Semgrep",
			code: RULE,
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			},
		});
		expect(isAuxiliaryDiagnosticSuppressed(d, content)).toBe(false);
		expect(applyAuxiliarySuppressions([d], content)).toEqual([d]);
	});

	it("is a no-op for profiles with no isSuppressed callback (e.g. ast-grep, zizmor, typos)", () => {
		const content = "anything\n";
		const astGrepDiag = diag({
			source: "ast-grep",
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			},
		});
		expect(isAuxiliaryDiagnosticSuppressed(astGrepDiag, content)).toBe(false);
		expect(applyAuxiliarySuppressions([astGrepDiag], content)).toEqual([
			astGrepDiag,
		]);
	});

	it("is a no-op for diagnostics with no matching auxiliary profile (plain language-server findings)", () => {
		const content = "anything\n";
		const tsDiag = diag({
			source: "typescript",
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			},
		});
		expect(isAuxiliaryDiagnosticSuppressed(tsDiag, content)).toBe(false);
		expect(applyAuxiliarySuppressions([tsDiag], content)).toEqual([tsDiag]);
	});

	it("filters a mixed list, keeping unsuppressed and dropping suppressed diagnostics", () => {
		const content = [
			"subprocess.run('a', shell=True)  // nosemgrep",
			"subprocess.run('b', shell=True)",
		].join("\n");
		const suppressed = diag({
			source: "Semgrep",
			code: RULE,
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			},
		});
		const kept = diag({
			source: "Semgrep",
			code: RULE,
			range: {
				start: { line: 1, character: 0 },
				end: { line: 1, character: 1 },
			},
		});
		expect(applyAuxiliarySuppressions([suppressed, kept], content)).toEqual([
			kept,
		]);
	});
});

// #692: the workspace sweep (`clients/lsp/index.ts`'s `runWorkspaceDiagnostics`)
// called `applyAuxiliarySuppressions` with only (diagnostics, content) — never a
// fileRole — so ast-grep's `skipTestFiles` (#687) gate, honored by the per-edit
// dispatch runner, never applied to a `mode=full` sweep. `opts.fileRole` closes
// that gap; omitting `opts` must keep every existing 2-arg call site unchanged.
describe("applyAuxiliarySuppressions fileRole gate (#692)", () => {
	const content = "anything\n";

	it("drops an ast-grep-sourced diagnostic when fileRole is 'test'", () => {
		const astGrepDiag = diag({
			source: "ast-grep",
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			},
		});
		expect(
			applyAuxiliarySuppressions([astGrepDiag], content, { fileRole: "test" }),
		).toEqual([]);
	});

	it("keeps opengrep/zizmor/typos findings on a test file (no skipTestFiles on those profiles)", () => {
		const opengrepDiag = diag({
			source: "Semgrep",
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			},
		});
		const zizmorDiag = diag({
			source: "zizmor",
			range: {
				start: { line: 1, character: 0 },
				end: { line: 1, character: 1 },
			},
		});
		const typosDiag = diag({
			source: "typos",
			range: {
				start: { line: 2, character: 0 },
				end: { line: 2, character: 1 },
			},
		});
		expect(
			applyAuxiliarySuppressions(
				[opengrepDiag, zizmorDiag, typosDiag],
				content,
				{ fileRole: "test" },
			),
		).toEqual([opengrepDiag, zizmorDiag, typosDiag]);
	});

	it("keeps ast-grep findings when fileRole is not 'test'", () => {
		const astGrepDiag = diag({
			source: "ast-grep",
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			},
		});
		expect(
			applyAuxiliarySuppressions([astGrepDiag], content, {
				fileRole: "source",
			}),
		).toEqual([astGrepDiag]);
	});

	it("without the third arg, behaves exactly as before (no test-file gating)", () => {
		const astGrepDiag = diag({
			source: "ast-grep",
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			},
		});
		expect(applyAuxiliarySuppressions([astGrepDiag], content)).toEqual([
			astGrepDiag,
		]);
	});
});

// #692: `retagAuxiliaryDiagnostics` is the shared helper extracted from the
// per-edit dispatch runner (`clients/dispatch/runners/lsp.ts`) so a scan/sweep
// reconcile path can give its aux-sourced findings identical tool/semantic/
// defectClass tagging instead of keeping tool "lsp" — verify it reproduces the
// exact per-edit behavior `runner-status-semantics.test.ts` already locks in.
describe("retagAuxiliaryDiagnostics (#692)", () => {
	it("re-tags an ast-grep finding with tool 'ast-grep' and its semantic policy", () => {
		const raw: LSPDiagnostic[] = [
			diag({
				source: "ast-grep",
				code: "no-eval",
				severity: 1,
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 1 },
				},
			}),
		];
		const converted = convertLspDiagnostics(raw, "/repo/a.ts");
		expect(converted[0].tool).toBe("lsp");
		const retagged = retagAuxiliaryDiagnostics(converted, raw, "", {
			cwd: "/repo",
			fileRole: "source",
		});
		expect(retagged).toHaveLength(1);
		expect(retagged[0].tool).toBe("ast-grep");
		expect(retagged[0].semantic).toBe("blocking");
	});

	it("drops ast-grep findings on test files (skipTestFiles), keeps opengrep's", () => {
		const raw: LSPDiagnostic[] = [
			diag({
				source: "ast-grep",
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 1 },
				},
			}),
			diag({
				source: "Semgrep",
				range: {
					start: { line: 1, character: 0 },
					end: { line: 1, character: 1 },
				},
			}),
		];
		const converted = convertLspDiagnostics(raw, "/repo/a.test.ts");
		const retagged = retagAuxiliaryDiagnostics(converted, raw, "", {
			cwd: "/repo",
			fileRole: "test",
		});
		expect(retagged).toHaveLength(1);
		expect(retagged[0].tool).toBe("opengrep");
	});

	it("honors native inline suppression (e.g. `// nosemgrep`) via the `content` argument", () => {
		const content = "subprocess.run('x', shell=True)  // nosemgrep\n";
		const raw: LSPDiagnostic[] = [
			diag({
				source: "Semgrep",
				code: "python.lang.security.audit.subprocess-shell-true.subprocess-shell-true",
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 1 },
				},
			}),
		];
		const converted = convertLspDiagnostics(raw, "/repo/a.py");
		const retagged = retagAuxiliaryDiagnostics(converted, raw, content, {
			cwd: "/repo",
			fileRole: "source",
		});
		expect(retagged).toEqual([]);
	});

	it("leaves plain language-server diagnostics (no matching profile) untouched, tool stays 'lsp'", () => {
		const raw: LSPDiagnostic[] = [
			diag({
				source: "typescript",
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 1 },
				},
			}),
		];
		const converted = convertLspDiagnostics(raw, "/repo/a.ts");
		const retagged = retagAuxiliaryDiagnostics(converted, raw, "", {
			cwd: "/repo",
			fileRole: "source",
		});
		expect(retagged).toHaveLength(1);
		expect(retagged[0].tool).toBe("lsp");
	});
});

// #3041 recurrence: ast-grep's LSP publishes per-document diagnostics WITHOUT
// applying a rule's own `ignores` globs (its `scan` walk does — verified against
// ast-grep 0.45.3), so every pi-lens route that delivers those diagnostics
// re-surfaced findings the NAPI runner correctly skips. Guarding it here, at the
// one shared drop-decision seam both routes call, is what keeps `source=lsp` and
// `mode=full` from drifting apart again the way #586 and #692 did.
describe("applyAuxiliarySuppressions per-rule ignores gate (#3041)", () => {
	const astGrepDiag = (code: string): LSPDiagnostic =>
		diag({ source: "ast-grep", code });
	// The shipped catalog rule whose own YAML carves out `scripts/**`, `bin/**`
	// and `**/logger.ts` (#965).
	const RULE = "no-console-except-error";
	const root = path.resolve("/repo");
	const content = "console.log('x');\n";

	it("drops a catalog rule finding on a path the rule ignores globs carve out", () => {
		expect(
			applyAuxiliarySuppressions([astGrepDiag(RULE)], content, {
				filePath: path.join(root, "scripts", "cli.ts"),
				scanRoot: root,
			}),
		).toEqual([]);
	});

	it("keeps the same rule finding on a path it does not carve out", () => {
		const kept = applyAuxiliarySuppressions([astGrepDiag(RULE)], content, {
			filePath: path.join(root, "src", "app.ts"),
			scanRoot: root,
		});
		expect(kept).toHaveLength(1);
	});

	it("keeps a rule that declares no ignores at all on the same carved-out path", () => {
		const kept = applyAuxiliarySuppressions(
			[astGrepDiag("no-alert")],
			content,
			{ filePath: path.join(root, "scripts", "cli.ts"), scanRoot: root },
		);
		expect(kept).toHaveLength(1);
	});

	it("leaves every diagnostic in place when the caller supplies no scan root", () => {
		const kept = applyAuxiliarySuppressions([astGrepDiag(RULE)], content, {
			filePath: path.join(root, "scripts", "cli.ts"),
		});
		expect(kept).toHaveLength(1);
	});
});

// #3041: the seam must read the SAME effective catalog the NAPI runner reads —
// project rule trees first, bundled second, first source wins per rule id. A
// project that redefines a bundled rule id with its own `ignores` would
// otherwise be carved out by the bundled globs over LSP and by its own globs
// per-edit, which is the drift this change exists to remove.
describe("rule-ignore catalog precedence (#3041)", () => {
	let tmp: string;
	const RULE = "no-console-except-error";
	const content = "console.log('x');\n";

	beforeEach(() => {
		tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-rule-ignores-precedence-"),
		);
	});
	afterEach(() => removeTempDirSync(tmp));

	/** Redefine the bundled rule id in the project tree, with or without ignores. */
	const writeProjectRule = (ignores?: readonly string[]) => {
		const dir = path.join(tmp, "rules", "ast-grep-rules", "rules");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, `${RULE}.yml`),
			[
				`id: ${RULE}`,
				"language: TypeScript",
				"severity: warning",
				'message: "project override"',
				...(ignores
					? ["ignores:", ...ignores.map((glob) => `  - "${glob}"`)]
					: []),
				"rule:",
				"  pattern: console.log($$$)",
				"",
			].join("\n"),
		);
	};

	const keptCount = (relative: string) =>
		applyAuxiliarySuppressions(
			[diag({ source: "ast-grep", code: RULE })],
			content,
			{ filePath: path.join(tmp, relative), scanRoot: tmp },
		).length;

	it("uses the project rule's ignores, not the bundled rule's, for the same id", () => {
		writeProjectRule(["vendor/**"]);
		expect(keptCount(path.join("vendor", "dep.ts"))).toBe(0);
		expect(keptCount(path.join("scripts", "cli.ts"))).toBe(1);
	});

	// #3041 r2 F1: the winning document declaring NO `ignores` is the inverted
	// case. `ast-grep-napi.ts` claims the id (`seenRuleIds.add`) BEFORE its own
	// ignore check, so a project rule that redefines a bundled id to fire
	// everywhere fires on scripts/** per-edit. Skipping a no-ignores document
	// without claiming its id let the LOWER-precedence bundled copy register its
	// `scripts/**` globs, so mode=full and source=lsp dropped what the runner
	// delivered — the same two surfaces disagreeing that this PR exists to fix,
	// only inverted.
	it("lets a project rule that declares no ignores override the bundled carve-out", () => {
		writeProjectRule();
		expect(keptCount(path.join("scripts", "cli.ts"))).toBe(1);
		expect(keptCount(path.join("src", "app.ts"))).toBe(1);
	});

	// #3041 r2 F2: a file outside `scanRoot` is matched by its ABSOLUTE path, not
	// by the `../..`-prefixed relative one — measured: with real catalog globs the
	// two forms disagree on 12 of 24 (root, file, pattern) combinations, e.g.
	// `**/logger.ts` matches `/elsewhere/lib/logger.ts` and never matches
	// `../../elsewhere/lib/logger.ts`. Without the fallback an out-of-tree logger
	// sink loses its carve-out entirely.
	it("matches an out-of-tree file by its absolute path", () => {
		const outside = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-rule-ignores-out-"),
		);
		try {
			const keptFor = (relative: string) =>
				applyAuxiliarySuppressions(
					[diag({ source: "ast-grep", code: RULE })],
					content,
					{ filePath: path.join(outside, relative), scanRoot: tmp },
				).length;
			// `**/logger.ts` reaches an absolute path; directory carve-outs
			// deliberately remain contained by the scan root.
			expect(keptFor(path.join("lib", "logger.ts"))).toBe(0);
			expect(keptFor(path.join("lib", "logger.js"))).toBe(0);
			expect(keptFor(path.join("lib", "logger.mjs"))).toBe(0);
			expect(keptFor(path.join("scripts", "cli.ts"))).toBe(1);
			expect(keptFor(path.join("bin", "cli.ts"))).toBe(1);
		} finally {
			removeTempDirSync(outside);
		}
	});

	// #3041 r2 F4: the map is built from the AST-GREP catalog, so a colliding rule
	// id from any other producer must NOT inherit its carve-out — a silently
	// dropped finding is the harm this change exists to stop.
	it("never drops a non-ast-grep finding whose code collides with a catalog id", () => {
		const kept = applyAuxiliarySuppressions(
			[diag({ source: "eslint", code: RULE })],
			content,
			{ filePath: path.join(tmp, "scripts", "cli.ts"), scanRoot: tmp },
		);
		expect(kept).toHaveLength(1);
	});
});

// #4365 rotation batch 1: the per-module Stryker campaign listed the survivors
// below as behaviours no test pins. Each case names the mutant (or the family
// of mutants) it kills; the mutation table in the PR body has the red per row.
describe("auxiliary profile table (#4365)", () => {
	beforeEach(() => {
		_resetSubagentModeForTests();
	});
	afterEach(() => {
		_resetSubagentModeForTests();
	});

	it("ast-grep is default-on, and its own kill switch removes exactly it", () => {
		// Pins the ast-grep profile's `enabledByDefault: true` and
		// `killSwitchFlag: "no-ast-grep"` (survivors: `false`, `""`), and the
		// disabled branch of the enabled-id `flatMap` yielding `[]` (survivor:
		// `["Stryker was here"]`, which `.not.toContain` cannot see).
		expect(enabledAuxiliaryLspServerIds(() => undefined)).toEqual([
			"opengrep",
			"ast-grep",
			"zizmor",
			"typos",
		]);
		expect(
			enabledAuxiliaryLspServerIds((flag) => flag === "no-ast-grep"),
		).toEqual(["opengrep", "zizmor", "typos"]);
	});

	it("routes every spelling of the ast-grep source to the ast-grep profile", () => {
		// Pins `sourceMatch: /ast[-_]?grep/i` (survivor: the optional separator
		// dropped, so `astgrep` stops routing and its findings keep tool "lsp").
		for (const source of ["ast-grep", "ast_grep", "astgrep", "AST-GREP"]) {
			expect(findAuxiliaryProfileForSource(source)?.tool, source).toBe(
				"ast-grep",
			);
		}
	});

	it("looks a source up once, then answers from the memo, for matches and non-matches alike", () => {
		// Pins the documented memo of `findAuxiliaryProfileForSource` (survivors:
		// the cache-hit condition forced `false`, `||` turned `&&`, and the
		// `profileForSourceCache.set` removed). Output is identical either way, so
		// the observable is how often the profile regexes are consulted: a hit
		// must not re-run them. Sources are unique to this case so no earlier test
		// has warmed the memo.
		const opengrep = AUXILIARY_LSP_PROFILES.find(
			(p) => p.serverId === "opengrep",
		);
		const typos = AUXILIARY_LSP_PROFILES.find((p) => p.serverId === "typos");
		const opengrepProbe = vi.spyOn(opengrep!.sourceMatch, "test");
		const typosProbe = vi.spyOn(typos!.sourceMatch, "test");
		try {
			findAuxiliaryProfileForSource("semgrep-memo-4365");
			findAuxiliaryProfileForSource("semgrep-memo-4365");
			expect(opengrepProbe).toHaveBeenCalledTimes(1);

			// No profile matches: the memo must still remember the miss. Typos is the
			// last profile, so it is consulted exactly once per uncached lookup.
			findAuxiliaryProfileForSource("plain-lsp-memo-4365");
			findAuxiliaryProfileForSource("plain-lsp-memo-4365");
			expect(typosProbe).toHaveBeenCalledTimes(1);
		} finally {
			opengrepProbe.mockRestore();
			typosProbe.mockRestore();
		}
	});

	it("keeps a plain language-server finding on a test file instead of throwing on its missing profile", () => {
		// Pins `profile?.skipTestFiles` in `applyAuxiliarySuppressions` (survivor:
		// `profile.skipTestFiles`, which throws a TypeError for any non-auxiliary
		// source the moment `fileRole` is "test").
		const plain = diag({ source: "typescript", code: 2322 });
		expect(
			applyAuxiliarySuppressions([plain], "", { fileRole: "test" }),
		).toEqual([plain]);
	});
});

describe("native inline suppression syntax (#4365)", () => {
	const at = (line: number, over: Partial<LSPDiagnostic> = {}) =>
		diag({
			source: "Semgrep",
			code: "rule-a",
			range: {
				start: { line, character: 0 },
				end: { line, character: 1 },
			},
			...over,
		});
	const zizmorAt = (line: number, over: Partial<LSPDiagnostic> = {}) =>
		at(line, { source: "zizmor", code: "artipacked", ...over });

	it("honours `nosemgrep` with no, one or several spaces after the comment marker", () => {
		// Pins the `\s*` between the marker and `nosemgrep` in NOSEMGREP_RE
		// (survivor: `\s`, which needs exactly one space).
		for (const comment of ["//nosemgrep", "// nosemgrep", "#    nosemgrep"]) {
			expect(
				isAuxiliaryDiagnosticSuppressed(at(0), `x() ${comment}\n`),
				comment,
			).toBe(true);
		}
	});

	it("reads the rule list after `nosemgrep:` with or without a space", () => {
		// Pins `(?::\s*(.+))?` in both nosemgrep regexes (survivors: `\s` makes the
		// whole list optional and silently turns `nosemgrep:other` into a BARE
		// suppress-everything comment; `\S*` leaves the list the wrong tail
		// `a` of `rule-a`).
		// Inline, list names a DIFFERENT rule: must not suppress.
		expect(
			isAuxiliaryDiagnosticSuppressed(at(0), "x() // nosemgrep:other-rule\n"),
		).toBe(false);
		// Inline, list names THIS rule without a space: suppresses.
		expect(
			isAuxiliaryDiagnosticSuppressed(at(0), "x() // nosemgrep:rule-a\n"),
		).toBe(true);
		// Line above, standalone, no space: suppresses the finding below it.
		expect(
			isAuxiliaryDiagnosticSuppressed(at(1), "// nosemgrep:rule-a\nx()\n"),
		).toBe(true);
		// And a list that does not name the rule leaves it alone.
		expect(
			isAuxiliaryDiagnosticSuppressed(at(1), "// nosemgrep:other\nx()\n"),
		).toBe(false);
	});

	it("accepts an indented, unspaced or trailing-space standalone comment above the finding", () => {
		// Pins NOSEMGREP_STANDALONE_RE's anchors (survivors: leading `\s*` as
		// `\S*`, the `\s*` before `nosemgrep` as `\s`, the trailing `\s*$` as
		// `\S*$`): indentation, a missing space and trailing whitespace are all
		// ordinary standalone comments that must keep suppressing the next line.
		for (const above of [
			"    // nosemgrep",
			"//nosemgrep",
			"// nosemgrep   ",
		]) {
			expect(
				isAuxiliaryDiagnosticSuppressed(at(1), `${above}\nx()\n`),
				JSON.stringify(above),
			).toBe(true);
		}
	});

	it("does not treat `nosemgrep` followed by more word characters as a standalone comment", () => {
		// Pins the `$` end anchor of NOSEMGREP_STANDALONE_RE (survivor: anchor
		// removed, so `// nosemgrepish` above a finding suppressed it).
		expect(
			isAuxiliaryDiagnosticSuppressed(at(1), "// nosemgrepish\nx()\n"),
		).toBe(false);
	});

	it("never matches an empty rule id against an empty entry in the list", () => {
		// Pins `.filter(Boolean)` on the parsed rule list (survivor: filter
		// dropped, so `nosemgrep: other,` held an empty entry and suppressed every
		// finding that carries no rule code).
		const noCode = at(0, { code: undefined });
		expect(
			isAuxiliaryDiagnosticSuppressed(noCode, "x() // nosemgrep: other,\n"),
		).toBe(false);
	});

	it("treats a diagnostic with no usable range as not suppressed, for both syntaxes", () => {
		// Pins the `range?.start?.line` guard and its early `return false`
		// (survivors: the optional chains made unconditional, which throw on a
		// server-supplied diagnostic with a missing range or start; and the
		// uncovered `return false` flipped to `true`).
		const content = "x() // nosemgrep\ny() # zizmor: ignore[artipacked]\n";
		for (const range of [undefined, {}] as unknown[]) {
			expect(
				isAuxiliaryDiagnosticSuppressed(
					at(0, { range: range as LSPDiagnostic["range"] }),
					content,
				),
			).toBe(false);
			expect(
				isAuxiliaryDiagnosticSuppressed(
					zizmorAt(0, { range: range as LSPDiagnostic["range"] }),
					content,
				),
			).toBe(false);
		}
	});

	it("honours zizmor's `ignore[...]` with no space after `#` or after the colon", () => {
		// Pins ZIZMOR_IGNORE_RE's `#\s*zizmor:\s*ignore` (survivors: either `\s*`
		// as `\s`): `#zizmor: ignore[x]` and `# zizmor:ignore[x]` are what people
		// type.
		for (const line of [
			"#zizmor: ignore[artipacked]",
			"# zizmor:ignore[artipacked]",
			"#   zizmor:   ignore[artipacked]",
		]) {
			expect(
				isAuxiliaryDiagnosticSuppressed(zizmorAt(0), `${line}\n`),
				line,
			).toBe(true);
		}
		expect(
			isAuxiliaryDiagnosticSuppressed(
				zizmorAt(0),
				"# zizmor: ignore[template-injection]\n",
			),
		).toBe(false);
	});
});

describe("auxiliary retag policy (#4365)", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) removeTempDirSync(root);
	});
	const workspace = (files: Record<string, string> = {}): string => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-aux-4365-"));
		roots.push(root);
		for (const [rel, body] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
			fs.writeFileSync(path.join(root, rel), body);
		}
		return root;
	};
	const retag = (raw: LSPDiagnostic[], cwd: string, content = "") =>
		retagAuxiliaryDiagnostics(
			convertLspDiagnostics(raw, "/repo/a.ts"),
			raw,
			content,
			{ cwd, fileRole: "source" },
		);
	const from = (source: string, over: Partial<LSPDiagnostic> = {}) =>
		diag({ source, ...over });

	it("downgrades a non-blocking ERROR to a warning, and leaves a blocking ERROR and a non-error alone", () => {
		// Pins the severity downgrade in `retagAuxiliaryDiagnostics` (survivors on
		// `d.semantic !== "blocking" && d.severity === "error"`: the whole test
		// forced true/false, `&&` as `||`, either operand forced true, `!==` and
		// `===` flipped, either literal blanked; and the uncovered block and
		// `"warning"` literal). Three rows, one per cell of the decision:
		//   non-blocking + error   -> severity "warning"
		//   blocking     + error   -> severity "error"   (a blocker keeps its rank)
		//   non-blocking + info    -> severity "info"    (only errors are demoted)
		const noConfig = workspace();
		const curated = workspace({ ".opengrep.yml": "rules: []\n" });

		const [demoted] = retag([from("Semgrep", { severity: 1 })], noConfig);
		expect(demoted.semantic).toBe("warning");
		expect(demoted.severity).toBe("warning");

		const [kept] = retag([from("Semgrep", { severity: 1 })], curated);
		expect(kept.semantic).toBe("blocking");
		expect(kept.severity).toBe("error");

		const [info] = retag([from("Semgrep", { severity: 3 })], noConfig);
		expect(info.semantic).toBe("warning");
		expect(info.severity).toBe("info");
	});

	it("each profile that gates blocking on a local config reports it from the workspace", () => {
		// Pins the `allowBlocking` lambdas of opengrep, zizmor and typos
		// (survivors: each `(cwd) => Boolean(findLocal...(cwd))` replaced by
		// `() => undefined`, which makes the curated-config opt-in a dead letter).
		const byId = (id: string) =>
			AUXILIARY_LSP_PROFILES.find((p) => p.serverId === id);
		expect(
			byId("opengrep")?.allowBlocking?.(
				workspace({ ".opengrep.yml": "rules: []\n" }),
			),
		).toBe(true);
		expect(
			byId("zizmor")?.allowBlocking?.(
				workspace({ ".github/zizmor.yml": "rules: {}\n" }),
			),
		).toBe(true);
		expect(
			byId("typos")?.allowBlocking?.(workspace({ "typos.toml": "[files]\n" })),
		).toBe(true);
	});

	it("computes a profile's blocking gate once per call, however many findings it tags", () => {
		// Pins the documented "computed once per dispatch" memo
		// (`blockingAllowedByProfile`; survivors: the miss test forced `true` and
		// the `set` removed): `allowBlocking` walks the filesystem for a config,
		// and a 200-finding file must not pay that 200 times.
		const opengrep = AUXILIARY_LSP_PROFILES.find(
			(p) => p.serverId === "opengrep",
		);
		const gate = vi.spyOn(
			opengrep as { allowBlocking: (cwd: string) => boolean },
			"allowBlocking",
		);
		try {
			retag(
				[
					from("Semgrep", { severity: 1 }),
					from("Semgrep", { severity: 1 }),
					from("Semgrep", { severity: 2 }),
				],
				workspace(),
			);
			expect(gate).toHaveBeenCalledTimes(1);
		} finally {
			gate.mockRestore();
		}
	});

	it("never blocks, and does not throw, for a profile that declares no allowBlocking", () => {
		// Pins the documented "Absent => never blocks" (survivors:
		// `allowBlocking?.(...)` made unconditional, which throws, and the `?? false`
		// fallback flipped to `true`, which would let an undeclared gate block).
		const typos = AUXILIARY_LSP_PROFILES.find((p) => p.serverId === "typos")!;
		const declared = typos.allowBlocking;
		delete (typos as { allowBlocking?: unknown }).allowBlocking;
		try {
			const [d] = retag([from("typos", { severity: 1 })], workspace());
			expect(d.semantic).toBe("warning");
			expect(d.severity).toBe("warning");
		} finally {
			typos.allowBlocking = declared;
		}
	});

	it("classifies every auxiliary's findings from the rule id AND the message", () => {
		// Pins each profile's `defectClass` lambda (survivors: the lambda replaced
		// by `() => undefined` for opengrep, ast-grep and zizmor; `d.code ?? ""`
		// as `d.code && ""`, which drops the rule id; `d.message ?? ""` as
		// `d.message && ""`, which drops the message) and the `if (defectClass)`
		// assignment (survivor: forced `false`, so nothing is ever stamped).
		// Row A can only be classified from the rule id, row B only from the
		// message, so losing either input changes the class.
		for (const source of ["Semgrep", "ast-grep", "zizmor"]) {
			const [byRule, byMessage] = retag(
				[
					from(source, { code: "empty-catch", message: "note" }),
					from(source, {
						code: "r1",
						message: "unsafe deserialization of payload",
					}),
				],
				workspace(),
			);
			expect(byRule.defectClass, `${source} by rule id`).toBe("silent-error");
			expect(byMessage.defectClass, `${source} by message`).toBe("safety");
		}
		const [typo] = retag(
			[from("typos", { message: "`recieve`" })],
			workspace(),
		);
		expect(typo.defectClass).toBe("style");
	});

	it("stamps no defectClass at all for a profile that declares none", () => {
		// Pins `profile.defectClass?.(...)` and the `if (defectClass)` guard
		// (survivors: the optional call made unconditional, which throws; the
		// guard forced `true`, which stamps an explicit `defectClass: undefined`
		// key that downstream `in` / spread checks read as "classified").
		const opengrep = AUXILIARY_LSP_PROFILES.find(
			(p) => p.serverId === "opengrep",
		)!;
		const declared = opengrep.defectClass;
		delete (opengrep as { defectClass?: unknown }).defectClass;
		try {
			const [d] = retag(
				[from("Semgrep", { code: "empty-catch" })],
				workspace(),
			);
			expect(d.tool).toBe("opengrep");
			expect(Object.hasOwn(d, "defectClass")).toBe(false);
		} finally {
			opengrep.defectClass = declared;
		}
	});
});

// #4946: `killSwitchFlag: "no-typos"` and `"no-zizmor"` were read for months
// while the registry registered neither, so the host answered `undefined` and
// neither server could be switched off. Every case resolves the profile's
// switch through the production resolver (`resolvePiLensFlag`: host value,
// global config, registry default), the way `index.ts` and the MCP host do.
describe("every auxiliary kill switch is a registered switch (#4946)", () => {
	beforeEach(() => {
		_resetSubagentModeForTests();
	});
	afterEach(() => {
		_resetSubagentModeForTests();
	});

	const switchable = AUXILIARY_LSP_PROFILES.filter((p) => p.killSwitchFlag);

	// #4929: an opt-in profile (`fallow`) is switched by its `optInFlag`, not a
	// kill switch, so the kill switches cover exactly the default-on profiles.
	it("covers every default-on profile", () => {
		expect(switchable.map((p) => p.serverId).sort()).toEqual(
			AUXILIARY_LSP_PROFILES.filter((p) => p.enabledByDefault)
				.map((p) => p.serverId)
				.sort(),
		);
	});

	it.each(switchable.map((p) => [p.serverId, p.killSwitchFlag as string]))(
		"%s: %s is registered, negated and off by default",
		(_serverId, flag) => {
			const spec = getLensFlagSpec(flag);
			expect(spec, `${flag} is not in LENS_FLAGS`).toBeDefined();
			expect(spec?.negated).toBe(true);
			expect(spec?.default).toBe(false);
		},
	);

	it.each(switchable.map((p) => [p.serverId, p.killSwitchFlag as string]))(
		"%s is switched off by its CLI flag and by its global config key, and on otherwise",
		(serverId, flag) => {
			const spec = getLensFlagSpec(flag);
			const [section, key] = (spec?.configKey ?? "").split(".");
			const reader =
				(host: boolean, config: Record<string, unknown>) => (name: string) =>
					resolvePiLensFlag(name, host && name === flag, config);
			expect(enabledAuxiliaryLspServerIds(reader(false, {}))).toContain(
				serverId,
			);
			expect(enabledAuxiliaryLspServerIds(reader(true, {}))).not.toContain(
				serverId,
			);
			expect(
				enabledAuxiliaryLspServerIds(
					reader(false, { [section as string]: { [key as string]: false } }),
				),
			).not.toContain(serverId);
			expect([
				...configDisabledAuxiliaryLspServerIds(reader(true, {})),
			]).toEqual([serverId]);
		},
	);

	// A warm-attached peer answers every auxiliary whatever this process's
	// switches say; the receipt drops a switched-off server's rows and its name
	// in the coverage gap (#4944), for typos and zizmor as for the others.
	it.each(switchable.map((p) => [p.serverId, p.killSwitchFlag as string]))(
		"%s: a peer answer drops its rows (by serverId or by source) and its gap name when switched off",
		(serverId, flag) => {
			const profile = AUXILIARY_LSP_PROFILES.find(
				(p) => p.serverId === serverId,
			);
			const source = profile?.tool ?? serverId;
			const answer = {
				diagnostics: [
					diag({ serverId, message: "by id" }),
					diag({ source, message: "by source" }),
					diag({ serverId: "typescript", source: "ts", message: "primary" }),
				],
				unconfirmedServerIds: [serverId, "typescript"],
			};
			const excluded = configDisabledAuxiliaryLspServerIds((name) =>
				resolvePiLensFlag(name, name === flag, {}),
			);
			const kept = dropExcludedServers(answer, excluded);
			expect(kept.diagnostics.map((d) => d.message)).toEqual(["primary"]);
			expect(kept.unconfirmedServerIds).toEqual(["typescript"]);
			// Nothing switched off: the answer is unchanged.
			expect(dropExcludedServers(answer, new Set()).diagnostics).toHaveLength(
				3,
			);
		},
	);
});
