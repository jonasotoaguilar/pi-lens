/**
 * Cross-process LSP budget (#449 slice 2).
 *
 * Every concurrent pi-lens process is visible to every other one via
 * `~/.pi-lens/instances.json` (`clients/instance-registry.ts`). This module
 * reads that registry and decides, for THIS session only, whether to shed work:
 * a process that finds itself under pressure degrades its OWN spawn plan and
 * never touches another instance's already-running servers.
 *
 * Deliberately NOT a clearinghouse: no negotiation, no reservation, no
 * cross-process locking. Each session reads the registry once at
 * `session_start`, decides locally, and moves on — a "position limit," per the
 * issue's own framing, not shared ownership of anyone else's servers.
 *
 * Accounting rule: PER ROOT, with a machine-wide stop. Counting every live LSP
 * child on the machine against one number charged a fan-out for load it did not
 * cause: eight Gentle Shell children in eight worktrees, three servers each,
 * pushed the machine total past the old ceiling, and the child that started
 * last shed its fleet while its own root ran three servers. Two numbers replace
 * that one:
 *
 * - `rootCeiling` (`DEFAULT_LSP_BUDGET_ROOT_CEILING = 16`) — the budget for ONE
 *   project root, the original RAM back-of-envelope: ~250MB average RSS per
 *   live LSP child (typescript-language-server/pyright cold-index spikes
 *   higher, short-lived auxiliaries like typos-lsp are much lighter, so this is
 *   a rough blend) against a soft ~4GB target per working tree. A host's fleet
 *   is charged to its primary root ({@link getInstanceRoots}'s index 0) because
 *   `LspChildEntry` carries no root of its own; a session degrades when ITS OWN
 *   root is at or over this number, whatever the rest of the machine runs.
 * - `machineCeiling` (`DEFAULT_LSP_BUDGET_CEILING = rootCeiling × 4 = 64`) — the
 *   machine-wide stop, kept as the backstop against a genuinely runaway fleet
 *   (several roots at their full budget, or a leak). Headroom is deliberate: a
 *   legitimate fan-out of small children can never trip it, and the designed
 *   remedy for machine-wide pressure is the root that exceeds its share
 *   shedding. That preference is about the AUXILIARY shed; the PRIMARY refusal
 *   cannot honour it, because it may not evict a live server, and the cost is
 *   named as an excluded default below. `PI_LENS_LSP_BUDGET_CEILING` still
 *   caps the machine, and `PI_LENS_LSP_BUDGET_ROOT_CEILING` the single root.
 *
 * Excluded defaults, all three deliberate and all named here because the rule
 * reads narrower than the machine it guards:
 *
 * - A session that cannot name its own root keeps the pre-split machine-wide
 *   rule at the SMALLER of the two ceilings: it cannot prove it is under its
 *   share, so it stays conservative. In production `clients/lsp-budget.ts`
 *   always names one (this process's registry entry, else the same
 *   `process.cwd()` fallback the host adapters register with).
 * - RSS pressure stays machine-wide. It measures the machine's real memory, and
 *   no per-root share can bound that; a root under its LSP count budget still
 *   degrades when the aggregate is over the configured RSS ceiling.
 * - A root that is INSIDE its own share still starts no new primary server once
 *   the MACHINE is at its stop, and that is deliberate rather than an
 *   oversight. A ceiling that may never evict, close or steal another
 *   instance's live server can only refuse the newcomer, so the run-wide stop
 *   turns away a session whose own root is well under its share — the trade the
 *   per-root split buys, taken knowingly. Population at the defaults
 *   (`rootCeiling` 16, machine stop 64 = 16 x 4): every primary THIS session has
 *   not started yet — one per language it has not yet touched, and, for a
 *   session that starts while the machine is already at the stop, its whole
 *   primary fleet (its servers for the languages of the files it opens,
 *   typically one to three). Servers it already owns are never touched: the
 *   refusal is about new spawns. The escapes, all verified against this file:
 *   `PI_LENS_LSP_BUDGET_CEILING` (the machine stop),
 *   `PI_LENS_LSP_BUDGET_ROOT_CEILING` (one root's budget),
 *   `PI_LENS_LSP_BUDGET_RSS_MB` (the memory stop, off while unset),
 *   `PI_LENS_CROSS_PROCESS_BUDGET=0` (this module off, every reader answers
 *   "admitted") and `PI_LENS_INSTANCE_REGISTRY=0` (no registry read, so no
 *   verdict is ever taken). `PI_LENS_LSP_BUDGET_IDLE_TIMEOUT_MS` is NOT an
 *   escape: it only shortens this session's idle reset.
 *
 * Degrade mechanisms, cheapest first. All four read the same decision:
 *
 * - skip spawning AUXILIARY LSP servers (role:"auxiliary" in
 *   clients/lsp/server.ts — opengrep, ast-grep, zizmor, typos, marksman) for the
 *   remainder of THIS session. Auxiliaries are cross-cutting scanners layered on
 *   top of (not required for) core diagnostics, so this is the cheapest,
 *   highest-signal thing to shed under pressure (`shouldDegradeAuxiliaryLsp`,
 *   read by `clients/dispatch/auxiliary-lsp.ts`);
 * - refuse this session's NEXT PRIMARY spawn (T3 of
 *   odd/tasks/lsp-fleet-memory, `cachedPrimarySpawnRefusal`, read by
 *   `ClientRegistry.ensureClientForServer` right before it would start a
 *   process). DEGRADE, NEVER EVICT: the refusal is about new spawns only. Every
 *   server this session already owns keeps running and keeps answering — a
 *   warm touch returns the live client before the spawn path is ever reached —
 *   and this module never closes, kills or steals another instance's live
 *   server. No server is preempted; a session that is over its share simply
 *   stops ADDING to it;
 * - shorten this session's idle reset;
 * - let pull-capable servers skip their push fallback.
 *
 * The primary refusal's population is every primary spawn this session would
 * start, with no caller-side door left out: an explicit `lens_diagnostics`
 * query, a `clientScope: "all"` sweep, an explicit navigation/rename request
 * and the quick-mode prewarm all acquire through the same spawn path, and the
 * remedy for a root over its share is that the root stops growing. Joining a
 * spawn another caller already has in flight is NOT refused — no process is
 * started there, so there is nothing to shed.
 *
 * WHERE the mid-session re-check lives, and why: at the spawn decision, not on
 * the touch. The spawn path is reached only when a new process would start, so
 * a warm edit pays nothing at all (a keystroke that finds a live client never
 * reaches it), while the case this exists for — a session that was inside
 * budget at `session_start` and is over it an hour later — is caught exactly
 * when it matters. `cachedPrimarySpawnRefusal` answers from the decision
 * already taken and touches no disk, so the common cold spawn adds no await to
 * the seam; only a decision older than {@link DEFAULT_LSP_BUDGET_RECHECK_MS}
 * (see `primarySpawnBudgetRecheckDue`) re-reads the registry, once
 * (single-flight, so concurrent cold spawns share one read). The gate also sits
 * BEFORE the registry's capacity eviction: a spawn it refuses must never cost
 * another client its server.
 *
 * Kill switch: `PI_LENS_CROSS_PROCESS_BUDGET=0` disables this module
 * entirely (every session always spawns its full fleet, today's behavior) —
 * lazy env read, never memoized, matching the house style
 * (session-lifecycle.ts / runtime-config.ts).
 */

