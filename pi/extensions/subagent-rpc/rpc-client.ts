/**
 * Minimal JSONL client for a `pi --mode rpc` child process.
 *
 * The exported `RpcClient` is not usable here: it hardcodes
 * `spawn("node", [cliPath, ...])` with a default *relative* `cliPath`
 * (`dist/cli.js`), which breaks Bun single-file builds, and it ignores
 * `extension_ui_request` records entirely, so any dialog opened by an extension
 * inside the child would block forever. Subagents inherit the parent's
 * extensions, so both problems are live here.
 *
 * Protocol references: docs/rpc.md (framing, correlation, shutdown),
 * docs/rpc-commands.md (commands), docs/rpc-extension-ui.md (UI sub-protocol).
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export type RpcRecord = Record<string, any>;

export interface UiRequest {
	id: string;
	method: string;
	[key: string]: unknown;
}

export interface ExitInfo {
	code: number | null;
	signal: NodeJS.Signals | null;
	error?: Error;
}

export interface RpcProcessHandlers {
	/** Any non-response, non-UI record: session events from docs/json.md. */
	onEvent(event: RpcRecord): void;
	/** `extension_ui_request`: dialogs need an answer, notifications do not. */
	onUiRequest(request: UiRequest): void;
	/** Raw stderr chunk. Never protocol data - diagnostics only. */
	onStderr(chunk: string): void;
	/** Process terminated, or a spawn-time failure (with `error`). */
	onExit(info: ExitInfo): void;
}

export interface RpcProcessOptions {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	/** Hard deadline for an unanswered child dialog. */
	uiDeadlineMs?: number;
	/** Default per-command deadline. */
	commandTimeoutMs?: number;
	handlers: RpcProcessHandlers;
}

/** Dialog methods that block the child until the client answers. */
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_UI_DEADLINE_MS = 120_000;

export class RpcTimeoutError extends Error {
	constructor(public readonly commandType: string, timeoutMs: number) {
		super(`subagent RPC command "${commandType}" timed out after ${timeoutMs}ms`);
		this.name = "RpcTimeoutError";
	}
}

interface PendingRequest {
	resolve: (data: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout | undefined;
	type: string;
}

export class RpcSubagentProcess {
	private proc: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
	private pending: Buffer = Buffer.alloc(0);
	private nextId = 0;
	private readonly requests = new Map<string, PendingRequest>();
	private readonly dialogTimers = new Map<string, NodeJS.Timeout>();
	private stderrText = "";
	private exitInfo: ExitInfo | null = null;
	private stopping = false;
	private exitWaiters: Array<(info: ExitInfo) => void> = [];
	private readonly uiDeadlineMs: number;
	private readonly commandTimeoutMs: number;

	constructor(private readonly options: RpcProcessOptions) {
		this.uiDeadlineMs = options.uiDeadlineMs ?? DEFAULT_UI_DEADLINE_MS;
		this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
	}

	get pid(): number | undefined {
		return this.proc?.pid;
	}

	get alive(): boolean {
		return this.proc !== null && this.exitInfo === null;
	}

	get exitCode(): number | null | undefined {
		return this.exitInfo?.code;
	}

	get exitSignal(): NodeJS.Signals | null | undefined {
		return this.exitInfo?.signal;
	}

	get stderr(): string {
		return this.stderrText;
	}

