import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pinFixtureHome, removeTempDirSync } from "../test-utils.js";

const { ensureTool, getToolEnvironment, launchLSP } = vi.hoisted(() => ({
	ensureTool: vi.fn(),
	getToolEnvironment: vi.fn(async () => ({ PI_LENS_TEST_TOOLCHAIN: "1" })),
	launchLSP: vi.fn(),
}));

vi.mock("../../../clients/installer/index.js", () => ({
	ensureTool,
	getToolEnvironment,
	findManagedToolBinary: vi.fn(async () => undefined),
}));
vi.mock("../../../clients/lsp/launch.js", () => ({
	launchLSP,
	admitProjectSuppliedTsserver: (tsserverPath: string) => tsserverPath,
}));

import {
	getRecentLoggedPhases,
	_setRecentPhasesForTest,
} from "../../../clients/latency-logger.js";
import { TypeScriptServer } from "../../../clients/lsp/server.js";

const dirs: string[] = [];
const fakeProcess = { kill: vi.fn() } as never;

function addTypeScriptPackage(root: string, version: string): void {
	fs.mkdirSync(path.join(root, "node_modules", "typescript"), {
		recursive: true,
	});
	fs.writeFileSync(
		path.join(root, "node_modules", "typescript", "package.json"),
		JSON.stringify({ name: "typescript", version }),
	);
}

function makeProject(version: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ts-native-"));
	dirs.push(root);
	addTypeScriptPackage(root, version);
	return root;
}

function addWorkspacePackage(workspaceRoot: string): {
	packageRoot: string;
	sourceFile: string;
} {
	const packageRoot = path.join(workspaceRoot, "packages", "app");
	const sourceFile = path.join(packageRoot, "src", "index.ts");
	fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
	fs.writeFileSync(path.join(packageRoot, "package.json"), '{"private":true}');
	fs.writeFileSync(sourceFile, "export const value = 1;\n");
	return { packageRoot, sourceFile };
}

function addNativeTsc(root: string): string {
	const binDir = path.join(root, "node_modules", ".bin");
	fs.mkdirSync(binDir, { recursive: true });
	const command = path.join(
		binDir,
		process.platform === "win32" ? "tsc.cmd" : "tsc",
	);
	fs.writeFileSync(command, "");
	return command;
}

function addClassicWrapper(root: string): string {
	const binDir = path.join(root, "node_modules", ".bin");
	fs.mkdirSync(binDir, { recursive: true });
	const lspPath = path.join(binDir, "typescript-language-server");
	fs.writeFileSync(lspPath, "");
	return lspPath;
}

function addClassicServer(root: string) {
	const lspPath = addClassicWrapper(root);
	const tsserverPath = path.join(
		root,
		"node_modules",
		"typescript",
		"lib",
		"tsserver.js",
	);
	fs.mkdirSync(path.dirname(tsserverPath), { recursive: true });
	fs.writeFileSync(tsserverPath, "");
	return { lspPath, tsserverPath };
}

