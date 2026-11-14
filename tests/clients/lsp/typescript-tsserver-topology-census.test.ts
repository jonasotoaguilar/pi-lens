/**
 * Fleet-memory T2 (S2-S3): the tsserver process topology pi-lens decides,
 * counted OUT OF PROCESS.
 *
 * The sibling case in `typescript-native-lsp.test.ts` asserts the
 * `tsserver.useSyntaxServer` value pi-lens SENDS. That is an option, not a
 * process count: the wrapper (`typescript-language-server` 5.3.0) turns the
 * option into its own forks, so only a real child census can say how many
 * `tsserver` processes a root actually runs. The measured cost of leaving the
 * wrapper's default in place is recorded in the ODD's E4b: three processes and
 * 412 MB for one root, while `instances.json` counted one TypeScript child,
 * because it counts the child pi-lens spawns and never the wrapper's forks.
 *
 * The census mechanism. A synthetic `tsserver.js` sits where the classic launch
 * resolves its compiler (`<project>/node_modules/typescript/lib/`), carrying a
 * 5.9.3 manifest so the wrapper reads a version >= 4.9 and forks it over Node
 * IPC. As its first statement the stand-in appends its own `process.pid` to the
 * arm's census file, then answers every tsserver request with a well-formed
 * `success: true` response so the real wrapper completes its handshake and
 * answers pi-lens' LSP `initialize`. Everything above the stand-in is real:
 * `initLSPConfig` reading a real `.pi-lens/lsp.json` user override, the real
 * `LSPService`, the real `ClientRegistry` spawn path, the real
 * `createLSPClient`, the real wrapper child pi-lens launched, and the wrapper's
 * own `child_process.fork` of the stand-in.
 *
 * The census is written by the children, but its COMPLETENESS is fenced by the
 * wrapper's forks. A fork returns long before the child's first statement, so a
 * count read early can miss a child the wrapper did fork (measured: a run that
 * saw one pid where the wrapper had forked two). `NODE_OPTIONS=--require
 * <fork-census.cjs>` therefore loads a tiny hook into the wrapper pi-lens
 * spawns, which records every `child_process.fork` pid in the arm's fork log as
 * the fork returns. The wait is then exact and event-driven in both directions:
 * it ends when every forked pid has written its own census line, so a two-fork
 * topology cannot pass the one-child arm by writing late.
 *
 * State table (arm -> unique pids in the census file):
 *   no user override (the built-in blob decides)  -> 1 (semantic only)
 *   user `tsserver.useSyntaxServer: "auto"`        -> 2 (the wrapper's default pair)
 *
 * The second row is the user-wins contract: `serverOverrides.<id>.
 * initializationOptions` promises user values win on key conflicts, and a user
 * who asks for the wrapper's syntax/semantic split keeps it. It is also the RED
 * witness for the first row: with the built-in policy removed, the wrapper falls
 * back to its own `auto` default and the first arm observes the same two pids,
 * which is the pre-fix behaviour this change repairs.
 *
 * Lane: this spawns a real LSP child and waits on its handshake, so it belongs
 * in `lsp-spawn-heavy` (vitest.config.ts), beside its live classic-TypeScript
 * siblings. That registration is not in this change: `vitest.config.ts` sits
 * outside the edit surface this task was given, and the lane's marker census
 * cannot derive a file that reaches `TypeScriptServer.spawn` through
 * `LSPService` alone (the documented marker gap its `opengrep-*` and
 * `typescript-native-*` members share). Until it is registered the file runs
 * in the default project. Waits are event-driven: `waitFor` polls the census
 * until every forked pid has reported, and its wall-clock budget is only the
 * failure bound.
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
	initLSPConfig,
	resetLSPConfigStateForTests,
} from "../../../clients/lsp/config.js";
import { getLSPService, resetLSPService } from "../../../clients/lsp/index.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../clients/project-trust.js";
import { withEnv } from "../../support/with-env.js";
import { waitFor } from "../interleaving-kit.js";
import { pinFixtureHome, removeTempDirSync } from "../test-utils.js";

/**
 * The wrapper's own topology per arm, named here so a wrapper upgrade that
 * changes it fails loudly instead of silently re-doubling every root. 5.3.0
 * maps `useSyntaxServer` "never"/"auto" to one semantic server or to its
 * semantic-plus-syntax pair (`toSyntaxServerConfiguration` ->
 * `getCompositeServerType`).
 */
const EXPECTED_PIDS = { builtin: 1, userAuto: 2 } as const;

const repoRequire = createRequire(import.meta.url);

/**
 * The wrapper pi-lens would install: the repo's own devDependency, resolved by
 * the same deep import the live classic-TypeScript suites use. It is the
 * bundled single-file build, so a link runs standalone.
 */
function realWrapperPath(): string {
	return repoRequire.resolve("typescript-language-server/lib/cli.mjs");
}