import { recordDegradationOnce } from "./degradation-ledger.js";
import {
	getAuthoritativeInstanceRoots,
	getInstanceRoots,
	type InstanceEntry,
	isInstanceRegistryEnabled,
	readInstanceRegistry,
} from "./instance-registry.js";
import { realIsPidAlive, STALE_HEARTBEAT_MS } from "./instance-reaper.js";
import { logLatency } from "./latency-logger.js";
import { normalizeFilePath } from "./path-utils.js";
import {
	isInPidNamespace,
	ownPidNamespace,
	ownProcessStartIfKnown,
} from "./process-snapshot.js";
import { createSingleFlight } from "./single-flight.js";

/** Budget for one project root. See the module docstring for the derivation. */
export const DEFAULT_LSP_BUDGET_ROOT_CEILING = 16;

/** How long a budget verdict is trusted before the spawn path re-reads the
 *  registry. A bound on the re-check, not a cache lifetime: the decision is
 *  still taken once at `session_start` and only RE-decided when a spawn asks
 *  after this interval, which is why a warm session pays nothing. */
export const DEFAULT_LSP_BUDGET_RECHECK_MS = 30_000;
/** How many full-budget roots the machine-wide stop is willing to carry. */
export const DEFAULT_LSP_BUDGET_MACHINE_HEADROOM = 4;
/** Machine-wide stop. See the module docstring for why it sits above one root. */
export const DEFAULT_LSP_BUDGET_CEILING =
	DEFAULT_LSP_BUDGET_ROOT_CEILING * DEFAULT_LSP_BUDGET_MACHINE_HEADROOM;