	start(): void {
		if (this.proc) throw new Error("RpcSubagentProcess already started");

		let child: ChildProcessByStdio<Writable, Readable, Readable>;
		try {
			child = spawn(this.options.command, this.options.args, {
				cwd: this.options.cwd,
				env: this.options.env as NodeJS.ProcessEnv,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			throw new Error(`Failed to spawn subagent: ${error instanceof Error ? error.message : String(error)}`);
		}

		this.proc = child;
		child.stdin.on("error", (error) => this.appendStderr(`stdin error: ${error.message}`));
		child.stdout.on("data", (chunk: Buffer) => this.onStdoutChunk(chunk));
		child.stderr.on("data", (chunk: Buffer) => this.appendStderr(chunk.toString("utf8")));
		child.once("error", (error) => this.handleExit({ code: null, signal: null, error }));
		child.once("close", (code, signal) => this.handleExit({ code, signal }));
	}

	appendStderr(chunk: string): void {
		this.stderrText += chunk;
		// Keep only the tail: stderr is a diagnostic, not protocol data.
		const max = 64 * 1024;
		if (this.stderrText.length > max) this.stderrText = this.stderrText.slice(this.stderrText.length - max);
		this.options.handlers.onStderr(chunk);
	}

	/** Strict LF framing. `node:readline` also splits on U+2028/U+2029, which are legal in JSON strings. */
	private onStdoutChunk(chunk: Buffer): void {
		this.pending = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
		let split = this.pending.indexOf(0x0a);
		while (split >= 0) {
			const raw = this.pending.subarray(0, split);
			this.pending = this.pending.subarray(split + 1);
			this.handleLine(raw);
			split = this.pending.indexOf(0x0a);
		}
	}

	private handleLine(raw: Buffer): void {
		const text = raw.toString("utf8").replace(/\r$/, "");
		if (text.trim().length === 0) return;

		let record: RpcRecord;
		try {
			record = JSON.parse(text) as RpcRecord;
		} catch {
			this.options.handlers.onStderr(`\n[rpc] unparsable stdout line: ${text.slice(0, 200)}\n`);
			return;
		}

		if (record.type === "response") {
			this.handleResponse(record);
			return;
		}

		if (record.type === "extension_ui_request") {
			const request = record as unknown as UiRequest;
			if (DIALOG_METHODS.has(request.method)) this.armDialogDeadline(request.id);
			this.options.handlers.onUiRequest(request);
			return;
		}

		this.options.handlers.onEvent(record);
	}

	private handleResponse(record: RpcRecord): void {
		const id = typeof record.id === "string" ? record.id : undefined;
		if (!id) {
			// Parse-level failure ({"command":"parse","success":false}) or an unrequested response.
			if (record.success === false) {
				this.appendStderr(`\n[rpc] ${record.command ?? "protocol"}: ${record.error ?? "unknown error"}\n`);
			}
			return;
		}

		const pending = this.requests.get(id);
		if (!pending) return;
		this.requests.delete(id);
		if (pending.timer) clearTimeout(pending.timer);

		if (record.success === false) {
			pending.reject(new Error(String(record.error ?? `${pending.type} failed`)));
			return;
		}
		pending.resolve(record.data);
	}

	private armDialogDeadline(id: string): void {
		const timer = setTimeout(() => {
			this.dialogTimers.delete(id);
			// Never leave the child blocked waiting on a client that is not answering.
			this.answerUi(id, { cancelled: true });
		}, this.uiDeadlineMs);
		timer.unref?.();
		this.dialogTimers.set(id, timer);
	}

	/**
	 * Answer a child dialog: `{ value }` for select/input/editor,
	 * `{ confirmed }` for confirm, `{ cancelled: true }` to dismiss either.
	 */
	answerUi(id: string, payload: Record<string, unknown>): void {
		const timer = this.dialogTimers.get(id);
		if (timer) {
			clearTimeout(timer);
			this.dialogTimers.delete(id);
		}
		void this.write({ type: "extension_ui_response", id, ...payload }).catch(() => undefined);
	}

	private write(record: Record<string, unknown>): Promise<void> {
		const stdin = this.proc?.stdin;
		if (!stdin || stdin.destroyed || this.exitInfo) {
			return Promise.reject(new Error("subagent stdin is closed"));
		}
		const line = `${JSON.stringify(record)}\n`;
		if (stdin.write(line)) return Promise.resolve();
		// Honor stdin backpressure instead of buffering unbounded commands.
		return new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				stdin.off("drain", onDrain);
				stdin.off("error", onError);
				stdin.off("close", onClose);
			};
			const onDrain = () => {
				cleanup();
				resolve();
			};
			const onError = (error: Error) => {
				cleanup();
				reject(error);
			};
			const onClose = () => {
				cleanup();
				reject(new Error("subagent stdin closed while writing"));
			};
			stdin.once("drain", onDrain);
			stdin.once("error", onError);
			stdin.once("close", onClose);
		});
	}

	/** Send one command and wait for its correlated response. */
	command<T = unknown>(type: string, payload: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
		if (!this.alive) return Promise.reject(new Error(`subagent is not running (command: ${type})`));
		if (this.stopping) return Promise.reject(new Error(`subagent is stopping (command: ${type})`));

		const id = `cmd-${++this.nextId}`;
		const deadline = timeoutMs ?? this.commandTimeoutMs;
		return new Promise<T>((resolve, reject) => {
			const timer =
				deadline > 0
					? setTimeout(() => {
							this.requests.delete(id);
							reject(new RpcTimeoutError(type, deadline));
						}, deadline)
					: undefined;
			timer?.unref?.();
			this.requests.set(id, {
				type,
				timer,
				resolve: (data) => resolve(data as T),
				reject,
			});

			this.write({ id, type, ...payload }).catch((error: Error) => {
				const entry = this.requests.get(id);
				if (!entry) return;
				this.requests.delete(id);
				if (entry.timer) clearTimeout(entry.timer);
				reject(error);
			});
		});
	}

