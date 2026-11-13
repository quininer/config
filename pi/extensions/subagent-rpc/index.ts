/**
 * subagent-rpc - delegate one task to a `pi --mode rpc` child and talk to it
 * while it runs.
 *
 * Design (intentionally small):
 * - one subagent = one task; the child is spawned, prompted, and shut down when
 *   it settles;
 * - inside the task the parent can keep sending updates (`steer`, `follow_up`,
 *   `prompt`) and read feedback (activity tail, usage, final output);
 * - the parent model is woken up automatically when a task settles;
 * - `/subagents` (or Ctrl+Alt+A) opens a live view of every subagent, with a
 *   detail screen to tail output and message the child without leaving it.
 *
 * Subagents inherit this session's extensions, so a child's dialogs are
 * forwarded to the parent UI (with a hard auto-cancel deadline) instead of
 * blocking forever, and `PI_SUBAGENT_DEPTH` stops the tool from being registered
 * inside a child at all.
 */

import { StringEnum, type Usage } from "@earendil-works/pi-ai";
import {
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Key, Markdown, Text, type OverlayHandle, type OverlayOptions } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { FULLSCREEN_MARGINS, SubagentManager } from "./manager-ui.ts";
import {
	formatListText,
	formatStatusText,
	MAX_RUNNING_SUBAGENTS,
	type ActivityItem,
	type StartOptions,
	SubagentRegistry,
	type Subagent,
	WAKE_TEXT_LIMIT,
} from "./registry.ts";
import { currentDepth, ellipsize, formatUsage, isFinished, oneLine, statusMeta, type UsageStats } from "./utils.ts";

const TOOL_NAME = "subagent";
const SETTLED_MESSAGE_TYPE = "subagent-settled";
const COLLAPSED_ITEM_COUNT = 5;
const DIALOG_FORWARD_TIMEOUT_MS = 110_000;
const WAIT_POLL_MS = 400;
const DEFAULT_WAIT_TIMEOUT_MS = 15 * 60_000;

type Action = "start" | "send" | "status" | "list" | "interrupt" | "kill" | "clear";
type SendMode = "auto" | "steer" | "follow_up" | "prompt";

interface Snapshot {
	id: string;
	name: string;
	status: string;
	note?: string;
	task: string;
	model?: string;
	startedAt: number;
	endedAt?: number;
	pid?: number;
	usage: UsageStats;
	turnCount: number;
	streaming: boolean;
	items: ActivityItem[];
	lastAssistantText: string;
	stderr: string;
	transcriptPath: string;
}

interface ToolDetails {
	action: Action;
	agents: Snapshot[];
	isError: boolean;
}

const parameters = Type.Object({
	action: StringEnum(["start", "send", "status", "list", "interrupt", "kill", "clear"] as const, {
		description: "start spawns one subagent for one task; send pushes an update into a running task; status reads feedback; list enumerates; interrupt/kill/clear clean up",
	}),
	task: Type.Optional(Type.String({ description: "Task for the new subagent (action=start)" })),
	name: Type.Optional(Type.String({ description: "Short label for the subagent (action=start)" })),
	id: Type.Optional(Type.String({ description: `Subagent id (required except for start/list/clear). "all" works for interrupt/kill` })),
	message: Type.Optional(Type.String({ description: "Update to send into a running task (action=send)" })),
	mode: Type.Optional(StringEnum(["auto", "steer", "follow_up", "prompt"] as const, {
		description: 'How action=send is delivered. "auto" steers while the child runs, otherwise prompts',
	})),
	cwd: Type.Optional(Type.String({ description: "Working directory for the child (action=start, default: current cwd)" })),
	model: Type.Optional(Type.String({ description: "Model pattern for the child, e.g. provider/id (action=start)" })),
	thinking: Type.Optional(
		Type.String({ description: "Thinking level for the child: off|minimal|low|medium|high|xhigh|max (action=start)" }),
	),
	tools: Type.Optional(
		Type.Array(Type.String(), { description: "Exact --tools selection for the child; replaces the default selection" }),
	),
	systemPrompt: Type.Optional(Type.String({ description: "Extra system prompt appended to the child (action=start)" })),
	wait: Type.Optional(Type.Boolean({ description: "action=start only: block until the task settles and return its output" })),
	timeoutSeconds: Type.Optional(Type.Number({ description: "Cap for wait (default 900s)" })),
	tail: Type.Optional(Type.Number({ description: "How many activity items action=status returns (default 20)" })),
});