export const DEFAULT_LSP_BUDGET_IDLE_TIMEOUT_MS = 60_000;

/** `PI_LENS_CROSS_PROCESS_BUDGET=0` disables the budget check entirely —
 *  lazy env read (house style), never memoized so tests can flip it mid-run. */
export function isCrossProcessBudgetEnabled(): boolean {
	return process.env.PI_LENS_CROSS_PROCESS_BUDGET !== "0";
}

/** `PI_LENS_LSP_BUDGET_ROOT_CEILING` overrides
 *  {@link DEFAULT_LSP_BUDGET_ROOT_CEILING}. Non-finite/non-positive overrides
 *  are ignored (NaN-guard house style, see clients/runtime-config.ts) — falls
 *  back to the default rather than silently producing a ceiling of 0 (which
 *  would degrade every session). */
export function getLspBudgetRootCeiling(): number {
	const raw = Number(process.env.PI_LENS_LSP_BUDGET_ROOT_CEILING);
	return Number.isFinite(raw) && raw > 0
		? raw
		: DEFAULT_LSP_BUDGET_ROOT_CEILING;
}

/** `PI_LENS_LSP_BUDGET_CEILING` overrides {@link DEFAULT_LSP_BUDGET_CEILING},
 *  the machine-wide stop. Same NaN guard as every ceiling reader here. */
export function getLspBudgetCeiling(): number {
	const raw = Number(process.env.PI_LENS_LSP_BUDGET_CEILING);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LSP_BUDGET_CEILING;
}

/** Optional aggregate host + LSP-child RSS ceiling. Undefined means disabled. */
export function getLspBudgetRssCeilingBytes(): number | undefined {
	const raw = Number(process.env.PI_LENS_LSP_BUDGET_RSS_MB);
	return Number.isFinite(raw) && raw > 0 ? raw * 1024 * 1024 : undefined;
}

export function getLspBudgetIdleTimeoutMs(): number {
	const raw = Number(process.env.PI_LENS_LSP_BUDGET_IDLE_TIMEOUT_MS);
	return Number.isFinite(raw) && raw > 0
		? raw
		: DEFAULT_LSP_BUDGET_IDLE_TIMEOUT_MS;
}