	// ---------------------------------------------------------------- commands

	prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<{ disposition?: string }> {
		return this.command<{ disposition?: string }>("prompt", {
			message,
			...(streamingBehavior ? { streamingBehavior } : {}),
		});
	}

	steer(message: string): Promise<{ disposition?: string }> {
		return this.command<{ disposition?: string }>("steer", { message });
	}

	followUp(message: string): Promise<{ disposition?: string }> {
		return this.command<{ disposition?: string }>("follow_up", { message });
	}

	/** `abort` waits for the child to go idle, so it gets its own short deadline. */
	abort(timeoutMs = 10_000): Promise<unknown> {
		return this.command("abort", {}, timeoutMs);
	}

	clearQueue(): Promise<{ steering?: string[]; followUp?: string[] }> {
		return this.command<{ steering?: string[]; followUp?: string[] }>("clear_queue");
	}

	getState(timeoutMs?: number): Promise<RpcRecord> {
		return this.command<RpcRecord>("get_state", {}, timeoutMs);
	}

	getMessages(): Promise<RpcRecord[]> {
		return this.command<{ messages?: RpcRecord[] }>("get_messages").then((data) => data?.messages ?? []);
	}

	getLastAssistantText(): Promise<string | null> {
		return this.command<{ text?: string | null }>("get_last_assistant_text").then(
			(data) => (typeof data?.text === "string" ? data.text : null),
		);
	}

	setModel(provider: string, modelId: string): Promise<unknown> {
		return this.command("set_model", { provider, modelId });
	}

	setThinkingLevel(level: string): Promise<unknown> {
		return this.command("set_thinking_level", { level });
	}

	// --------------------------------------------------------------- lifecycle

	/** Fail every in-flight command at once (shutdown or child exit). */
	private rejectPending(error: Error): void {
		for (const request of this.requests.values()) {
			if (request.timer) clearTimeout(request.timer);
			request.reject(error);
		}
		this.requests.clear();
	}

	private handleExit(info: ExitInfo): void {
		if (this.exitInfo) return;
		this.exitInfo = info;

		this.rejectPending(new Error(this.describeExit(info)));
		for (const timer of this.dialogTimers.values()) clearTimeout(timer);
		this.dialogTimers.clear();

		const waiters = this.exitWaiters;
		this.exitWaiters = [];
		for (const waiter of waiters) waiter(info);
		this.options.handlers.onExit(info);
	}

	describeExit(info: ExitInfo = this.exitInfo ?? { code: null, signal: null }): string {
		if (info.error) return `subagent process error: ${info.error.message}`;
		if (info.signal) return `subagent terminated by signal ${info.signal}`;
		if (typeof info.code === "number" && info.code !== 0) return `subagent exited with code ${info.code}`;
		return "subagent exited";
	}

	waitForExit(timeoutMs?: number): Promise<ExitInfo> {
		if (this.exitInfo) return Promise.resolve(this.exitInfo);
		if (!this.proc) return Promise.resolve({ code: null, signal: null });
		return new Promise((resolve) => {
			let settled = false;
			const finish = (info: ExitInfo) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				resolve(info);
			};
			const timer =
				timeoutMs && timeoutMs > 0
					? setTimeout(() => finish(this.exitInfo ?? { code: null, signal: null }), timeoutMs)
					: undefined;
			timer?.unref?.();
			this.exitWaiters.push(finish);
		});
	}

	/**
	 * Orderly shutdown: closing stdin asks pi to dispose the runtime and drain
	 * pending work, so give it room before escalating to signals.
	 */
	async stop(options: { force?: boolean; graceMs?: number; killGraceMs?: number } = {}): Promise<void> {
		const child = this.proc;
		if (!child || !this.alive) return;
		// Anything still in flight cannot be answered once we start tearing the child down.
		this.stopping = true;
		this.rejectPending(new Error("subagent is stopping"));

		if (options.force) {
			child.kill("SIGTERM");
			await this.waitForExit(options.killGraceMs ?? 5_000);
			if (this.alive) {
				child.kill("SIGKILL");
				await this.waitForExit(2_000);
			}
			return;
		}

		// Orderly shutdown first: closing stdin lets pi dispose the runtime and drain pending work.
		try {
			child.stdin.end();
		} catch {
			// Already closing; fall through to the wait.
		}
		await this.waitForExit(options.graceMs ?? 1_500);
		if (!this.alive) return;

		child.kill("SIGTERM");
		await this.waitForExit(options.killGraceMs ?? 5_000);
		if (this.alive) {
			child.kill("SIGKILL");
			await this.waitForExit(2_000);
		}
	}
}
