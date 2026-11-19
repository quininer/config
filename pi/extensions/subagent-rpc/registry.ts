/**
 * Subagent registry: owns one `pi --mode rpc` child process per task.
 *
 * Semantics (deliberate): one subagent = one task. The child is spawned, given
 * its first prompt, and can be talked to while it runs (`steer`, `follow_up`,
 * `prompt`, plus the TUI view). When the child reports `agent_settled`, the task
 * is over: the record is kept for inspection and the parent session is woken up
 * with the result. A task that *settled* has its child shut down; a task that
 * ended badly (provider/service error, abort, unexpected exit) is recorded as
 * `failed`/`aborted` and its child is kept alive so `resume()` can continue it
 * in place with the whole context still in place.
 *
 * State lives in a module-level instance because the child has to outlive the
 * tool call that created it. Nothing is started from the extension factory:
 * processes appear only in tool calls, and `session_shutdown` reaps them.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	RpcSubagentProcess,
	RpcTimeoutError,
	type ExitInfo,
	type RpcProcessLike,
	type RpcProcessOptions,
	type RpcRecord,
	type UiRequest,
} from "./rpc-client.ts";
import {
	findBwrap,
	piSandboxOptions,
	prepareTranscript,
	sandboxAvailability,
	wrapSandboxed,
} from "./sandbox.ts";
import {
	childEnv,
	currentDepth,
	ellipsize,
	emptyUsage,
	errorSignalFromRetry,
	errorSignalFromStop,
	formatDuration,
	formatToolCallText,
	formatUsage,
	inheritableCliFlags,
	isFinished,
	isResumable,
	oneLine,
	resolvePiInvocation,
	type StatusTone,
	type SubagentStatus,
	type UsageStats,
} from "./utils.ts";

const MAX_ITEMS = 400;
const MAX_ITEM_CHARS = 4_000;
const MAX_TOTAL_ITEM_CHARS = 400_000;
const MAX_STDERR_CHARS = 32 * 1024;
/** How long a failed/aborted subagent keeps nagging in the footer status line. */
const STATUS_LINE_MEMORY_MS = 10 * 60_000;
/** Columns the footer may spend on one running subagent's name before counts take over. */
const STATUS_LINE_NAME_BUDGET = 22;
export const MAX_RUNNING_SUBAGENTS = 8;
/**
 * Tool selection for a read-only subagent. `bash` stays, because research and
 * review without a shell is useless (`jj log`, `git diff`, pipelines): the
 * read-only guarantee comes from the bubblewrap sandbox the child runs in, not
 * from this list. `--tools` with plain names replaces the whole selection, so
 * extension tools (codemode and friends) drop out too.
 */
export const READONLY_TOOLS = ["read", "grep", "find", "ls", "bash"];
/** Tools that change state directly, dropped from a read-only request. */
const MUTATING_TOOLS = new Set(["write", "edit", "codemode"]);
const READONLY_PREAMBLE =
	"## Read-only mode (research and review)\n\n" +
	"This subagent investigates and reviews; it does not change anything. The process runs inside a " +
	"bubblewrap sandbox: everything you work with - the workspace, your home, the config files - is read-only, " +
	"the network is available, the host's device nodes do not exist in here (`/dev/sda`, `/dev/mem`) - though " +
	"`/dev/null` does - and the only file you can write is this task's transcript. Writes fail at the syscall - do not retry them or try to work around them.\n\n" +
	"Do: read code, search, `jj log` / `jj show` / `jj diff`, `git log` / `git diff` / `git status`, run " +
	"read-only checks, and fetch docs or sources over the network. Deliver findings as text: what you " +
	"checked, concrete file:line evidence, risks and repro steps, and the patch you would apply - as a " +
	"proposal, never applied.";
/** Default nudge sent to a live child when the user resumes without a message. */
export const DEFAULT_RESUME_TEXT =
	"Your previous turn was interrupted by a provider or service error. Continue the current task from where you stopped.";
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const WAKE_TEXT_LIMIT = 4_000;

export type ActivityKind = "system" | "turn" | "text" | "tool" | "result" | "queue" | "ui" | "input" | "error";

export interface ActivityItem {
	id: number;
	time: number;
	kind: ActivityKind;
	text: string;
	toolName?: string;
}

export interface Subagent {
	id: string;
	name: string;
	task: string;
	cwd: string;
	status: SubagentStatus;
	note?: string;
	model?: string;
	thinkingLevel?: string;
	startedAt: number;
	endedAt?: number;
	pid?: number;
	usage: UsageStats;
	turnCount: number;
	items: ActivityItem[];
	lastAssistantText: string;
	stderr: string;
	transcriptPath: string;
	transcriptQueue: Promise<void>;
	streaming: boolean;
	typing: boolean;
	typingTimer?: NodeJS.Timeout;
	lastActivityAt: number;
	outputChars: number;
	pendingDialogs: number;
	/** Messages the child has queued but not consumed yet (`queue_update`). */
	queuedSteering: number;
	queuedFollowUp: number;
	/** Inspection-only child: sandboxed, and no state-changing tools. */
	readOnly: boolean;
	/** Kernel-level enforcement backing a read-only child, e.g. "bwrap". */
	sandbox?: string;
	/** Tool names the child was actually started with (read-only requests get the preset). */
	tools?: string;
	/** Last provider/model error seen, cleared when a later turn succeeds. */
	lastError?: string;
	/** Child is inside pi's automatic retry loop right now. */
	retrying: boolean;
	/** Set before a user-requested kill so the exit is not reported as a crash. */
	killRequested?: boolean;
	proc?: RpcProcessLike;
	cleanup?: () => void;
}

