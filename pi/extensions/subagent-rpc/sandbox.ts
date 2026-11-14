/**
 * Bubblewrap sandbox for read-only subagents.
 *
 * A read-only subagent is for **research and review**: read the code, walk the
 * change graph (`jj log`, `git log`), search, follow links over the network, and
 * write nothing. Enforcing that with a shell-command allowlist is a losing game
 * (every reader has a write flag, every wrapper is an escape), so the child runs
 * inside `bwrap` instead:
 *
 * - `--ro-bind / /` - the whole filesystem, including the workspace and `~`, is
 *   read-only, and the **only** host path the child can write is **its own
 *   transcript file**, bind-mounted over the read-only view;
 * - pi's state dir (`~/.pi/agent`) becomes a private tmpfs with every entry it
 *   really holds (`auth.json`, `models.json`, `settings.json`, `extensions`,
 *   `sessions`, …) re-bound read-only on top: pi can read its config and take the
 *   `*.lock` directories it needs to start, while anything it writes there stays
 *   invisible to the host;
 * - `--tmpfs /tmp` and `--tmpfs <pi scratch>` - pi and its tools still get
 *   scratch space, but it is a private tmpfs that disappears with the process, so
 *   nothing reaches the host;
 * - `--unshare-all --share-net` - namespaces are cut off (pid, ipc, uts, cgroup,
 *   user) and **network stays**, because research needs it (model API, docs);
 * - no device access: `/dev` is bwrap's own minimal set (`null`, `zero`, `random`,
 *   `urandom`, `tty`, `ptmx`), so `> /dev/null` works, while `/dev/sda`, `/dev/mem`
 *   and the rest of the host's device nodes are not even present. (`/proc` and
 *   `/dev` must therefore be mounted *after* `--ro-bind / /`; otherwise the root
 *   bind shadows them and the child inherits the host's unusable device nodes.)
 *
 * This is a real boundary: a child that finds a write path it was not granted
 * fails at the syscall, and the failure shows up in its activity tail.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Set (informationally) in a sandboxed child's environment. */
export const SANDBOX_ENV = "PI_SUBAGENT_SANDBOX";

export interface SandboxOptions {
	/** The one file the child may write: its own transcript. */
	transcriptPath: string;
	/** Working directory for the child (must be readable through `/`). */
	cwd: string;
	/** Directories mounted as private tmpfs (pi's scratch dirs). */
	scratchDirs?: string[];
	/** Files under a tmpfs'd directory that the child must still be able to read. */
	readOnlyFiles?: string[];
	/**
	 * pi's own state dir (`~/.pi/agent`). pi must be able to write here - it takes
	 * lock files next to `trust.json` and friends during startup, and dies with
	 * `EROFS` otherwise - but nothing it writes may reach the host, so the directory
	 * is replaced by a private tmpfs and every entry it really contains is re-bound
	 * read-only on top. pi sees its settings, models and credentials; its locks and
	 * any new file it creates live and die inside the sandbox.
	 */
	stateDir?: string;
}

/** Locate `bwrap`: explicit override first, then `$PATH`. */
export function findBwrap(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const override = env.PI_SUBAGENT_BWRAP;
	if (override && fs.existsSync(override)) return override;
	for (const dir of (env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, "bwrap");
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {
			// Not here.
		}
	}
	return undefined;
}

/** `true` when a usable `bwrap` exists; `reason` explains why not. */
export function sandboxAvailability(env: NodeJS.ProcessEnv = process.env): { ok: boolean; bwrap?: string; reason?: string } {
	const bwrap = findBwrap(env);
	if (!bwrap) return { ok: false, reason: "bwrap not found (install bubblewrap, or set PI_SUBAGENT_BWRAP)" };
	const probe = spawnSync(bwrap, ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-all", "--share-net", "--", "/bin/true"], {
		encoding: "utf8",
		timeout: 15_000,
	});
	if (probe.status !== 0) {
		const detail = (probe.stderr || probe.error?.message || "").trim().split("\n")[0];
		return { ok: false, reason: `bwrap cannot start a sandbox: ${detail || `exit ${probe.status}`}` };
	}
	return { ok: true, bwrap };
}