function snapshot(subagent: Subagent): Snapshot {
	return {
		id: subagent.id,
		name: subagent.name,
		status: subagent.status,
		...(subagent.note ? { note: subagent.note } : {}),
		task: subagent.task,
		...(subagent.model ? { model: subagent.model } : {}),
		startedAt: subagent.startedAt,
		...(subagent.endedAt ? { endedAt: subagent.endedAt } : {}),
		...(subagent.pid ? { pid: subagent.pid } : {}),
		usage: { ...subagent.usage },
		turnCount: subagent.turnCount,
		streaming: subagent.streaming,
		items: subagent.items.slice(-100).map((item) => ({ ...item })),
		lastAssistantText: subagent.lastAssistantText,
		stderr: subagent.stderr.trim().slice(-2_000),
		transcriptPath: subagent.transcriptPath,
	};
}

function details(action: Action, agents: Subagent[], isError = false): ToolDetails {
	return { action, agents: agents.map(snapshot), isError };
}

function textResult(text: string, detailsValue: ToolDetails, isError = false) {
	return isError
		? { content: [{ type: "text" as const, text }], details: detailsValue, isError: true }
		: { content: [{ type: "text" as const, text }], details: detailsValue };
}

function toUsage(usage: UsageStats): Usage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.contextTokens,
		cost: { input: 0, output: usage.cost, cacheRead: 0, cacheWrite: 0, total: usage.cost },
	} as Usage;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => resolve(onTimeout()), ms);
		timer.unref?.();
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