export interface LspBudgetDecision {
	/** Sum of `lspChildren.length` across every registry entry whose owning pid
	 *  is currently alive. Entries whose parent pid is dead are excluded —
	 *  their children are the orphan reaper's job (clients/instance-reaper.ts),
	 *  not counted as "live" load here. */
	totalLiveLspServers: number;
	/** The machine-wide stop. */
	ceiling: number;
	/** The budget for one project root. */
	rootCeiling: number;
	/** The roots this session named as its own, when it named any. */
	ownRoots?: string[];
	/** Live LSP children charged to this session's own root — the largest of its
	 *  roots when it serves several. Absent when the session named none. */
	ownRootLoad?: number;
	/** The root key that carried {@link ownRootLoad}, named so a refusal record
	 *  spells the root the decision actually measured. Absent with no named root. */
	ownRootKey?: string;
	ownRootOverBudget: boolean;
	machineOverBudget: boolean;
	/** The count-based verdict this session applies: its own root against
	 *  `rootCeiling` plus the machine stop, or — with no root named — the total
	 *  against the smaller of the two ceilings. */
	countOverBudget: boolean;
	totalRssBytes?: number;
	rssCeilingBytes?: number;
	rssPressure: boolean;
	overBudget: boolean;
	/** The one degrade mechanism this module implements: skip auxiliary
	 *  LSP servers for the current session. Equal to `overBudget` today —
	 *  broken out as its own field so a future slice can add a second,
	 *  independently-triggered mechanism without every caller needing to
	 *  re-derive it from `overBudget`. */
	degradeAuxiliary: boolean;
	/** T3: refuse this session's next PRIMARY spawn. Equal to `overBudget`
	 *  today, broken out for the same reason as `degradeAuxiliary`: the spawn
	 *  gate reads ITS mechanism, not a re-derived verdict. */
	degradePrimarySpawn: boolean;
	shortenIdleTimeout: boolean;
	preferPullOnly: boolean;
}

/** Why this session's next primary spawn is refused, and the ceiling that
 *  refused it. Read from the decision, never re-derived at the spawn site. */
export interface LspPrimarySpawnRefusal {
	/** The session root the decision charged, in its normalized identity form.
	 *  Empty only for a session that named no root at all (see {@link basis}). */
	root: string;
	/** The ceiling that refused, in that basis's own unit: live LSP servers for
	 *  `"root"` and `"machine"`, bytes for `"rss"`. */
	ceiling: number;
	/** Which stop refused: this root's share, the machine-wide backstop, the
	 *  machine RSS stop, or — for a session that named no root — the pre-split
	 *  machine-wide rule at the smaller of the two count ceilings. */
	basis: "root" | "machine" | "rss" | "unrooted";
	/** The load measured on that basis's axis when the decision was taken. */
	load: number | undefined;
}

export interface LspBudgetOptions {
	/** Machine-wide stop. Defaults to {@link DEFAULT_LSP_BUDGET_CEILING}. */
	machineCeiling?: number;
	/** One root's budget. Defaults to {@link DEFAULT_LSP_BUDGET_ROOT_CEILING}. */
	rootCeiling?: number;
	/**
	 * Machine RSS stop. The caller supplies whatever the environment resolves
	 * (an unset/undecidable ceiling is `undefined`), so the declaration admits
	 * that answer rather than forcing the caller to drop the key.
	 */
	rssCeilingBytes?: number | undefined;
	now?: number;
	/** The deciding process's pid namespace, when the host can name one. */
	ownNamespace?: string | undefined;
	/** The roots the deciding session serves. Omit — or pass the `undefined` the
	 *  resolver answers when it cannot name a namespace — when it cannot name one;
	 *  the pre-split machine-wide rule then applies (see the module docstring). */
	ownRoots?: readonly string[] | undefined;
}

/** The root keys a session named, or `undefined` when it named none. */
function ownRootKeys(
	roots: readonly string[] | undefined,
): string[] | undefined {
	if (roots === undefined) return undefined;
	const keys: string[] = [];
	for (const root of roots) {
		const key = normalizeFilePath(root);
		if (key.length > 0) keys.push(key);
	}
	return keys.length > 0 ? keys : undefined;
}

/**
 * PURE decision function — no I/O. Mirrors `decideOrphanReaping`'s shape
 * (clients/instance-reaper.ts) for the same reason: injectable liveness
 * predicate, fully unit-testable with fake registry data, zero real
 * process.kill/spawn/fs calls.
 *
 * Liveness is counted, not just registry presence, because a dead-parent
 * instance's `lspChildren` entries are exactly the orphan reaper's target —
 * counting them here would double-penalize new sessions for load that's
 * already being cleaned up (or was already cleaned up and the entry just
 * hasn't been pruned from this snapshot yet).
 *
 * An entry from another pid namespace (#3539 review F1) names a pid that
 * means nothing here, so it counts as live only while its heartbeat is
 * fresh: a dead container's entry must not hold the budget forever.
 */