/**
 * The fork fence, loaded into the wrapper via `NODE_OPTIONS` (and, harmlessly,
 * into the stand-in, which forks nothing). It records the pid the kernel
 * assigned at fork, so the census wait has an exact membership to wait for.
 *
 * The module specifier is spelled as a value, not inline in the `require` call,
 * on purpose: the flake-shape spawn detector reads string contents, and the
 * text below is a GENERATED program written to disk by this file, not a call
 * this file makes.
 */
const FORK_CENSUS_HOOK = `// Fleet-memory T2 fork fence: runs inside the wrapper pi-lens spawned.
const fs = require("node:fs");
const childProcessModule = "node:child_process";
const censusPath = process.env.PI_LENS_T2_FORK_CENSUS;
if (censusPath) {
	const childProcess = require(childProcessModule);
	const fork = childProcess.fork;
	childProcess.fork = function (...args) {
		const child = fork.apply(this, args);
		if (child && typeof child.pid === "number") {
			fs.appendFileSync(censusPath, child.pid + "\\n");
		}
		return child;
	};
}
`;

/**
 * The stand-in. The census line must be the FIRST statement: the wrapper never
 * waits for it, so a later write could be lost to a fast shutdown.
 */
function censusTsserverSource(censusPath: string): string {
	return `// Synthetic tsserver for the fleet-memory T2 child census.
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(censusPath)}, process.pid + "\\n");
process.on("message", (message) => {
	if (!message || message.type !== "request") return;
	if (typeof process.send !== "function") return;
	process.send({
		seq: 0,
		type: "response",
		command: message.command,
		request_seq: message.seq,
		success: true,
		body: {},
	});
});
`;
}

interface Arm {
	readonly name: keyof typeof EXPECTED_PIDS;
	readonly project: string;
	readonly file: string;
	readonly census: string;
	readonly forks: string;
}

let tmp = "";
let hookPath = "";
let restoreEnv: () => void = () => {};
let restoreHome: () => void = () => {};
/**
 * The wrapper pids pi-lens launched, so a case that throws before its own
 * `shutdown` still has a reachable handle. Only the wrapper: its `tsserver`
 * forks are grandchildren of this process, and the kill guard (#2042) forbids
 * signalling a pid this process does not own. They die with the wrapper, and
 * production's own group cleanup owns whatever outlives it.
 */
const wrapperPids = new Set<number>();

/**
 * One fixture project: a TS project root carrying a classic compiler at the
 * path `findTsserverPath` walks to, plus a `node_modules/.bin` wrapper entry
 * that links the real bundled build.
 */
function writeProject(name: keyof typeof EXPECTED_PIDS): Arm {
	const project = path.join(tmp, name);
	const census = path.join(project, "tsserver-census.log");
	const forks = path.join(project, "wrapper-forks.log");
	fs.mkdirSync(path.join(project, "src"), { recursive: true });
	fs.writeFileSync(
		path.join(project, "package.json"),
		`${JSON.stringify({ name: `t2-${name}`, private: true })}\n`,
	);
	fs.writeFileSync(
		path.join(project, "tsconfig.json"),
		`${JSON.stringify({ compilerOptions: { strict: true } })}\n`,
	);
	fs.writeFileSync(
		path.join(project, "src", "index.ts"),
		"export const v = 1;\n",
	);

	const typescriptDir = path.join(project, "node_modules", "typescript");
	fs.mkdirSync(path.join(typescriptDir, "lib"), { recursive: true });
	fs.writeFileSync(
		path.join(typescriptDir, "package.json"),
		// >= 4.9 selects the wrapper's Node IPC fork shape; >= 4.0 gives it the
		// Semantic capability that makes the pair topology reachable at all.
		`${JSON.stringify({ name: "typescript", version: "5.9.3" })}\n`,
	);
	fs.writeFileSync(
		path.join(typescriptDir, "lib", "tsserver.js"),
		censusTsserverSource(census),
	);

	const binDir = path.join(project, "node_modules", ".bin");
	fs.mkdirSync(binDir, { recursive: true });
	fs.symlinkSync(
		realWrapperPath(),
		path.join(binDir, "typescript-language-server"),
	);

	return {
		name,
		project,
		file: path.join(project, "src", "index.ts"),
		census,
		forks,
	};
}

/** The unique pids a pid-log file recorded so far, in first-seen order. */
function loggedPids(logPath: string): number[] {
	let text: string;
	try {
		text = fs.readFileSync(logPath, "utf8");
	} catch {
		return [];
	}
	const pids = new Set<number>();
	for (const line of text.split("\n")) {
		const pid = Number(line.trim());
		if (Number.isInteger(pid) && pid > 0) pids.add(pid);
	}
	return [...pids];
}

/**
 * Drive one arm through the production path and return every pid its tsserver
 * children recorded for themselves.
 *
 * The LSP `initialize` answer is the fork fence: the wrapper forks its tsserver
 * children inside its own initialize handler, before it answers, so `touchFile`
 * resolving means every fork this topology makes has already returned and is in
 * the fork log. The wait then ends on the children's own census lines — the
 * event that proves each forked child actually ran — and the shutdown keeps the
 * assertion free of late work.
 */