/**
 * The recipe a read-only pi child runs with: one writable transcript, private
 * scratch, pi's own state dir for lock files, and its own prompt file handed back
 * read-only. Kept here so nothing can drift from what the registry actually runs.
 */
export function piSandboxOptions(params: {
	transcriptPath: string;
	cwd: string;
	systemPromptFile?: string;
	stateDir?: string;
}): SandboxOptions {
	const stateDir = params.stateDir ?? getAgentDir();
	return {
		transcriptPath: params.transcriptPath,
		cwd: params.cwd,
		// Private scratch, so a sandboxed run cannot leave anything on the host.
		scratchDirs: [os.tmpdir(), process.env.TMPDIR].filter((dir): dir is string => dir !== undefined),
		// The prompt file lives in /tmp, which becomes a tmpfs, so it must come back.
		readOnlyFiles: params.systemPromptFile ? [params.systemPromptFile] : [],
		stateDir,
	};
}

/** bwrap argv (without the payload command). */
export function buildBwrapArgs(options: SandboxOptions): string[] {
	const args = [
		// Everything unshared except the network: research needs the model API.
		"--unshare-all",
		"--share-net",
		// No controlling terminal, no orphan outliving the parent.
		"--new-session",
		"--die-with-parent",
		// Read-only world...
		"--ro-bind",
		"/",
		"/",
	];

	// ...then the exceptions, in order, since a later mount shadows an earlier one:
	// writable directories, private scratch on top of them, files handed back
	// read-only, a fresh /proc and /dev, and finally the one host file the child owns.
	const scratch = unique(["/tmp", ...(options.scratchDirs ?? [])]).filter(
		(dir) => dir !== "/" && fs.existsSync(dir),
	);
	const readOnly = (options.readOnlyFiles ?? []).filter((file) => fs.existsSync(file));

	for (const dir of scratch) args.push("--tmpfs", dir);
	for (const file of readOnly) args.push("--ro-bind", file, file);
	if (options.stateDir) for (const mount of stateDirMounts(options.stateDir)) args.push(...mount);

	// `--proc` and `--dev` have to come *after* `--ro-bind / /`, or the root bind
	// shadows them and the child sees the host's real `/dev`: a directory full of
	// device nodes it cannot open (bwrap's device policy permits only the nodes it
	// creates itself). Mounted last, `/dev` holds just bwrap's synthetic set
	// (`null`, `zero`, `full`, `random`, `urandom`, `tty`, `ptmx`) - so `> /dev/null`
	// and `$RANDOM` work like normal, while `/dev/sda`, `/dev/mem`, `/dev/kmsg` and
	// every other host device simply does not exist inside the sandbox.
	args.push("--proc", "/proc", "--dev", "/dev");

	// The transcript bind comes last: it lives under the scratch tmpfs and has to
	// survive it.
	args.push("--bind", options.transcriptPath, options.transcriptPath, "--chdir", options.cwd);
	return args;
}

/**
 * Wrap a command line so it runs inside the sandbox. `--` keeps bwrap from
 * reading the pi argv as its own options.
 */
export function wrapSandboxed(
	bwrap: string,
	command: string,
	args: string[],
	options: SandboxOptions,
): { command: string; args: string[] } {
	return { command: bwrap, args: [...buildBwrapArgs(options), "--", command, ...args] };
}

/** Create the transcript file (and its directory) so it can be bind-mounted. */
export function prepareTranscript(transcriptPath: string): void {
	fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
	fs.closeSync(fs.openSync(transcriptPath, "a"));
}

/**
 * Mounts that turn `stateDir` into private scratch without hiding what pi needs:
 * a tmpfs over the directory, then one read-only bind per entry it really holds.
 * Entries are enumerated so a pi version that adds a config file keeps working.
 */
function stateDirMounts(stateDir: string): string[][] {
	if (!fs.existsSync(stateDir)) return [];
	let entries: string[];
	try {
		entries = fs.readdirSync(stateDir);
	} catch {
		return [];
	}
	const mounts = [["--tmpfs", stateDir]];
	for (const entry of entries.sort()) mounts.push(["--ro-bind", path.join(stateDir, entry), path.join(stateDir, entry)]);
	return mounts;
}

function unique(items: string[]): string[] {
	return [...new Set(items)];
}