describe("TypeScript native LSP selection", () => {
	beforeEach(() => {
		ensureTool.mockReset();
		ensureTool.mockResolvedValue(undefined);
		getToolEnvironment.mockClear();
		launchLSP.mockReset();
		launchLSP.mockResolvedValue(fakeProcess);
	});

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			removeTempDirSync(dir);
		}
	});

	it("launches the project-local TypeScript 7 binary in native LSP mode", async () => {
		const root = makeProject("7.0.2");
		const command = addNativeTsc(root);

		const result = await TypeScriptServer.spawn(root, { allowInstall: false });

		expect(launchLSP).toHaveBeenCalledWith(command, ["--lsp", "--stdio"], {
			cwd: root,
			env: { PI_LENS_TEST_TOOLCHAIN: "1" },
		});
		expect(ensureTool).not.toHaveBeenCalled();
		expect(result).toEqual({
			process: fakeProcess,
			source: "direct",
			launchVariant: "native-ts7",
		});
	});

	it("uses a TypeScript 7 compiler hoisted above the nearest package root", async () => {
		const workspaceRoot = makeProject("7.0.2");
		const command = addNativeTsc(workspaceRoot);
		const { packageRoot, sourceFile } = addWorkspacePackage(workspaceRoot);

		const detectedRoot = await TypeScriptServer.root(sourceFile);
		expect(path.resolve(detectedRoot as string)).toBe(
			path.resolve(packageRoot),
		);

		const result = await TypeScriptServer.spawn(detectedRoot as string, {
			allowInstall: false,
		});

		expect(launchLSP).toHaveBeenCalledWith(command, ["--lsp", "--stdio"], {
			cwd: packageRoot,
			env: { PI_LENS_TEST_TOOLCHAIN: "1" },
		});
		expect(ensureTool).not.toHaveBeenCalled();
		expect(result).toEqual({
			process: fakeProcess,
			source: "direct",
			launchVariant: "native-ts7",
		});
	});

	it("keeps TypeScript 6 on typescript-language-server and tsserver", async () => {
		const root = makeProject("6.0.3");
		addNativeTsc(root);
		const { lspPath, tsserverPath } = addClassicServer(root);

		const result = await TypeScriptServer.spawn(root, { allowInstall: false });

		expect(launchLSP).toHaveBeenCalledWith(lspPath, ["--stdio"], {
			cwd: root,
			env: {
				PI_LENS_TEST_TOOLCHAIN: "1",
				TSSERVER_PATH: tsserverPath,
			},
		});
		expect(result?.initialization).toEqual({
			tsserver: { path: tsserverPath, useSyntaxServer: "never" },
		});
		expect(result?.launchVariant).toBe("classic");
	});

	it("does not skip a nearer TypeScript 6 package for an ancestor TypeScript 7 package", async () => {
		const workspaceRoot = makeProject("7.0.2");
		addNativeTsc(workspaceRoot);
		const { packageRoot } = addWorkspacePackage(workspaceRoot);
		addTypeScriptPackage(packageRoot, "6.0.3");
		addNativeTsc(packageRoot);
		const { lspPath, tsserverPath } = addClassicServer(packageRoot);

		const result = await TypeScriptServer.spawn(packageRoot, {
			allowInstall: false,
		});

		expect(launchLSP).toHaveBeenCalledWith(lspPath, ["--stdio"], {
			cwd: packageRoot,
			env: {
				PI_LENS_TEST_TOOLCHAIN: "1",
				TSSERVER_PATH: tsserverPath,
			},
		});
		expect(result?.initialization).toEqual({
			tsserver: { path: tsserverPath, useSyntaxServer: "never" },
		});
	});

	it("refuses the classic wrapper without a compiler when TypeScript 7 has no local tsc binary", async () => {
		const root = makeProject("7.0.2");
		addClassicWrapper(root);
		const previousCwd = process.cwd();
		process.chdir(root);
		try {
			const result = await TypeScriptServer.spawn(root, {
				allowInstall: false,
			});

			expect(launchLSP).not.toHaveBeenCalled();
			expect(ensureTool).toHaveBeenCalledWith("typescript", {
				allowInstall: false,
			});
			expect(result).toBeUndefined();
		} finally {
			process.chdir(previousCwd);
		}
	});

	it("falls back safely when the nearest TypeScript package metadata is malformed", async () => {
		const root = makeProject("7.0.2");
		fs.writeFileSync(
			path.join(root, "node_modules", "typescript", "package.json"),
			"{",
		);
		addNativeTsc(root);
		addClassicServer(root);

		const result = await TypeScriptServer.spawn(root, { allowInstall: false });

		expect(launchLSP).not.toHaveBeenCalled();
		expect(result).toBeUndefined();
	});

	// Copilot review (PR #526): a nearer `node_modules/typescript/` directory
	// that exists but has no `package.json` (a broken/partial install) must be
	// treated as malformed AT THAT LEVEL and stop the walk — never silently
	// skipped as "not installed here" in favor of an ancestor TS 7 hoist. That
	// would violate "nearest package shadows ancestors" for exactly the
	// malformed-install case the doc comment already calls out.
	it("does not skip a nearer TypeScript install whose package.json is missing (directory exists) to select an ancestor TS 7 hoist", async () => {
		const workspaceRoot = makeProject("7.0.2"); // ancestor: valid TS 7 install
		addNativeTsc(workspaceRoot);
		const { packageRoot } = addWorkspacePackage(workspaceRoot);

		// Nearer install: the `typescript` directory exists (e.g. a partial /
		// interrupted install) but package.json is missing entirely.
		fs.mkdirSync(path.join(packageRoot, "node_modules", "typescript"), {
			recursive: true,
		});
		addClassicServer(packageRoot);

		const result = await TypeScriptServer.spawn(packageRoot, {
			allowInstall: false,
		});

		// #4299: broken metadata cannot authorize an implicit classic fallback,
		// and the nearer install still shadows the ancestor native compiler.
		expect(launchLSP).not.toHaveBeenCalled();
		expect(result).toBeUndefined();
	});
});

