/**
 * Pure helpers for the subagent-rpc extension.
 *
 * No process state and no pi session access live here: everything is a
 * formatting or environment helper so the registry and UI can stay focused on
 * behavior. Style follows the repo's other extensions (tabs, double quotes,
 * `.ts` extensions on relative imports).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatReadLineRange } from "@earendil-works/pi-coding-agent";

/** Env marker carrying how deep this pi process sits inside a subagent chain. */
export const DEPTH_ENV = "PI_SUBAGENT_DEPTH";

/** Session-specific env vars that must not leak into a subagent child. */
const STRIPPED_CHILD_ENV = [
	"PI_SESSION_FILE",
	"PI_SESSION_ID",
	"PI_MODEL",
	"PI_PROVIDER",
	"PI_REASONING_LEVEL",
] as const;

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** Collapse newlines and whitespace runs into single spaces. */
export function oneLine(text: string, max = 120): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/** Ellipsize a single display line without touching its interior whitespace. */
export function ellipsize(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(1, max - 1))}…`;
}

export function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/** Compact `3 turns ↑1.2k ↓340 $0.0121 ctx:38k model` style usage line. */
export function formatUsage(usage: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatTime(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString();
}

export function shortenPath(value: string): string {
	const home = os.homedir();
	return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

/**
 * One-line plain-text summary of a tool call, mirroring the built-in tool
 * renderers so a subagent transcript reads like the parent transcript.
 */
export function formatToolCallText(toolName: string, args: Record<string, unknown>): string {
	switch (toolName) {
		case "bash":
			return `$ ${oneLine(String(args.command ?? "..."), 160)}`;
		case "read": {
			const filePath = shortenPath(String(args.file_path ?? args.path ?? "..."));
			const range = formatReadLineRange(args.offset, args.limit);
			return `read ${filePath}${range ?? ""}`;
		}
		case "write": {
			const filePath = shortenPath(String(args.file_path ?? args.path ?? "..."));
			const lines = String(args.content ?? "").split("\n").length;
			return `write ${filePath}${lines > 1 ? ` (${lines} lines)` : ""}`;
		}
		case "edit":
			return `edit ${shortenPath(String(args.file_path ?? args.path ?? "..."))}`;
		case "ls":
			return `ls ${shortenPath(String(args.path ?? "."))}`;
		case "find":
			return `find ${String(args.pattern ?? "*")} in ${shortenPath(String(args.path ?? "."))}`;
		case "grep":
			return `grep /${String(args.pattern ?? "")}/ in ${shortenPath(String(args.path ?? "."))}`;
		case "codemode":
			return `codemode ${oneLine(String(args.code ?? args.input ?? "..."), 140)}`;
		default: {
			const serialized = JSON.stringify(args) ?? "{}";
			return `${toolName} ${ellipsize(serialized, 120)}`;
		}
	}
}

export type SubagentStatus = "spawning" | "running" | "settled" | "aborted" | "failed" | "exited";

export type StatusTone = "accent" | "success" | "warning" | "error" | "muted";

export interface StatusMeta {
	icon: string;
	label: string;
	tone: StatusTone;
}

export function statusMeta(status: SubagentStatus): StatusMeta {
	switch (status) {
		case "spawning":
			return { icon: "…", label: "spawning", tone: "accent" };
		case "running":
			return { icon: "⏳", label: "running", tone: "accent" };
		case "settled":
			return { icon: "✓", label: "done", tone: "success" };
		case "aborted":
			return { icon: "⊘", label: "aborted", tone: "warning" };
		case "failed":
			return { icon: "✗", label: "failed", tone: "error" };
		case "exited":
			return { icon: "⏏", label: "exited", tone: "warning" };
	}
}

export function isFinished(status: SubagentStatus): boolean {
	return status !== "spawning" && status !== "running";
}

/**
 * Resolve how to launch another pi process.
 *
 * Mirrors the official subagent example: prefer the current CLI entry so a
 * checkout or a dev build drives the child, and only fall back to the `pi`
 * binary on PATH for Bun-compiled single-file builds, whose embedded entry
 * (`/$bunfs/root/...`) does not exist on disk.
 */
export function resolvePiInvocation(extraArgs: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript =
		currentScript !== undefined &&
		(currentScript.startsWith("/$bunfs/root/") || /^[A-Za-z]:[\\/]~BUN[\\/]root[\\/]/.test(currentScript));
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...extraArgs] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		// A compiled pi binary is itself the CLI: pass the args straight to it.
		return { command: process.execPath, args: extraArgs };
	}

	return { command: "pi", args: extraArgs };
}

/** Current nesting depth of this pi process inside a subagent chain. */
export function currentDepth(): number {
	const raw = Number(process.env[DEPTH_ENV] ?? "0");
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/**
 * Environment for a child pi: drop parent session identity so the child's own
 * shell commands do not read parent session data, and bump the recursion depth.
 */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const next: NodeJS.ProcessEnv = { ...env };
	for (const key of STRIPPED_CHILD_ENV) delete next[key];
	next[DEPTH_ENV] = String(currentDepth() + 1);
	return next;
}

const INHERITED_VALUE_FLAGS = new Set(["--extension", "-e", "--skill", "--theme"]);
const INHERITED_SWITCH_FLAGS = new Set([
	"--no-extensions",
	"-ne",
	"--no-skills",
	"-ns",
	"--no-themes",
	"--no-context-files",
	"-nc",
	"--no-mcp",
	"--offline",
]);

/**
 * Run-scoped resources the parent was launched with (`-e path`, `--skill path`,
 * `--theme path`, and the disable switches) so a subagent inherits the same
 * extension environment, not just the globally installed one. Model, tools,
 * session and naming flags stay under the caller's control.
 */
export function inheritableCliFlags(argv: string[] = process.argv.slice(2), cwd: string = process.cwd()): string[] {
	const forwarded: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--") break;
		if (INHERITED_SWITCH_FLAGS.has(arg)) {
			forwarded.push(arg);
			continue;
		}
		if (!INHERITED_VALUE_FLAGS.has(arg)) continue;
		const value = argv[i + 1];
		if (!value || value.startsWith("-")) continue;
		i++;
		forwarded.push(arg, path.isAbsolute(value) ? value : path.resolve(cwd, value));
	}
	return forwarded;
}