export interface StartOptions {
	task: string;
	name?: string;
	cwd?: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	/** Inspection only: read-only tools, MCP off, and a read-only system prompt. */
	readOnly?: boolean;
	systemPrompt?: string;
	label?: string;
}

export interface RegistryHooks {
	notify(message: string, level?: "info" | "warning" | "error"): void;
	/** Any state change: the extension uses this to refresh the footer status. */
	onChanged(): void;
	/** Task finished: the extension uses this to wake the parent model. */
	onSettled(subagent: Subagent): void;
	/**
	 * Answer a dialog the child opened through `extension_ui_request`.
	 * Returning `undefined` cancels it, which is also what happens when the
	 * parent has no terminal to show it in.
	 */
	answerDialog(subagent: Subagent, request: UiRequest): Promise<Record<string, unknown> | undefined>;
}

/** One colored segment of the footer status line. */
export interface StatusLinePart {
	text: string;
	tone: StatusTone;
}

export interface StatusView {
	id: string;
	name: string;
	status: SubagentStatus;
	note?: string;
	task: string;
	usage: UsageStats;
	model?: string;
	elapsedMs: number;
	lastItems: ActivityItem[];
	streaming: boolean;
	typing: boolean;
	transcriptPath: string;
	pid?: number;
}

function newSubagentId(): string {
	const stamp = Date.now().toString(36).slice(-5);
	const rand = Math.random().toString(36).slice(2, 5);
	return `sa-${stamp}${rand}`;
}

function deriveName(task: string, provided: string | undefined): string {
	if (provided?.trim()) return oneLine(provided, 40);
	return oneLine(task, 40) || "subagent";
}

function transcriptDirFor(id: string): string {
	return path.join(getAgentDir(), "tmp", "subagent-rpc", id);
}

/** Write a delegated system prompt to a private temp file the child can read. */
async function writeSystemPrompt(name: string, prompt: string): Promise<{ dir: string; file: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-prompt-"));
	const safe = name.replace(/[^\w.-]+/g, "_");
	const file = path.join(dir, `${safe || "prompt"}.md`);
	await fs.promises.writeFile(file, prompt, { encoding: "utf8", mode: 0o600 });
	return { dir, file };
}

export class SubagentRegistry {
	private readonly agents = new Map<string, Subagent>();
	private readonly answeredDialogs = new Set<string>();
	private readonly listeners = new Set<() => void>();
	private itemIds = 0;

	constructor(
		private readonly hooks: RegistryHooks,
		private readonly defaultCwd: string,
		/** Injection seam: the real `pi --mode rpc` child can be swapped for a fake one. */
		private readonly createProcess: (options: RpcProcessOptions) => RpcProcessLike = (options) =>
			new RpcSubagentProcess(options),
		/** Injection seam: lets a caller decide whether bubblewrap is available. */
		private readonly resolveSandbox: () => { ok: boolean; bwrap?: string; reason?: string } = () =>
			sandboxAvailability(),
		) {}

	/** Observe state changes; returns an unsubscribe function. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch {
				// A broken listener must never break the child event pipeline.
			}
		}
	}

	list(): Subagent[] {
		return [...this.agents.values()].sort((a, b) => b.startedAt - a.startedAt);
	}

	get(id: string): Subagent | undefined {
		return this.agents.get(id);
	}

	runningCount(): number {
		let count = 0;
		for (const agent of this.agents.values()) if (!isFinished(agent.status)) count++;
		return count;
	}

	resolve(idOrPrefix: string): Subagent | undefined {
		const exact = this.agents.get(idOrPrefix);
		if (exact) return exact;
		const matches = this.list().filter((agent) => agent.id.startsWith(idOrPrefix) || agent.name === idOrPrefix);
		return matches.length === 1 ? matches[0] : undefined;
	}

	/** Public lookup that fails loudly, for tool and command handlers. */
	require(id: string): Subagent {
		return this.mustFind(id);
	}

	runningAgents(): Subagent[] {
		return this.list().filter((agent) => !isFinished(agent.status));
	}

	/** Forget a record (the child keeps running until it settles or is killed). */
	dropRecord(id: string): void {
		this.agents.delete(id);
	}