export function decideLspBudget(
	registry: readonly InstanceEntry[],
	isPidAlive: (pid: number) => boolean,
	options: LspBudgetOptions = {},
): LspBudgetDecision {
	const machineCeiling = options.machineCeiling ?? DEFAULT_LSP_BUDGET_CEILING;
	const rootCeiling = options.rootCeiling ?? DEFAULT_LSP_BUDGET_ROOT_CEILING;
	const rssCeilingBytes = options.rssCeilingBytes;
	const now = options.now ?? Date.now();
	const ownNamespace = options.ownNamespace;
	const hasFreshHeartbeat = (instance: InstanceEntry) => {
		const heartbeatMs = Date.parse(instance.heartbeatAt);
		return (
			Number.isFinite(heartbeatMs) && now - heartbeatMs <= STALE_HEARTBEAT_MS
		);
	};
	const liveInstances = registry.filter((instance) =>
		isInPidNamespace(instance, ownNamespace)
			? isPidAlive(instance.pid)
			: hasFreshHeartbeat(instance),
	);
	const totalLiveLspServers = liveInstances.reduce(
		(sum, instance) => sum + instance.lspChildren.length,
		0,
	);
	// One root's load: every live entry that works in it, through the registry's
	// own root reader. A multi-root host is charged to its primary root, the one
	// the host's own fleet runs from (see the module docstring's excluded
	// defaults).
	const loadByRoot = new Map<string, number>();
	for (const instance of liveInstances) {
		const primaryRoot = getInstanceRoots(instance)[0];
		if (primaryRoot === undefined) continue;
		const key = normalizeFilePath(primaryRoot);
		loadByRoot.set(
			key,
			(loadByRoot.get(key) ?? 0) + instance.lspChildren.length,
		);
	}
	const ownRoots = ownRootKeys(options.ownRoots);
	let ownRootKey: string | undefined;
	let ownRootLoad: number | undefined;
	for (const key of ownRoots ?? []) {
		const load = loadByRoot.get(key) ?? 0;
		if (ownRootLoad === undefined || load > ownRootLoad) {
			ownRootLoad = load;
			ownRootKey = key;
		}
	}
	const ownRootOverBudget =
		ownRootLoad !== undefined && ownRootLoad >= rootCeiling;
	const machineOverBudget = totalLiveLspServers >= machineCeiling;
	const countOverBudget =
		ownRootLoad === undefined
			? totalLiveLspServers >= Math.min(rootCeiling, machineCeiling)
			: ownRootOverBudget || machineOverBudget;
	const hasCompleteFreshSamples =
		rssCeilingBytes !== undefined &&
		liveInstances.length > 0 &&
		liveInstances.every((instance) => {
			return (
				hasFreshHeartbeat(instance) &&
				Number.isFinite(instance.rssBytes) &&
				instance.lspChildren.every((child) => Number.isFinite(child.rssBytes))
			);
		});
	const totalRssBytes = hasCompleteFreshSamples
		? liveInstances.reduce(
				(sum, instance) =>
					sum +
					instance.rssBytes +
					instance.lspChildren.reduce(
						(childSum, child) => childSum + (child.rssBytes ?? 0),
						0,
					),
				0,
			)
		: undefined;
	const rssPressure =
		totalRssBytes !== undefined &&
		rssCeilingBytes !== undefined &&
		totalRssBytes >= rssCeilingBytes;
	const overBudget = countOverBudget || rssPressure;
	return {
		totalLiveLspServers,
		ceiling: machineCeiling,
		rootCeiling,
		ownRoots,
		ownRootLoad,
		ownRootKey,
		ownRootOverBudget,
		machineOverBudget,
		countOverBudget,
		totalRssBytes,
		rssCeilingBytes,
		rssPressure,
		overBudget,
		degradeAuxiliary: overBudget,
		degradePrimarySpawn: overBudget,
		shortenIdleTimeout: overBudget,
		preferPullOnly: overBudget,
	};
}