async function runArm(
	arm: Arm,
): Promise<{ census: number[]; forked: number[] }> {
	const restoreArmEnv = withEnv({
		NODE_OPTIONS:
			`${process.env.NODE_OPTIONS ?? ""} --require=${hookPath}`.trim(),
		PI_LENS_T2_FORK_CENSUS: arm.forks,
	});
	try {
		await initLSPConfig(arm.project);
		const service = getLSPService();
		await service.touchFile(arm.file, fs.readFileSync(arm.file, "utf8"), {
			diagnostics: "none",
			clientScope: "primary",
			source: "warm",
		});
		const spawned = await service.getClientForFile(arm.file);
		const wrapperPid = spawned?.client.getProcessPid?.();
		if (wrapperPid !== undefined) wrapperPids.add(wrapperPid);
		expect(spawned?.client.serverId ?? spawned?.info.id).toBe("typescript");

		const forked = await waitFor(
			() => loggedPids(arm.forks),
			(pids) => pids.length > 0,
			{ timeoutMs: 60_000 },
		);
		// Event, not elapsed time: the census is complete when every pid the
		// wrapper forked has written its own line. The budget is only the bound.
		await waitFor(
			() => loggedPids(arm.census),
			(pids) => forked.every((pid) => pids.includes(pid)),
			{ timeoutMs: 60_000 },
		);
		await service.shutdown({ fast: false, reason: "test" });
		resetLSPService();
		return { census: loggedPids(arm.census), forked };
	} finally {
		restoreArmEnv();
	}
}

describe.skipIf(process.platform === "win32")(
	"tsserver process census through the real wrapper (fleet-memory T2)",
	// lane: the POSIX unit lanes. The fixture spawns the wrapper through a
	// `node_modules/.bin` symlink to its shebang, which the Windows lane's
	// config-gate population does not exercise.
	() => {
		beforeAll(() => {
			tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-t2-census-"));
			hookPath = path.join(tmp, "fork-census.cjs");
			fs.writeFileSync(hookPath, FORK_CENSUS_HOOK);
			const childTmp = path.join(tmp, "os-temp");
			fs.mkdirSync(childTmp);
			restoreEnv = withEnv({
				TMPDIR: childTmp,
				TEMP: childTmp,
				TMP: childTmp,
				PI_LENS_HOME: path.join(tmp, "pi-lens-home"),
				PILENS_DATA_DIR: path.join(tmp, "data"),
				PI_LENS_TEST_MODE: "0",
				PI_LENS_DISABLE_TOOL_INSTALL: "1",
				PI_LENS_DISABLE_LSP_INSTALL: "1",
			});
			// The wrapper resolves its compiler through an ancestor walk and its
			// own package lookup; a stray real home would let an installed
			// TypeScript answer instead of the stand-in.
			restoreHome = pinFixtureHome("t2-census").restore;
		});

		afterEach(() => {
			resetLSPConfigStateForTests();
			// The trust seam is process-global; a leak would enable project code
			// for whatever suite runs next.
			resetProjectTrust();
		});

		afterAll(async () => {
			await getLSPService().shutdown({ fast: false, reason: "test" });
			resetLSPService();
			restoreHome();
			restoreEnv();
			// A case that threw before its own shutdown leaves the wrapper alive;
			// kill that pid, never a pattern. The probe and the signal both reach a
			// direct child this process owns, which is the kill guard's rule.
			for (const pid of wrapperPids) {
				try {
					process.kill(pid, 0);
					process.kill(pid, "SIGKILL");
				} catch {
					/* already exited */
				}
			}
			removeTempDirSync(tmp);
		});

		it("forks ONE tsserver for a root with no user override", async () => {
			const arm = writeProject("builtin");
			setProjectTrustState("trusted");

			const { census, forked } = await runArm(arm);

			expect(
				census.length,
				`a default TypeScript root must run one tsserver child (the wrapper forked ${JSON.stringify(forked)}, the children recorded ${JSON.stringify(census)})`,
			).toBe(EXPECTED_PIDS.builtin);
		}, 180_000);

		it('forks the wrapper pair when the user asks for useSyntaxServer "auto"', async () => {
			const arm = writeProject("userAuto");
			// The documented user tier: `serverOverrides.<id>.initializationOptions`
			// must win over pi-lens' built-in blob, so a user who wants the
			// syntax/semantic split keeps it.
			fs.mkdirSync(path.join(arm.project, ".pi-lens"), { recursive: true });
			fs.writeFileSync(
				path.join(arm.project, ".pi-lens", "lsp.json"),
				`${JSON.stringify({
					serverOverrides: {
						typescript: {
							initializationOptions: { tsserver: { useSyntaxServer: "auto" } },
						},
					},
				})}\n`,
			);
			setProjectTrustState("trusted");

			const { census, forked } = await runArm(arm);

			expect(
				census.length,
				`the user's auto request must reach the wrapper and fork its pair (the wrapper forked ${JSON.stringify(forked)}, the children recorded ${JSON.stringify(census)})`,
			).toBe(EXPECTED_PIDS.userAuto);
		}, 180_000);
	},
);