export default function subagentRpcExtension(pi: ExtensionAPI): void {
	// Recursion fuse: a subagent never gets this tool, so it cannot spawn its own.
	if (currentDepth() > 0) {
		pi.registerCommand("subagents", {
			description: "Subagents are disabled inside a subagent",
			handler: async (_args, ctx) => ctx.ui.notify("subagent-rpc is disabled inside a subagent", "info"),
		});
		return;
	}

	let lastCtx: ExtensionContext | undefined;
	let registry: SubagentRegistry | undefined;

	function rememberContext(ctx: ExtensionContext): void {
		lastCtx = ctx;
	}

	function ensureRegistry(ctx: ExtensionContext): SubagentRegistry {
		rememberContext(ctx);
		if (registry) return registry;

		registry = new SubagentRegistry(
			{
				notify: (message, level) => lastCtx?.ui.notify(message, level ?? "info"),
				onSettled: (subagent) => wakeParent(subagent),
				answerDialog: async (subagent, request) => forwardDialog(subagent, request),
			},
			ctx.cwd,
		);
		return registry;
	}

	function wakeParent(subagent: Subagent): void {
		const meta = statusMeta(subagent.status as Subagent["status"]);
		const body = (subagent.lastAssistantText || subagent.note || subagent.stderr.trim() || "(no output)").slice(
			0,
			WAKE_TEXT_LIMIT,
		);
		const summary =
			`[subagent ${subagent.id}] ${subagent.name} ${meta.label}.` +
			`\nTask: ${oneLine(subagent.task, 200)}` +
			`\nUsage: ${formatUsage(subagent.usage, subagent.model)}` +
			(subagent.note ? `\nNote: ${oneLine(subagent.note, 200)}` : "") +
			`\nTranscript: ${subagent.transcriptPath}` +
			`\n\nResult:\n${body}`;

		lastCtx?.ui.notify(`${meta.icon} subagent ${subagent.id} ${meta.label}`, subagent.status === "failed" ? "error" : "info");

		try {
			// Waking the parent model is the point: it consumes the result and continues.
			pi.sendMessage(
				{
					customType: SETTLED_MESSAGE_TYPE,
					content: summary,
					display: true,
					details: snapshot(subagent),
				},
				{ triggerTurn: true },
			);
		} catch (error) {
			lastCtx?.ui.notify(`could not deliver subagent result message: ${String(error)}`, "warning");
		}
	}

	/**
	 * Subagents inherit extensions, so a child can open a dialog. Forward it to
	 * the parent UI; anything unanswered gets cancelled by the client's hard
	 * deadline so the child can never wedge the task.
	 */
	async function forwardDialog(subagent: Subagent, request: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
		const ctx = lastCtx;
		if (!ctx?.hasUI) return { cancelled: true };

		const title = `[${subagent.id}] ${String(request.title ?? request.message ?? "subagent question")}`;
		const method = String(request.method);

		return withTimeout(
			(async (): Promise<Record<string, unknown> | undefined> => {
				if (method === "confirm") {
					const ok = await ctx.ui.confirm(title, String(request.message ?? ""));
					return { confirmed: ok };
				}
				if (method === "select") {
					const options = Array.isArray(request.options) ? (request.options as string[]) : [];
					if (options.length === 0) return { cancelled: true };
					const picked = await ctx.ui.select(title, options);
					return picked === undefined ? { cancelled: true } : { value: picked };
				}
				if (method === "input") {
					const value = await ctx.ui.input(title, String(request.placeholder ?? ""));
					return value === undefined ? { cancelled: true } : { value };
				}
				if (method === "editor") {
					const value = await ctx.ui.editor(title, typeof request.prefill === "string" ? request.prefill : "");
					return value === undefined ? { cancelled: true } : { value };
				}
				return { cancelled: true };
			})(),
			DIALOG_FORWARD_TIMEOUT_MS,
			() => {
				lastCtx?.ui.notify(`subagent ${subagent.id} dialog timed out; cancelled`, "warning");
				return { cancelled: true };
			},
		);
	}

	// ---------------------------------------------------------------------- tool

	pi.registerTool({
		name: TOOL_NAME,
		label: "Subagent",
		description:
			`Run one task in an isolated \`pi --mode rpc\` child (one subagent per task) and keep talking to it while it runs. ` +
			`start returns an id immediately; send pushes updates (steer/follow_up/prompt); status returns the activity tail plus final output; ` +
			`interrupt aborts a task, kill stops the child. Up to ${MAX_RUNNING_SUBAGENTS} concurrent. Watch them with /subagents or Ctrl+Alt+A.`,
		promptSnippet: "Delegate one task to a pi subagent process and steer it while it runs",
		promptGuidelines: [
			"Use subagent{action:\"start\"} for work that benefits from an isolated context; keep going in this session meanwhile.",
			"Read results from the automatic settle message, or call subagent{action:\"status\", id} - do not guess what a subagent did.",
			"Send course corrections with subagent{action:\"send\", id, message}; mode \"auto\" steers a running task and prompts an idle one.",
			"A finished subagent cannot take more messages - start a new one for additional work.",
		],
		executionMode: "parallel",
		parameters,

		async execute(_toolCallId, params, signal, onUpdate, ctx: ExtensionToolContext) {
			rememberContext(ctx);
			const store = ensureRegistry(ctx);
			const action = params.action as Action;

			try {
				switch (action) {
					case "start": {
						if (!params.task?.trim()) throw new Error('task is required for action="start"');
						const options: StartOptions = {
							task: params.task,
							...(params.name ? { name: params.name } : {}),
							...(params.cwd ? { cwd: params.cwd } : {}),
							...(params.model ? { model: params.model } : {}),
							...(params.thinking ? { thinking: params.thinking } : {}),
							...(params.tools?.length ? { tools: params.tools } : {}),
							...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
							...(params.name ? { label: params.name } : {}),
						};
						const subagent = await store.start(options);
						// Models sometimes pass "false"; only a real truthy value waits.
						const shouldWait = params.wait === true || String(params.wait) === "true";
						const timeoutSeconds = Number(params.timeoutSeconds ?? 0) || undefined;
						const tail = Number(params.tail ?? 0) || undefined;

						if (!shouldWait) {
							const text =
								`started ${subagent.id} (${subagent.status})${subagent.model ? ` model=${subagent.model}` : ""}\n` +
								`task: ${oneLine(subagent.task, 160)}\n` +
								`updates: subagent{action:"send", id:"${subagent.id}", message:"..."}\n` +
								`feedback: subagent{action:"status", id:"${subagent.id}"} or /subagents`;
							return textResult(text, details("start", [subagent]));
						}

						const timeoutMs = timeoutSeconds && timeoutSeconds > 0 ? timeoutSeconds * 1000 : DEFAULT_WAIT_TIMEOUT_MS;
						const deadline = Date.now() + timeoutMs;
						onUpdate?.(textResult(`waiting for ${subagent.id}…`, details("start", [subagent])));
						while (!isFinished(subagent.status) && Date.now() < deadline) {
							if (signal?.aborted) {
								await store.interrupt(subagent.id).catch(() => undefined);
								break;
							}
							await sleep(WAIT_POLL_MS);
							onUpdate?.(textResult(`waiting for ${subagent.id}… ${subagent.turnCount} turns`, details("start", [subagent])));
						}
						const text = formatStatusText(subagent, tail ?? 12);
						const result = textResult(text, details("start", [subagent]), subagent.status === "failed");
						return { ...result, usage: toUsage(subagent.usage) };
					}

					case "send": {
						if (!params.id) throw new Error('id is required for action="send"');
						if (!params.message?.trim()) throw new Error('message is required for action="send"');
						const disposition = await store.send(params.id, params.message, (params.mode as SendMode) ?? "auto");
						const subagent = store.require(params.id);
						return textResult(`sent (${disposition}) to ${subagent.id}`, details("send", [subagent]));
					}

					case "status": {
						if (!params.id) throw new Error('id is required for action="status"');
						const subagent = store.require(params.id);
						const statusTail = Number(params.tail ?? 0) || 20;
						return { ...textResult(formatStatusText(subagent, statusTail), details("status", [subagent])) };
					}

					case "list": {
						const agents = store.list();
						return textResult(formatListText(agents), details("list", agents));
					}

					case "interrupt": {
						const targets = params.id === "all" ? store.runningAgents() : params.id ? [store.require(params.id)] : [];
						if (targets.length === 0) throw new Error('id is required for action="interrupt" (or use id:"all")');
						const notes: string[] = [];
						for (const target of targets) notes.push(`${target.id}: ${await store.interrupt(target.id)}`);
						return textResult(notes.join("\n"), details("interrupt", targets.map((t) => store.require(t.id))));
					}

					case "kill": {
						const targets = params.id === "all" ? store.runningAgents() : params.id ? [store.require(params.id)] : [];
						if (targets.length === 0) throw new Error('id is required for action="kill" (or use id:"all")');
						for (const target of targets) await store.kill(target.id);
						return textResult(`killed ${targets.map((t) => t.id).join(", ")}`, details("kill", targets));
					}

					case "clear": {
						const removed = store.clearFinished();
						return textResult(`removed ${removed} finished subagent record(s)`, details("clear", store.list()));
					}
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: message }],
					details: details(action, store?.list() ?? [], true),
					isError: true,
				};
			}

			throw new Error(`unknown action: ${action}`);
		},

		renderCall(args, theme) {
			const action = String(args.action ?? "?");
			const detail =
				action === "start"
					? oneLine(String(args.task ?? ""), 70)
					: action === "send"
						? `${args.id ?? "?"}: ${oneLine(String(args.message ?? ""), 60)}`
						: `${args.id ?? ""}`.trim();
			return new Text(`${theme.fg("muted", "subagent ")}${theme.fg("accent", action)}${detail ? theme.fg("dim", ` ${detail}`) : ""}`, 0, 0);
		},

		renderResult(result, options, theme) {
			const data = result.details as ToolDetails | undefined;
			const agents = data?.agents ?? [];
			if (agents.length === 0) return new Text(resultText(result) || "(no subagents)", 0, 0);

			if (options.expanded) {
				const container = new Container();
				for (const agent of agents) {
					const meta = statusMeta(agent.status as Subagent["status"]);
					container.addChild(
						new Text(
							`${theme.fg(meta.tone, `${meta.icon} ${meta.label}`)} ${theme.fg("accent", agent.name)} ` +
								theme.fg("dim", `${agent.id}${agent.pid ? ` pid ${agent.pid}` : ""}`),
							0,
							0,
						),
					);
					container.addChild(new Text(theme.fg("muted", `task: ${agent.task}`), 0, 0));
					if (agent.note) container.addChild(new Text(theme.fg("warning", `note: ${agent.note}`), 0, 0));
					container.addChild(new Text(theme.fg("dim", `── output ──`), 0, 0));
					container.addChild(new Markdown(agent.lastAssistantText.trim() || "(no output)", 0, 0, getMarkdownTheme()));
					if (agent.stderr) container.addChild(new Text(theme.fg("error", `stderr: ${agent.stderr}`), 0, 0));
					container.addChild(new Text(theme.fg("dim", `${formatUsage(agent.usage, agent.model)} · ${agent.transcriptPath}`), 0, 0));
				}
				return container;
			}

			const lines: string[] = [];
			for (const agent of agents) {
				const meta = statusMeta(agent.status as Subagent["status"]);
				const header =
					theme.fg(meta.tone, `${meta.icon} ${meta.label}`) +
					" " +
					theme.fg("accent", agent.name) +
					" " +
					theme.fg("dim", `${agent.id} ${formatUsage(agent.usage, agent.model)}`.trim());
				lines.push(header);
				for (const item of agent.items.slice(-COLLAPSED_ITEM_COUNT)) {
					const tone = item.kind === "error" ? "error" : item.kind === "text" ? "toolOutput" : "muted";
					lines.push(theme.fg(tone, `  ${oneLine(item.text, 110)}`));
				}
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.registerMessageRenderer<Snapshot>(SETTLED_MESSAGE_TYPE, (message, _options, theme) => {
		const agent = message.details;
		const status = agent?.status ?? "settled";
		const meta = statusMeta(status as Subagent["status"]);
		const tone = status === "failed" ? "error" : status === "aborted" ? "warning" : "success";
		const usage = agent ? formatUsage(agent.usage, agent.model) : "";
		return new Text(
			`${theme.fg(tone, `${meta.icon} subagent ${agent?.id ?? ""} ${meta.label}`)} ` +
				theme.fg("accent", agent?.name ?? "") +
				" " +
				theme.fg("dim", [usage, agent?.transcriptPath ? ellipsize(agent.transcriptPath, 40) : ""].filter(Boolean).join(" · ")),
			0,
			0,
		);
	});

	// ----------------------------------------------------------------------- view

	function openView(ctx: ExtensionContext, initialId?: string): void {
		rememberContext(ctx);
		if (ctx.mode !== "tui") {
			ctx.ui.notify(listOrEmpty(), "info");
			return;
		}

		const store = ensureRegistry(ctx);
		let manager: SubagentManager | undefined;
		let handle: OverlayHandle | undefined;
		let fullscreen = false;

		const normalOptions: OverlayOptions = {
			anchor: "top-right",
			width: 112,
			minWidth: 62,
			margin: { top: 1, left: 1, right: 1 },
		};
		const fullscreenOptions = (): OverlayOptions => ({
			anchor: "top-left",
			width: "100%",
			maxHeight: Math.max(1, (process.stdout.rows ?? 30) - FULLSCREEN_MARGINS.top - FULLSCREEN_MARGINS.bottom),
			margin: FULLSCREEN_MARGINS,
		});
		const resolveOptions = (): OverlayOptions => (fullscreen ? fullscreenOptions() : normalOptions);

		void ctx.ui
			.custom<string | undefined>((tui, theme, _keybindings, finish) => {
				const done = () => {
					// Detach the visible overlay immediately, then release ctx.ui.custom().
					handle?.hide();
					finish(undefined);
				};
				manager = new SubagentManager(tui, theme, done, {
					...(initialId ? { initialId } : {}),
					getAgents: () => store.list(),
					send: (id, text) => store.send(id, text, "auto"),
					interrupt: (id) => store.interrupt(id),
					kill: (id) => store.kill(id),
					remove: (id) => {
						const target = store.resolve(id);
						if (target) store.dropRecord(target.id);
					},
					showPaths: (agent) => {
						ctx.ui.notify(`${agent.id}\ntranscript: ${agent.transcriptPath}`, "info");
					},
					onFullscreenToggle: (next) => {
						fullscreen = next;
						// Pi bakes overlay options at creation, so re-present with fresh options.
						handle?.hide();
						handle = tui.showOverlay(manager!, resolveOptions());
					},
				});
				return manager;
			}, {
				overlay: true,
				overlayOptions: resolveOptions,
				onHandle: (created) => {
					handle = created;
				},
			})
			.catch((error: unknown) => ctx.ui.notify(`subagent view failed: ${String(error)}`, "error"));
	}

	function listOrEmpty(): string {
		const store = registry;
		return store ? formatListText(store.list()) : "no subagents in this session";
	}

	// -------------------------------------------------------------------- commands

	pi.registerCommand("subagents", {
		description: "List or open the live subagent view (usage: /subagents [id|ls])",
		handler: async (args, ctx) => {
			rememberContext(ctx);
			const arg = args.trim();
			if (arg === "ls" || (arg && !registry?.resolve(arg))) {
				ctx.ui.notify(listOrEmpty(), "info");
				return;
			}
			openView(ctx, arg || undefined);
		},
	});

	pi.registerCommand("subagent-send", {
		description: "Send a message to a running subagent: /subagent-send <id> <text>",
		handler: async (args, ctx) => {
			rememberContext(ctx);
			const match = /^(\S+)\s+([\s\S]+)$/.exec(args.trim());
			if (!match) {
				ctx.ui.notify("usage: /subagent-send <id> <message>", "warning");
				return;
			}
			try {
				const store = ensureRegistry(ctx);
				const disposition = await store.send(match[1]!, match[2]!, "auto");
				ctx.ui.notify(`sent (${disposition}) to ${match[1]}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("subagent-kill", {
		description: "Interrupt (default) or kill a subagent: /subagent-kill <id|all> [--force]",
		handler: async (args, ctx) => {
			rememberContext(ctx);
			const force = /--force\b/.test(args);
			const target = args.trim().replace(/--force\b/, "").trim();
			if (!target) {
				ctx.ui.notify("usage: /subagent-kill <id|all> [--force]", "warning");
				return;
			}
			const store = ensureRegistry(ctx);
			const targets = target === "all" ? store.runningAgents() : [store.require(target)];
			for (const item of targets) {
				const outcome = force ? await store.kill(item.id) : await store.interrupt(item.id);
				ctx.ui.notify(`${item.id}: ${outcome}`, "info");
			}
		},
	});

	pi.registerShortcut(Key.ctrlAlt("a"), {
		description: "Open the subagent view",
		handler: async (ctx) => openView(ctx),
	});

	// ------------------------------------------------------------------ lifecycle

	pi.on("session_start", async (_event, ctx) => {
		rememberContext(ctx);
		// Previous processes were reaped by session_shutdown; start from an empty registry.
		registry = undefined;
	});

	pi.on("session_shutdown", async () => {
		const store = registry;
		registry = undefined;
		if (store) await store.disposeAll();
	});
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.map((part) => (part.type === "text" ? (part.text ?? "") : ""))
		.join("\n")
		.trim();
}