// --- Module-scope decision cache, read by clients/dispatch/auxiliary-lsp.ts ---
//
// session_start fires this check fire-and-forget (must never block session
// start on a registry read) and stashes the result here; the auxiliary-LSP
// enablement gate reads it synchronously on every dispatch. Default (before
// the async check resolves, or if it's never run — e.g. the kill switch, or
// a process that never reached session_start) is "don't degrade" — fail
// toward today's behavior, exactly like the concurrent-session guard.

let cachedDecision: LspBudgetDecision | undefined;
/** When {@link cachedDecision} was taken, for the spawn path's bounded re-check. */
let cachedDecisionAt = 0;
/** Single flight for the spawn path's re-check: concurrent cold spawns share
 *  one registry read instead of one each. The primitive owns the share, the
 *  clear-on-settle and the successor check (#1753); this module re-checks ONE
 *  thing, so the key is a constant rather than a family. */
const primarySpawnRecheck = createSingleFlight<void>();

/** The single-flight key for {@link primarySpawnRecheck}. */
const PRIMARY_SPAWN_RECHECK_KEY = "primary-spawn";

/** True once the budget check has run this process and found this session over
 *  budget — its own root at the root budget, the machine-wide stop, or RSS
 *  pressure. Read by
 *  `clients/dispatch/auxiliary-lsp.ts#enabledAuxiliaryLspServerIds`. Never
 *  throws; absent-decision (not yet checked, or disabled) reads as `false`. */
export function shouldDegradeAuxiliaryLsp(): boolean {
	return cachedDecision?.degradeAuxiliary ?? false;
}

export function shouldShortenLspIdleTimeout(): boolean {
	return cachedDecision?.shortenIdleTimeout ?? false;
}

export function shouldPreferPullOnlyDiagnostics(): boolean {
	return cachedDecision?.preferPullOnly ?? false;
}

/**
 * The refusal this session's CACHED decision implies for a new PRIMARY spawn,
 * or `undefined` while the spawn is admitted.
 *
 * Pure over the decision: the spawn site never asks "is this root full" itself
 * (a re-derived rule beside its owner is defect shape 83), it asks the module
 * that already accounted for the root. The basis is named in the order the
 * module's own remedy prefers: this root's share first (the root that exceeds
 * it is the one that sheds), then the machine-wide stop, then the RSS stop.
 */
function primarySpawnRefusal(
	decision: LspBudgetDecision,
): LspPrimarySpawnRefusal | undefined {
	if (!decision.degradePrimarySpawn) return undefined;
	const root = decision.ownRootKey ?? "";
	if (decision.ownRootOverBudget) {
		return {
			root,
			ceiling: decision.rootCeiling,
			basis: "root",
			load: decision.ownRootLoad,
		};
	}
	if (decision.machineOverBudget) {
		return {
			root,
			ceiling: decision.ceiling,
			basis: "machine",
			load: decision.totalLiveLspServers,
		};
	}
	if (decision.rssPressure) {
		return {
			root,
			ceiling: decision.rssCeilingBytes ?? 0,
			basis: "rss",
			load: decision.totalRssBytes,
		};
	}
	// The pre-split rule for a session that named no root: the total against the
	// smaller of the two count ceilings (see the module docstring).
	return {
		root,
		ceiling: Math.min(decision.rootCeiling, decision.ceiling),
		basis: "unrooted",
		load: decision.totalLiveLspServers,
	};
}

/** The bounded record's reason. It names BOTH facts the refusal must carry: the
 *  root it was charged to and the ceiling that refused it. */
function primarySpawnRefusalReason(refusal: LspPrimarySpawnRefusal): string {
	const charged =
		refusal.root.length > 0
			? `root ${refusal.root}`
			: "this session (no root named)";
	switch (refusal.basis) {
		case "root":
			return `${charged} already runs ${refusal.load ?? 0} LSP servers, at or over its ceiling of ${refusal.ceiling}, so this process starts no new primary language server`;
		case "machine":
			return `the machine already runs ${refusal.load ?? 0} LSP servers, at or over its ceiling of ${refusal.ceiling}, so ${charged} starts no new primary language server`;
		case "rss":
			return `the machine's LSP footprint is ${refusal.load ?? 0} bytes, at or over its ceiling of ${refusal.ceiling} bytes, so ${charged} starts no new primary language server`;
		case "unrooted":
			return `${charged} must stay under ${refusal.ceiling} LSP servers and the machine already runs ${refusal.load ?? 0}, so it starts no new primary language server`;
		default:
			// Total by construction: the union above is exhaustive, and a value that
			// reached here anyway is reported with its own numbers rather than
			// silently dropped.
			return `${charged} is over its LSP ceiling of ${refusal.ceiling}, so it starts no new primary language server`;
	}
}