/**
 * Fleet-memory T2 (spec S2-S3): pi-lens decides the tsserver process topology
 * instead of inheriting the classic wrapper's default, and says so once per
 * launch.
 *
 * Baseline E4b measured the inherited default on one TypeScript root: a
 * `typescript-language-server` wrapper (73 MB) plus TWO `tsserver` children,
 * `--serverMode partialSemantic` (156 MB) and the full semantic server
 * (182 MB), which `instances.json`'s `lspChildCount` reports as ONE child
 * because it counts the child pi-lens spawns and not the wrapper's own forks.
 * The installed wrapper reads `initializationOptions.tsserver`
 * (`useSyntaxServer: "never"` selects its single-server topology), so pi-lens
 * asks for that and states the choice in one `lsp_typescript_spawn_topology`
 * record. The typescript-go launches (`tsc --lsp`, `effect-tsgo`) have no such
 * option: they keep their launch shape and emit the same record.
 */
describe("TypeScript tsserver process topology (fleet memory T2)", () => {
	beforeEach(() => {
		ensureTool.mockReset();
		ensureTool.mockResolvedValue(undefined);
		getToolEnvironment.mockClear();
		launchLSP.mockReset();
		launchLSP.mockResolvedValue(fakeProcess);
		// The ring survives a case, so a row from an earlier launch would be
		// counted as this launch's record.
		_setRecentPhasesForTest([]);
	});

	afterEach(() => {
		for (const dir of dirs.splice(0)) removeTempDirSync(dir);
	});

	/** The one record this launch emitted, keyed by its phase. */
	function spawnTopologyRecords() {
		return getRecentLoggedPhases().filter(
			(row) => row.phase === "lsp_typescript_spawn_topology",
		);
	}

	it("asks the classic wrapper for one full-semantic tsserver and records that topology", async () => {
		const root = makeProject("6.0.3");
		const { tsserverPath } = addClassicServer(root);

		const result = await TypeScriptServer.spawn(root, { allowInstall: false });

		expect(result?.initialization).toEqual({
			tsserver: { path: tsserverPath, useSyntaxServer: "never" },
		});
		expect(spawnTopologyRecords().map((row) => row.metadata)).toEqual([
			{
				tool: "typescript",
				variant: "classic",
				topology: "semantic-only",
				features: "all",
			},
		]);
	});

	it("records the single-process topology for the native TypeScript 7 launch, whose launch shape is unchanged", async () => {
		const root = makeProject("7.0.2");
		const command = addNativeTsc(root);

		const result = await TypeScriptServer.spawn(root, { allowInstall: false });

		expect(launchLSP).toHaveBeenCalledWith(command, ["--lsp", "--stdio"], {
			cwd: root,
			env: { PI_LENS_TEST_TOOLCHAIN: "1" },
		});
		expect(result).toEqual({
			process: fakeProcess,
			source: "direct",
			launchVariant: "native-ts7",
		});
		expect(spawnTopologyRecords().map((row) => row.metadata)).toEqual([
			{
				tool: "typescript",
				variant: "native-ts7",
				topology: "single-process",
				features: "all",
			},
		]);
	});

	it("records the single-process topology for the effect-tsgo launch, whose launch shape is unchanged", async () => {
		const root = makeProject("7.0.2");
		addNativeTsc(root);
		const effectBin = path.join(
			root,
			"node_modules",
			".bin",
			process.platform === "win32" ? "effect-tsgo.cmd" : "effect-tsgo",
		);
		fs.mkdirSync(path.dirname(effectBin), { recursive: true });
		fs.writeFileSync(effectBin, "");
		fs.mkdirSync(path.join(root, "node_modules", "@effect", "tsgo"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(root, "node_modules", "@effect", "tsgo", "package.json"),
			JSON.stringify({ name: "@effect/tsgo", version: "0.62.0" }),
		);

		const result = await TypeScriptServer.spawn(root, { allowInstall: false });

		expect(launchLSP).toHaveBeenCalledWith(
			effectBin,
			["tsc", "--lsp", "--stdio"],
			{ cwd: root, env: { PI_LENS_TEST_TOOLCHAIN: "1" } },
		);
		expect(result).toEqual({
			process: fakeProcess,
			source: "direct",
			launchVariant: "effect-tsgo",
		});
		expect(spawnTopologyRecords().map((row) => row.metadata)).toEqual([
			{
				tool: "typescript",
				variant: "effect-tsgo",
				topology: "single-process",
				features: "all",
			},
		]);
	});
});

describe("TypeScript LSP ancestor walks stop at a linked home (#4911)", () => {
	// RECURRENCE GUARDED: #4911. Both ancestor walks keep the caller's spelling
	// (a returned binary is classified where it is spelled) and compared that
	// spelling with the spelled HOME, so a HOME or a root spelled through a link
	// climbed into the home and launched the home's TypeScript. Both directions,
	// each with a real directory link and the real `os.homedir()` read.
	beforeEach(() => {
		ensureTool.mockReset();
		ensureTool.mockResolvedValue(undefined);
		launchLSP.mockReset();
		launchLSP.mockResolvedValue(fakeProcess);
	});

	afterEach(() => {
		for (const dir of dirs.splice(0)) removeTempDirSync(dir);
	});

	const cells = (["native", "classic"] as const).flatMap((walk) =>
		(["home-link", "root-link"] as const).map((kind) => [walk, kind] as const),
	);

	it.each(cells)(
		"the %s walk does not launch the home's server when the %s spelling names the home",
		async (walk, kind) => {
			const pin = pinFixtureHome("ts-native-4911");
			const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4911-"));
			dirs.push(scratch);
			try {
				if (walk === "native") {
					addTypeScriptPackage(pin.home, "7.0.2");
					addNativeTsc(pin.home);
				} else {
					// A TypeScript 6 package beside the wrapper: the native walk reads
					// it and steps aside, so only the classic walk can reach the home.
					addTypeScriptPackage(pin.home, "6.0.3");
					addClassicServer(pin.home);
				}
				fs.mkdirSync(path.join(pin.home, "proj"), { recursive: true });
				const link = path.join(scratch, "link");
				fs.symlinkSync(pin.home, link, "junction");
				if (kind === "home-link") {
					vi.stubEnv("HOME", link);
					vi.stubEnv("USERPROFILE", link);
				}
				const root = path.join(kind === "root-link" ? link : pin.home, "proj");

				await TypeScriptServer.spawn(root, { allowInstall: false });

				expect(launchLSP).not.toHaveBeenCalled();
			} finally {
				vi.unstubAllEnvs();
				pin.restore();
			}
		},
	);
});