	async start(options: StartOptions): Promise<Subagent> {
		if (currentDepth() > 0) {
			throw new Error("subagent tool is disabled inside a subagent (PI_SUBAGENT_DEPTH is set)");
		}
		const task = options.task.trim();
		if (!task) throw new Error("task is required");
		if (this.runningCount() >= MAX_RUNNING_SUBAGENTS) {
			throw new Error(
				`subagent limit reached (${MAX_RUNNING_SUBAGENTS} running); interrupt or kill one first (see /subagent)`,
			);
		}

		const id = newSubagentId();
		const name = deriveName(task, options.name);
		const cwd = path.resolve(this.defaultCwd, options.cwd ?? ".");
		if (!fs.existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
		if (!fs.statSync(cwd).isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
		if (options.thinking && !THINKING_LEVELS.includes(options.thinking)) {
			throw new Error(`invalid thinking "${options.thinking}" (expected ${THINKING_LEVELS.join("|")})`);
		}

		const args = ["--mode", "rpc", "--no-session", ...inheritableCliFlags(process.argv.slice(2), this.defaultCwd)];
		if (options.model) args.push("--model", options.model);
		if (options.thinking) args.push("--thinking", options.thinking);
		if (options.label) args.push("--name", options.label);

		// Tools: an exact selection normally, the read-only preset when asked. MCP
		// tools are not covered by `--tools`, so read-only also disables MCP.
		let tools = options.tools?.length ? [...options.tools] : undefined;
		let readOnlyNote: string | undefined;
		if (options.readOnly) {
			const dropped = (tools ?? []).filter((tool) => MUTATING_TOOLS.has(tool) || tool.startsWith("mcp__"));
			const kept = (tools ?? []).filter((tool) => !MUTATING_TOOLS.has(tool) && !tool.startsWith("mcp__"));
			tools = kept.length > 0 ? kept : [...READONLY_TOOLS];
			if (dropped.length > 0) readOnlyNote = `dropped ${dropped.join(", ")}: not read-only`;
			args.push("--tools", tools.join(","));
			if (!args.includes("--no-mcp")) args.push("--no-mcp");
		} else if (tools?.length) {
			args.push("--tools", tools.join(","));
		}

		const systemPrompt = options.readOnly
			? [READONLY_PREAMBLE, options.systemPrompt?.trim()].filter(Boolean).join("\n\n")
			: options.systemPrompt?.trim();

		let cleanup: (() => void) | undefined;
		let systemPromptFile: string | undefined;
		if (systemPrompt) {
			const written = await writeSystemPrompt(name, systemPrompt);
			systemPromptFile = written.file;
			cleanup = () => {
				try {
					fs.rmSync(written.dir, { recursive: true, force: true });
				} catch {
					// Best effort.
				}
			};
			args.push("--append-system-prompt", written.file);
		}

		const transcriptPath = path.join(transcriptDirFor(id), "transcript.jsonl");
		await fs.promises.mkdir(path.dirname(transcriptPath), { recursive: true });

		// A read-only child runs inside bubblewrap: read-only filesystem, network on,
		// no host device nodes, and its transcript file as the only writable host path.
		let sandbox: string | undefined;
		if (options.readOnly) {
			prepareTranscript(transcriptPath);
			const availability = this.resolveSandbox();
			if (!availability.ok || !availability.bwrap) {
				cleanup?.();
				throw new Error(`read-only subagent needs a sandbox: ${availability.reason ?? "sandbox unavailable"}`);
			}
			sandbox = "bwrap";
		}

		const subagent: Subagent = {
			id,
			name,
			task,
			cwd,
			status: "spawning",
			startedAt: Date.now(),
			usage: emptyUsage(),
			turnCount: 0,
			retrying: false,
			items: [],
			lastAssistantText: "",
			stderr: "",
			transcriptPath,
			transcriptQueue: Promise.resolve(),
			streaming: false,
			readOnly: options.readOnly === true,
			...(sandbox ? { sandbox } : {}),
			...(tools?.length ? { tools: tools.join(",") } : {}),
			typing: false,
			lastActivityAt: Date.now(),
			outputChars: 0,
			queuedSteering: 0,
			queuedFollowUp: 0,
			pendingDialogs: 0,
			cleanup,
		};
		this.agents.set(id, subagent);

		const env = childEnv(process.env, { readOnly: options.readOnly === true, sandbox });
		let invocation = resolvePiInvocation(args);
		if (options.readOnly && sandbox) {
			const agentDir = getAgentDir();
			invocation = wrapSandboxed(
				findBwrap() ?? "bwrap",
				invocation.command,
				invocation.args,
				piSandboxOptions({ transcriptPath, cwd, systemPromptFile }),
			);
		}

		const proc = this.createProcess({
			command: invocation.command,
			args: invocation.args,
			cwd,
			env,
			handlers: {
				onEvent: (event) => this.handleEvent(subagent, event),
				onUiRequest: (request) => void this.handleUiRequest(subagent, request),
				onStderr: (chunk) => {
					subagent.stderr = (subagent.stderr + chunk).slice(-MAX_STDERR_CHARS);
				},
				onExit: (info) => this.handleExit(subagent, info),
			},
		});
		subagent.proc = proc;

		try {
			proc.start();
		} catch (error) {
			subagent.status = "failed";
			subagent.note = error instanceof Error ? error.message : String(error);
			subagent.endedAt = Date.now();
			cleanup?.();
			this.push(subagent, "error", subagent.note);
			throw error;
		}

		subagent.pid = proc.pid;
		this.push(subagent, "system", `spawned pid ${proc.pid ?? "?"} in ${cwd}`);
		if (options.readOnly) {
			this.push(
				subagent,
				"system",
				`read-only: bwrap sandbox (workspace read-only, only ${path.basename(transcriptPath)} writable, net on, no host devices), tools ${tools?.join(", ") ?? "?"}`,
			);
			if (readOnlyNote) this.push(subagent, "system", `⚠ ${readOnlyNote}`);
		}

		// Best-effort: report the child's effective model without blocking startup.
		void proc
			.getState(0)
			.then((state) => {
				const model = state?.model as { provider?: string; id?: string } | undefined;
				if (model?.id) subagent.model = model.provider ? `${model.provider}/${model.id}` : model.id;
				if (typeof state?.thinkingLevel === "string") subagent.thinkingLevel = state.thinkingLevel;
			})
			.catch(() => undefined);

		try {
			const accepted = await proc.prompt(task);
			subagent.status = "running";
			this.push(subagent, "input", `prompt ${accepted?.disposition ?? "started"}`);
		} catch (error) {
			subagent.status = "failed";
			subagent.note = error instanceof Error ? error.message : String(error);
			subagent.endedAt = Date.now();
			this.push(subagent, "error", subagent.note);
			await proc.stop({ force: true, killGraceMs: 2_000 });
			cleanup?.();
			throw error;
		}

		return subagent;
	}

	/** Send an update into a running task. Returns the RPC disposition string. */
	async send(id: string, message: string, mode: "auto" | "steer" | "follow_up" | "prompt"): Promise<string> {
		const subagent = this.mustFind(id);
		if (isFinished(subagent.status) || !subagent.proc?.alive) {
			const hint = canResume(subagent)
				? `resume it with action "resume" to continue where it stopped`
				: `start a new subagent for more work`;
			throw new Error(`subagent ${subagent.id} already finished (${subagent.status}); ${hint}`);
		}
		const text = message.trim();
		if (!text) throw new Error("message is required");

		let resolved = mode;
		if (resolved === "auto") {
			resolved = (await this.isStreaming(subagent)) ? "steer" : "prompt";
		}

		let disposition: string;
		if (resolved === "steer") {
			disposition = (await subagent.proc.steer(text)).disposition ?? "queued";
		} else if (resolved === "follow_up") {
			disposition = (await subagent.proc.followUp(text)).disposition ?? "queued";
		} else {
			disposition = (await subagent.proc.prompt(text)).disposition ?? "started";
		}
		this.push(subagent, "input", `${resolved.replace("_", "-")} ${disposition}: ${oneLine(text, 160)}`);
		return disposition;
	}

	/**
	 * Continue a task that stopped early (provider/service error, abort) by
	 * prompting its still-live child, so the child keeps everything it already
	 * did. Restarting from scratch is deliberately not supported: a `--no-session`
	 * child has no session file to resume, so a fresh child would start from zero.
	 */
	async resume(id: string, message?: string): Promise<string> {
		const subagent = this.mustFind(id);
		if (!isFinished(subagent.status)) {
			throw new Error(`subagent ${subagent.id} is ${subagent.status}; use action "send" while it runs`);
		}
		if (subagent.status === "settled") {
			throw new Error(`subagent ${subagent.id} finished its task; start a new subagent for more work`);
		}
		if (!subagent.proc?.alive) {
			throw new Error(`subagent ${subagent.id} has no live child to resume (${subagent.status}); start a new subagent`);
		}

		const text = message?.trim() || DEFAULT_RESUME_TEXT;
		let disposition: string;
		try {
			disposition = (await subagent.proc.prompt(text)).disposition ?? "started";
		} catch (error) {
			throw new Error(`resume failed: ${error instanceof Error ? error.message : String(error)}`);
		}

		subagent.status = "running";
		subagent.endedAt = undefined;
		subagent.note = undefined;
		subagent.lastError = undefined;
		subagent.retrying = false;
		this.push(subagent, "system", "resumed in place (the child kept its context)");
		this.push(subagent, "input", `resume ${disposition}: ${oneLine(text, 160)}`);
		return `resumed (${disposition})`;
	}

	/** Abort the current run; the task then settles as aborted. */
	async interrupt(id: string): Promise<string> {
		const subagent = this.mustFind(id);
		if (!subagent.proc?.alive) return `already finished (${subagent.status})`;
		// Do not fire an abort at an idle child: it would only be answered later.
		if (!(await this.isStreaming(subagent))) {
			await subagent.proc.clearQueue().catch(() => undefined);
			return `idle, nothing to interrupt (queued messages cleared; status ${subagent.status})`;
		}
		this.push(subagent, "system", "abort requested");
		try {
			await subagent.proc.abort();
			return "aborted";
		} catch (error) {
			if (error instanceof RpcTimeoutError) {
				return "abort still settling (child is finishing a long tool call)";
			}
			throw error;
		}
	}

	/** `get_state` when reachable, otherwise whatever the event stream told us. */
	private async isStreaming(subagent: Subagent): Promise<boolean> {
		if (!subagent.proc) return false;
		const state = await subagent.proc.getState(3_000).catch(() => undefined);
		return typeof state?.isStreaming === "boolean" ? state.isStreaming : subagent.streaming;
	}

	async kill(id: string): Promise<string> {
		const subagent = this.mustFind(id);
		if (!subagent.proc) return "no process";
		const wasRunning = !isFinished(subagent.status);
		// Mark it first: handleExit fires while we wait for the child to die.
		subagent.killRequested = true;
		await subagent.proc.stop({ force: true });
		if (wasRunning) {
			subagent.status = "exited";
			subagent.note = "killed by user";
			subagent.endedAt = Date.now();
			this.push(subagent, "system", "killed by user");
			subagent.cleanup?.();
		}
		return "killed";
	}

	clearFinished(): number {
		let removed = 0;
		for (const [id, agent] of [...this.agents.entries()]) {
			if (!isFinished(agent.status)) continue;
			agent.killRequested = true;
			agent.proc?.stop({ force: true, killGraceMs: 500 }).catch(() => undefined);
			this.agents.delete(id);
			removed++;
		}
		return removed;
	}

	/** Idempotent teardown for `session_shutdown`. */
	async disposeAll(): Promise<void> {
		const pending = [...this.agents.values()].map(async (agent) => {
			agent.killRequested = true; // shutdown is not a crash
			try {
				await agent.proc?.stop({ force: true, killGraceMs: 3_000 });
			} catch {
				// Process is already gone.
			}
			agent.cleanup?.();
		});
		await Promise.allSettled(pending);
		this.agents.clear();
	}

	private mustFind(id: string): Subagent {
		const found = this.resolve(id);
		if (!found) throw new Error(`unknown subagent id: ${id} (see /subagent or action "list")`);
		return found;
	}

	// ------------------------------------------------------------------ events

	private handleEvent(subagent: Subagent, event: RpcRecord): void {
		switch (event.type) {
			case "agent_start":
				subagent.status = "running";
				subagent.streaming = true;
				this.push(subagent, "system", "run started");
				break;
			case "turn_start":
				subagent.turnCount++;
				subagent.usage.turns = subagent.turnCount;
				this.push(subagent, "turn", `turn ${subagent.turnCount}`);
				break;
			case "message_end":
				this.handleMessageEnd(subagent, event.message);
				break;
			case "tool_execution_start":
				this.push(subagent, "tool", formatToolCallText(String(event.toolName ?? "?"), event.args ?? {}), {
					toolName: String(event.toolName ?? "?"),
				});
				break;
			case "tool_execution_update":
				subagent.outputChars += 1;
				subagent.lastActivityAt = Date.now();
				break;
			case "tool_execution_end": {
				const duration = typeof event.durationMs === "number" ? ` (${Math.round(event.durationMs)}ms)` : "";
				const flag = event.isError ? " failed" : "";
				this.push(subagent, "result", `${String(event.toolName ?? "tool")} done${duration}${flag}`);
				break;
			}
			case "queue_update": {
				const steering = Array.isArray(event.steering) ? event.steering.length : 0;
				const followUp = Array.isArray(event.followUp) ? event.followUp.length : 0;
				// The child re-broadcasts an unchanged queue; only a change is news.
				if (steering === subagent.queuedSteering && followUp === subagent.queuedFollowUp) break;
				subagent.queuedSteering = steering;
				subagent.queuedFollowUp = followUp;
				this.push(subagent, "queue", `queued: ${steering} steering, ${followUp} follow-up`);
				break;
			}
			case "compaction_start":
				this.push(subagent, "system", "compacting context");
				break;
			case "auto_retry_start": {
				// pi is retrying the failed request on its own; only the last word matters.
				const signal = errorSignalFromRetry(event);
				if (signal.kind === "error") subagent.lastError = signal.text;
				subagent.retrying = true;
				const delay = Math.round(Number(event.delayMs ?? 0) / 1000);
				this.push(
					subagent,
					"system",
					`provider error, retry ${event.attempt ?? 1}/${event.maxAttempts ?? "?"} in ${delay}s: ${oneLine(subagent.lastError ?? "provider error", 200)}`,
				);
				break;
			}
			case "auto_retry_end": {
				subagent.retrying = false;
				const signal = errorSignalFromRetry(event);
				if (signal.kind === "clear") {
					subagent.lastError = undefined;
					this.push(subagent, "system", `recovered after ${event.attempt ?? 1} retries`);
				} else if (signal.kind === "error") {
					subagent.lastError = signal.text;
					this.push(subagent, "error", `giving up after ${event.attempt ?? 1} retries: ${oneLine(signal.text, 300)}`);
				}
				break;
			}
			case "summarization_retry_scheduled":
				this.push(subagent, "system", `retry scheduled (compaction): ${oneLine(String(event.errorMessage ?? ""), 200)}`);
				break;
			case "message_update":
				this.markTyping(subagent);
				break;
			case "agent_end":
				subagent.streaming = false;
				subagent.typing = false;
				break;
			case "agent_settled":
				subagent.streaming = false;
				subagent.typing = false;
				this.finish(subagent, event.aborted ? "aborted" : "settled");
				break;
			default:
				break;
		}
	}

	private handleMessageEnd(subagent: Subagent, message: RpcRecord | undefined): void {
		if (!message || typeof message !== "object") return;
		this.appendTranscript(subagent, message);

		if (message.role === "assistant") {
			const usage = message.usage as Record<string, unknown> | undefined;
			if (usage) {
				const cost = usage.cost as Record<string, unknown> | number | undefined;
				const costTotal =
					typeof cost === "number" ? cost : Number((cost as Record<string, unknown> | undefined)?.total ?? 0);
				const numeric = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
				subagent.usage.input += numeric(usage.input);
				subagent.usage.output += numeric(usage.output);
				subagent.usage.cacheRead += numeric(usage.cacheRead);
				subagent.usage.cacheWrite += numeric(usage.cacheWrite);
				subagent.usage.cost += costTotal;
				subagent.usage.contextTokens = numeric(usage.totalTokens) || subagent.usage.contextTokens;
			}
			const model = message.model as string | undefined;
			const provider = message.provider as string | undefined;
			if (model) subagent.model = provider ? `${provider}/${model}` : model;
			const signal = errorSignalFromStop(message.stopReason, message.errorMessage);
			if (signal.kind === "error") {
				subagent.lastError = signal.text;
				this.push(subagent, "error", signal.text);
			} else if (signal.kind === "clear") {
				// A turn that ended normally clears any earlier provider error.
				subagent.lastError = undefined;
				subagent.retrying = false;
			}

			let text = "";
			for (const part of Array.isArray(message.content) ? message.content : []) {
				if (part?.type === "text" && typeof part.text === "string") text += part.text;
			}
			if (text.trim()) {
				subagent.lastAssistantText = text;
				this.push(subagent, "text", text.trim());
			}
			subagent.lastActivityAt = Date.now();
			return;
		}

		if (message.role === "toolResult") {
			const firstLine = this.toolResultSummary(message);
			if (firstLine) this.push(subagent, "result", firstLine);
		}
	}

	private toolResultSummary(message: RpcRecord): string {
		const chunks: string[] = [];
		for (const part of Array.isArray(message.content) ? message.content : []) {
			if (part?.type === "text" && typeof part.text === "string") chunks.push(part.text);
		}
		const text = chunks.join(" ").replace(/\s+/g, " ").trim();
		if (!text) return "";
		return ellipsize(text, 160);
	}

	private markTyping(subagent: Subagent): void {
		// Throttle: streaming produces a torrent of deltas, so only the indicator moves.
		if (!subagent.typing) {
			subagent.typing = true;
			subagent.lastActivityAt = Date.now();
			this.emit();
		}
		if (subagent.typingTimer) clearTimeout(subagent.typingTimer);
		const timer = setTimeout(() => {
			subagent.typing = false;
			subagent.typingTimer = undefined;
		}, 400);
		timer.unref?.();
		subagent.typingTimer = timer;
	}

	private finish(subagent: Subagent, outcome: "settled" | "aborted"): void {
		if (isFinished(subagent.status)) return;

		// A run that ended because the provider kept failing is not a completed task.
		const failed = outcome === "settled" && Boolean(subagent.lastError);
		const status: SubagentStatus = failed ? "failed" : outcome;
		subagent.status = status;
		subagent.endedAt = Date.now();
		if (failed) subagent.note = oneLine(subagent.lastError ?? "model error", 300);
		this.push(
			subagent,
			status === "settled" ? "system" : "error",
			status === "settled"
				? "task settled"
				: status === "aborted"
					? "task aborted"
					: `task failed: ${subagent.note}`,
		);

		subagent.queuedSteering = 0;
		subagent.queuedFollowUp = 0;

		if (!subagent.lastAssistantText) {
			const lastText = [...subagent.items].reverse().find((item) => item.kind === "text");
			if (lastText) subagent.lastAssistantText = lastText.text;
		}

		if (status === "settled") {
			subagent.cleanup?.();
			// Orderly shutdown of the child now that the task is over.
			void subagent.proc?.stop().catch(() => undefined);
		} else {
			// Keep the child alive: resume() continues this task in place. Kill it
			// with action "kill" (or /subagent-kill --force) to free the process.
			this.push(subagent, "system", `child kept alive to resume: subagent{action:"resume", id:"${subagent.id}"}`);
		}
		this.hooks.onSettled(subagent);
	}

	private handleExit(subagent: Subagent, info: { code: number | null; signal: NodeJS.Signals | null; error?: Error }): void {
		subagent.streaming = false;
		subagent.typing = false;
		if (subagent.typingTimer) clearTimeout(subagent.typingTimer);
		subagent.typingTimer = undefined;
		subagent.cleanup?.();

		if (isFinished(subagent.status)) {
			if (typeof info.code === "number" && info.code !== 0 && subagent.status === "settled") {
				subagent.note = `child exit code ${info.code}`;
			}
			return;
		}

		const crashed = subagent.proc?.describeExit(info) ?? "subagent exited";
		const errored =
			!subagent.killRequested &&
			(Boolean(info.error) || (typeof info.code === "number" && info.code !== 0) || Boolean(info.signal));
		if (subagent.killRequested) {
			// A kill the user asked for is not a failure.
			subagent.status = "exited";
			subagent.note = "killed by user";
			subagent.endedAt = Date.now();
			this.push(subagent, "system", "killed by user");
			this.hooks.onSettled(subagent);
			return;
		}
		subagent.status = errored ? "failed" : "exited";
		subagent.note = errored ? crashed : subagent.note ?? "child exited";
		subagent.endedAt = Date.now();
		if (errored) subagent.lastError = crashed;
		this.push(subagent, "error", `${crashed}${subagent.stderr.trim() ? `\nstderr: ${oneLine(subagent.stderr.trim(), 400)}` : ""}`);
		this.hooks.onSettled(subagent);
	}

	// ------------------------------------------------------------- child dialogs

	private async handleUiRequest(subagent: Subagent, request: UiRequest): Promise<void> {
		const isDialog = ["select", "confirm", "input", "editor"].includes(request.method);

		if (!isDialog) {
			const text =
				request.method === "notify"
					? `[child notify] ${String(request.message ?? "")}`
					: request.method === "setStatus"
						? `[child status] ${String(request.statusKey ?? "")}: ${String(request.statusText ?? "")}`
						: `[child ui] ${request.method}`;
			this.push(subagent, "ui", ellipsize(text, 300));
			return;
		}

		subagent.pendingDialogs++;
		this.push(
			subagent,
			"ui",
			`child asked (${request.method}): ${oneLine(String(request.title ?? request.message ?? ""), 200)}`,
		);

		const key = `${subagent.id}:${request.id}`;
		let payload: Record<string, unknown> | undefined;
		try {
			payload = await this.hooks.answerDialog(subagent, request);
		} catch (error) {
			payload = { cancelled: true };
			this.push(subagent, "error", `dialog forwarding failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			subagent.pendingDialogs = Math.max(0, subagent.pendingDialogs - 1);
		}

		if (this.answeredDialogs.has(key)) return;
		this.answeredDialogs.add(key);
		const answer = payload ?? { cancelled: true };
		subagent.proc?.answerUi(request.id, answer);
		this.push(subagent, "ui", `answered ${request.method}: ${ellipsize(JSON.stringify(answer) ?? "{}", 120)}`);
	}

	// ------------------------------------------------------------------ records

	private push(subagent: Subagent, kind: ActivityKind, rawText: string, extra?: { toolName?: string }): void {
		const text = rawText.length > MAX_ITEM_CHARS ? `${rawText.slice(0, MAX_ITEM_CHARS)}\n…[truncated]` : rawText;
		subagent.items.push({ id: ++this.itemIds, time: Date.now(), kind, text, ...(extra?.toolName ? { toolName: extra.toolName } : {}) });
		subagent.lastActivityAt = Date.now();

		let total = 0;
		for (const item of subagent.items) total += item.text.length;
		while (subagent.items.length > MAX_ITEMS || (total > MAX_TOTAL_ITEM_CHARS && subagent.items.length > 20)) {
			total -= subagent.items.shift()?.text.length ?? 0;
		}
		this.emit();
	}

	private appendTranscript(subagent: Subagent, record: unknown): void {
		subagent.transcriptQueue = subagent.transcriptQueue.then(async () => {
			try {
				await fs.promises.appendFile(subagent.transcriptPath, `${JSON.stringify(record)}\n`, "utf8");
			} catch {
				// Transcript is a convenience copy; never fail the task over it.
			}
		});
	}
}

/** Model-facing summary of one subagent. */
export function formatStatusText(subagent: Subagent, tailItems: number): string {
	const lines: string[] = [];
	const meta = `${subagent.id} ${subagent.status}${subagent.note ? ` (${subagent.note})` : ""}`;
	lines.push(meta);
	lines.push(`task: ${oneLine(subagent.task, 200)}`);
	if (subagent.model) lines.push(`model: ${subagent.model}${subagent.thinkingLevel ? ` thinking=${subagent.thinkingLevel}` : ""}`);
	lines.push(`usage: ${formatUsage(subagent.usage)}`);
	const queued = subagent.queuedSteering + subagent.queuedFollowUp;
	lines.push(
		`runtime: ${formatDuration((subagent.endedAt ?? Date.now()) - subagent.startedAt)} elapsed` +
			(isFinished(subagent.status)
				? ""
				: ` · ${subagent.typing ? "typing" : subagent.streaming ? "working" : "idle"}` +
					` · last output ${formatDuration(Date.now() - subagent.lastActivityAt)} ago`) +
			(queued > 0 ? ` · ${queued} queued` : "") +
			(subagent.pendingDialogs > 0 ? ` · ${subagent.pendingDialogs} dialog unanswered` : "") +
			(subagent.retrying ? " · retrying" : ""),
	);
	if (subagent.readOnly) {
		lines.push(
			`read-only: ${subagent.sandbox ?? "bwrap"} sandbox - workspace and config read-only (only the transcript is writable), network on, no host devices`,
		);
		lines.push(`tools: ${subagent.tools ?? "read, grep, find, ls, bash"}`);
	}
	if (canResume(subagent)) {
		lines.push(`resumable: yes - subagent{action:"resume", id:"${subagent.id}"} continues this child in place`);
	}
	lines.push(`transcript: ${subagent.transcriptPath}`);
	const tail = subagent.items.slice(-Math.max(1, tailItems));
	if (tail.length > 0) {
		lines.push("", "last activity:");
		for (const item of tail) lines.push(`  [${item.kind}] ${oneLine(item.text, 200)}`);
	}
	if (subagent.lastAssistantText) {
		lines.push("", "final output:", subagent.lastAssistantText.slice(0, WAKE_TEXT_LIMIT));
	} else if (subagent.stderr.trim()) {
		lines.push("", "stderr:", oneLine(subagent.stderr.trim(), 1_000));
	}
	return lines.join("\n");
}

/** Whether `resume()` can continue this record: a bad ending with a live child. */
export function canResume(subagent: Subagent): boolean {
	return isResumable(subagent.status) && Boolean(subagent.proc?.alive);
}

/**
 * Deliver a human instruction: steer a running task, or continue one that
 * stopped early. A stopped-but-live subagent still takes instructions, so there
 * is no separate "retry" entry point to remember. Returns user-facing text.
 */
export async function deliverMessage(store: SubagentRegistry, id: string, text: string): Promise<string> {
	const target = store.resolve(id);
	if (target && canResume(target)) {
		const outcome = await store.resume(target.id, text.trim() || undefined);
		return `${outcome} ${target.id} (its child kept the context)`;
	}
	const disposition = await store.send(id, text, "auto");
	return `sent (${disposition}) to ${id}`;
}

/** Extra knobs for the footer status line. */
export interface StatusLineOptions {
	/** Visible columns to spend on one running subagent's name; 0 hides names entirely. */
	nameBudget?: number;
}

/**
 * Segments for the parent's footer status line, which shares one terminal line
 * with every other extension: keep it short and let `/subagent` carry the detail.
 * The leading `sub` labels the group, so the flags after it stay terse:
 * `sub ⏳3 ⚑1 ✗1↻`, or `sub ⏳ refactor footer 4m00s` when a single one runs.
 */
export function statusLineParts(agents: Subagent[], now = Date.now(), options: StatusLineOptions = {}): StatusLinePart[] {
	const nameBudget = Math.max(0, options.nameBudget ?? STATUS_LINE_NAME_BUDGET);
	const running = agents.filter((agent) => !isFinished(agent.status));
	const dialogs = agents.reduce((total, agent) => total + agent.pendingDialogs, 0);
	// Failures stop nagging once they are older than this window.
	const recent = agents.filter(
		(agent) =>
			(agent.status === "failed" || agent.status === "aborted") &&
			now - (agent.endedAt ?? agent.lastActivityAt) < STATUS_LINE_MEMORY_MS,
	);

	const parts: StatusLinePart[] = [];
	if (running.length > 0) {
		// Busy first: a spinner means the child is actually producing something.
		const icon = running.some((agent) => agent.typing) ? "▌" : running.some((agent) => agent.retrying) ? "↻" : "⏳";
		let tail = `${running.length}`;
		if (running.length === 1 && nameBudget > 0) {
			const only = running[0]!;
			tail = ` ${oneLine(only.name, nameBudget)}`;
			if (nameBudget >= 14) tail += ` ${formatDuration((only.endedAt ?? now) - only.startedAt)}`;
		}
		parts.push({ text: `${icon}${tail}`, tone: running.every((agent) => agent.retrying) ? "warning" : "accent" });
	}
	if (dialogs > 0) parts.push({ text: `⚑${dialogs}`, tone: "warning" });
	if (recent.length > 0) {
		const failed = recent.filter((agent) => agent.status === "failed").length;
		const aborted = recent.length - failed;
		const bits = [failed ? `${failed}f` : "", aborted ? `${failed > 0 ? "+" : ""}${aborted}a` : ""].filter(Boolean).join("");
		parts.push({ text: `✗${bits}${recent.every(canResume) ? "↻" : ""}`, tone: "error" });
	}
	if (parts.length === 0) return [];
	return [{ text: "sub", tone: "muted" }, ...parts];
}

/** Compact one-line-per-agent listing for the model. */
export function formatListText(agents: Subagent[]): string {
	if (agents.length === 0) return "no subagents in this session";
	return agents
		.map((agent) => {
			const elapsed = Math.round(((agent.endedAt ?? Date.now()) - agent.startedAt) / 1000);
			const queued = agent.queuedSteering + agent.queuedFollowUp;
			const last = [...agent.items].reverse().find((item) => item.kind === "tool" || item.kind === "text");
			return [
				`${agent.id} ${agent.status.padEnd(8)} ${oneLine(agent.name, 30)}`,
				`turns=${agent.turnCount}`,
				`$${agent.usage.cost.toFixed(4)}`,
				`${elapsed}s`,
				agent.readOnly ? "ro" : "",
				agent.model ?? "",
				agent.streaming ? (agent.typing ? "typing" : "streaming") : "",
				queued > 0 ? `${queued} queued` : "",
				agent.pendingDialogs > 0 ? `${agent.pendingDialogs} dialog unanswered` : "",
				canResume(agent) ? "resumable" : "",
				last ? `· ${oneLine(last.text, 80)}` : "",
			]
				.filter(Boolean)
				.join(" ");
		})
		.join("\n");
}