/**
 * The refusal this session's CACHED decision implies for a new PRIMARY spawn,
 * or `undefined` while the spawn is admitted.
 *
 * Called from the one place a new primary process is decided
 * (`ClientRegistry.ensureClientForServer`, before its spawn gate and before its
 * capacity eviction), so it never runs on a warm touch. SYNCHRONOUS on purpose:
 * it answers from the decision the budget module already took and reads no
 * file, so it adds no await — and therefore no interleaving change — to a seam
 * whose in-flight spawn ordering is itself pinned.
 *
 * Fails toward today's behaviour in every doubtful case, like every other
 * reader here: the kill switch (`PI_LENS_CROSS_PROCESS_BUDGET=0`), a disabled
 * instance registry, and no decision yet all answer "admitted". That last one
 * is also what keeps this hermetic: a process that never checked the budget
 * (every test fixture, and a prewarm that beats `session_start`'s check) is
 * never gated on registry state it did not ask for.
 *
 * A refusal is written ONCE per refusing session root
 * (`lsp-primary-spawn-refused-by-budget`), so a session that keeps trying keeps
 * one row; the row names the root and the ceiling, which is what makes the
 * absence of a language server explicable later.
 */
export function cachedPrimarySpawnRefusal():
	| LspPrimarySpawnRefusal
	| undefined {
	if (!isCrossProcessBudgetEnabled() || !isInstanceRegistryEnabled()) {
		return undefined;
	}
	const decision = cachedDecision;
	if (decision === undefined) return undefined;
	const refusal = primarySpawnRefusal(decision);
	if (refusal === undefined) return undefined;
	const subject = refusal.root.length > 0 ? refusal.root : "";
	recordDegradationOnce({
		kind: "lsp-primary-spawn-refused-by-budget",
		subject,
		reason: primarySpawnRefusalReason(refusal),
	});
	return refusal;
}

/**
 * Is this session's cached verdict old enough that the next primary spawn should
 * re-read it? This is the mid-session re-check's whole schedule: no timer, no
 * per-edit work, and a session with no decision (or with the budget disabled)
 * never reaches the disk at all.
 */
export function primarySpawnBudgetRecheckDue(): boolean {
	return (
		cachedDecision !== undefined &&
		isCrossProcessBudgetEnabled() &&
		isInstanceRegistryEnabled() &&
		Date.now() - cachedDecisionAt >= DEFAULT_LSP_BUDGET_RECHECK_MS
	);
}

/**
 * Re-read the registry and re-cache the verdict, then answer the refusal for the
 * spawn that asked. Single-flight: concurrent cold spawns inside one window
 * share one read.
 *
 * A read that yields nothing keeps the previous verdict (missing evidence never
 * upgrades a session to a refusal); a failed read keeps it too, which is exactly
 * what happens today with no re-check at all.
 */
export async function recheckPrimarySpawnBudget(): Promise<
	LspPrimarySpawnRefusal | undefined
> {
	await primarySpawnRecheck.run(PRIMARY_SPAWN_RECHECK_KEY, () =>
		checkCrossProcessLspBudget(),
	);
	return cachedPrimarySpawnRefusal();
}

/** Test-only: reset the module-scope cache between tests. */
export function _resetLspBudgetDecisionForTests(): void {
	cachedDecision = undefined;
	cachedDecisionAt = 0;
	primarySpawnRecheck.clear();
}

/** Caller overrides for {@link checkCrossProcessLspBudget}: a pre-read
 *  registry and liveness predicate for tests, and the deciding session's own
 *  roots when a caller already knows them. */
export interface CrossProcessBudgetOverrides {
	registry?: readonly InstanceEntry[];
	isPidAlive?: (pid: number) => boolean;
	/** The deciding session's own roots. Omitted => resolved from the registry
	 *  (see {@link resolveOwnRoots}). */
	ownRoots?: readonly string[];
}

/**
 * The roots the deciding session serves, for per-root accounting: this
 * process's registry entry when it has one, else the `process.cwd()` fallback
 * the host adapters register with (`ctx.cwd ?? process.cwd()` in index.ts).
 *
 * The entry is matched the way `clients/instance-registry.ts` matches its own
 * (`isOwnEntry`): the pid AND the recorded start, so a dead predecessor's entry
 * on a recycled pid is never read as this session's. Roots go through
 * {@link getAuthoritativeInstanceRoots}, so a `rootSource: "lsp-fallback"`
 * entry's guessed index-0 root does not become an answer.
 */
function resolveOwnRoots(
	registry: readonly InstanceEntry[],
): readonly string[] | undefined {
	const selfStart = ownProcessStartIfKnown();
	const own = registry.find(
		(entry) =>
			entry.pid === process.pid &&
			(entry.processStart === undefined || entry.processStart === selfStart),
	);
	const registered =
		own === undefined ? [] : getAuthoritativeInstanceRoots(own);
	if (registered.length > 0) return registered;
	return [process.cwd()];
}

/**
 * Fire-and-forget budget check for `session_start`. Reads the instance
 * registry, decides via {@link decideLspBudget}, and caches the result for
 * `shouldDegradeAuxiliaryLsp` to read on subsequent dispatch calls. Every call
 * replaces the cache, so a session start always re-decides from the registry as
 * it stands then. Never throws — a failed check just leaves the cache at its
 * "don't degrade" default, matching every other best-effort registry consumer
 * in this codebase (registerInstance/sweepOrphans).
 */
export async function checkCrossProcessLspBudget(
	testOverrides: CrossProcessBudgetOverrides = {},
): Promise<void> {
	if (!isCrossProcessBudgetEnabled() || !isInstanceRegistryEnabled()) return;
	try {
		const registry = testOverrides.registry ?? (await readInstanceRegistry());
		if (registry.length === 0) {
			// Nothing to be over budget against. The previous verdict (if any) is
			// kept — missing evidence never upgrades a session to a refusal — but the
			// stamp moves so the spawn path's re-check does not re-read on every
			// cold spawn while the registry stays empty.
			cachedDecisionAt = Date.now();
			return;
		}
		const decision = decideLspBudget(
			registry,
			testOverrides.isPidAlive ?? realIsPidAlive,
			{
				machineCeiling: getLspBudgetCeiling(),
				rootCeiling: getLspBudgetRootCeiling(),
				rssCeilingBytes: getLspBudgetRssCeilingBytes(),
				now: Date.now(),
				ownNamespace: ownPidNamespace(),
				ownRoots: testOverrides.ownRoots ?? resolveOwnRoots(registry),
			},
		);
		cachedDecision = decision;
		cachedDecisionAt = Date.now();
		if (decision.overBudget) {
			logLatency({
				type: "phase",
				phase: "cross_process_lsp_budget_degraded",
				filePath: "",
				durationMs: 0,
				metadata: {
					totalLiveLspServers: decision.totalLiveLspServers,
					ceiling: decision.ceiling,
					rootCeiling: decision.rootCeiling,
					ownRoots: decision.ownRoots,
					ownRootLoad: decision.ownRootLoad,
					ownRootOverBudget: decision.ownRootOverBudget,
					machineOverBudget: decision.machineOverBudget,
					totalRssBytes: decision.totalRssBytes,
					rssCeilingBytes: decision.rssCeilingBytes,
					rssPressure: decision.rssPressure,
					instanceCount: registry.length,
				},
			});
		}
	} catch {
		// Best-effort observability-driven check — never throw out of
		// session_start over this.
	}
}
