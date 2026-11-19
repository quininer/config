/**
 * TUI manager for subagents: a list of live subagent tasks plus a detail view,
 * modeled on pi-simple-background-tasks' `BackgroundTasksManager`.
 *
 * Two modes (`list`, `detail`), one 1s refresh tick, overlay-friendly rendering
 * (every line is truncated to the supplied width and re-colored, because Pi
 * resets styling per line).
 *
 * The detail view is where a record has to be readable in full, so it carries
 * four views instead of one: `t` the activity log (elapsed gutter per item,
 * assistant text previewed so one long answer cannot push the log off screen),
 * `i` an overview of the whole record (identity, child, model, sandbox, queue,
 * usage, transcript, problems), `p` the whole instruction, `o` the whole reply
 * plus stderr. A three-line header above them holds the state that matters at a
 * glance, and wrapped lines get a hanging indent.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { canResume, type ActivityItem, type Subagent } from "./registry.ts";
import {
	formatDuration,
	formatTime,
	formatTokens,
	formatUsage,
	isFinished,
	oneLine,
	shortenPath,
	statusMeta,
	type StatusTone,
} from "./utils.ts";

export interface ManagerTheme {
	fg: Theme["fg"];
}

export interface SubagentManagerOptions {
	initialId?: string;
	getAgents: () => Subagent[];
	send: (id: string, text: string) => Promise<string>;
	resume: (id: string, text?: string) => Promise<string>;
	interrupt: (id: string) => Promise<string>;
	kill: (id: string) => Promise<string>;
	remove: (id: string) => void;
	showPaths: (subagent: Subagent) => void;
	onFullscreenToggle?: (fullscreen: boolean) => void;
	onClose?: () => void;
}

export type SubagentManagerResult = "closed";

const REFRESH_INTERVAL_MS = 1_000;
const LIST_VISIBLE_ROWS = 14;
/** Elapsed-time gutter, e.g. `+4m02s`. */
const GUTTER_WIDTH = 7;
/** Assistant text shows at most this many lines in the activity log. */
const TEXT_PREVIEW_LINES = 3;
const TEXT_PREVIEW_CHARS = 700;
/** Lines of stderr shown before the tail is cut with a pointer to the transcript. */
const STDERR_PREVIEW_LINES = 12;
/** Border, subtitle, blank separator and the row under the body. */
const FRAME_CHROME = 4;
/** Width of the label column on the overview page. */
const INFO_LABEL_WIDTH = 10;

const VIEW_LABEL: Record<DetailView, string> = {
	tail: "activity",
	info: "overview",
	task: "instruction",
	reply: "reply",
};
/** What the detail body shows. */
type DetailView = "tail" | "info" | "task" | "reply";

const MAX_BOX_WIDTH = 118;
/** 1 line/column margins plus room for the editor + footer in regular mode. */
export const FULLSCREEN_MARGINS = { top: 1, left: 1, right: 1, bottom: 6 } as const;
const MIN_CONTENT_WIDTH = 90;
const MIN_CONTENT_HEIGHT = 30;

const BORDER = "\x1b[38;2;83;160;215m";
const BAND_BG = "\x1b[48;2;183;223;255m";
const BAND_FG = "\x1b[38;2;11;70;110m";
const RESET = "\x1b[0m";

/** One rendered body line. */
interface BodyLine {
	text: string;
	/** Wrapped continuation of the line above, so a cut window can mark it. */
	cont?: boolean;
}

/** Color token a detail line may use (theme tokens cover the status tones). */
type EntryTone = ThemeColor;

/** One logical entry of a detail view: a colored prefix plus content that wraps under it. */
interface Entry {
	/** Already colored; its visible width is the hanging indent. */
	prefix: string;
	tone: EntryTone;
	content: string;
}

function padAnsi(value: string, width: number): string {
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

function border(text: string): string {
	return `${BORDER}${text}${RESET}`;
}

function band(text: string): string {
	return `${BAND_BG}${BAND_FG}${text}${RESET}`;
}

/** Marker and color for one activity item, shared with the tool-result renderer. */
export function itemPrefix(kind: ActivityItem["kind"]): { marker: string; tone: StatusTone } {
	switch (kind) {
		case "system":
			return { marker: "·", tone: "muted" };
		case "turn":
			return { marker: "—", tone: "muted" };
		case "text":
			return { marker: "▎", tone: "accent" };
		case "tool":
			return { marker: "❯", tone: "accent" };
		case "result":
			return { marker: "↳", tone: "muted" };
		case "queue":
			return { marker: "⇄", tone: "muted" };
		case "ui":
			return { marker: "⚑", tone: "warning" };
		case "input":
			return { marker: "→", tone: "success" };
		case "error":
			return { marker: "✗", tone: "error" };
	}
}

/** `$1.23 96kctx 7t`: the part of the usage worth a list row's columns. */
function compactUsage(agent: Subagent): string {
	const bits: string[] = [];
	if (agent.turnCount > 0) bits.push(`${agent.turnCount}t`);
	if (agent.usage.cost > 0) bits.push(`$${agent.usage.cost < 1 ? agent.usage.cost.toFixed(3) : agent.usage.cost.toFixed(2)}`);
	if (agent.usage.contextTokens > 0) bits.push(`ctx:${formatTokens(agent.usage.contextTokens)}`);
	return bits.join(" ");
}

/** Short name for what the child is doing right now. */
function activityLabel(agent: Subagent): string {
	if (agent.pendingDialogs > 0) return `⚑${agent.pendingDialogs}`;
	if (agent.retrying) return "retrying";
	if (agent.streaming && agent.typing) return "typing";
	if (agent.streaming) return "working";
	return "";
}

export class SubagentManager implements Component, Focusable {
	private mode: "list" | "detail" = "list";
	private view: DetailView = "tail";
	private selectedIndex = 0;
	private listScroll = 0;
	private listVisibleRows = LIST_VISIBLE_ROWS;
	private detailId: string | undefined;
	private detailFollow = true;
	private detailScrollTop = 0;
	private detailOutputRows = 12;
	/** Wrap by default: the point of the detail view is reading whole lines. */
	private wrapOutput = true;
	private showHistory = false;
	private fullscreen = false;
	private composing = false;
	private input: Input | undefined;
	private actionMessage: string | undefined;
	private busy = false;
	private detailCache: { key: string; lines: BodyLine[] } | undefined;
	private timer: NodeJS.Timeout;

	/** Set by the TUI; forwarded to the embedded `Input` for IME cursor support. */
	focused = false;

	constructor(
		private readonly tui: Pick<TUI, "requestRender">,
		private readonly theme: ManagerTheme,
		private readonly done: (result: SubagentManagerResult) => void,
		private readonly options: SubagentManagerOptions,
	) {
		if (options.initialId) {
			this.detailId = options.initialId;
			this.mode = "detail";
		} else {
			const agents = options.getAgents();
			if (!agents.some((agent) => !isFinished(agent.status)) && agents.length > 0) this.showHistory = true;
		}
		this.timer = setInterval(() => this.tui.requestRender(), REFRESH_INTERVAL_MS);
		this.timer.unref?.();
	}

	dispose(): void {
		clearInterval(this.timer);
	}

	invalidate(): void {
		this.detailCache = undefined;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.fullscreen && !this.canFullscreen()) this.setFullscreen(false);
		const boxWidth = Math.max(2, this.fullscreen ? width : Math.min(width, MAX_BOX_WIDTH));
		return this.mode === "detail" ? this.renderDetail(boxWidth) : this.renderList(boxWidth);
	}

	handleInput(data: string): void {
		if (this.composing) {
			try {
				this.input?.handleInput(data);
			} finally {
				// Repaint on every keystroke: the composer line is rendered from here.
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, "escape") || data === "x" || data === "X" || data === "q" || data === "Q") {
			this.close();
			return;
		}

		this.actionMessage = undefined;

		if (data === "f" || data === "F") {
			this.setFullscreen(!this.fullscreen);
			return;
		}
		if (data === "h" || data === "H") {
			this.showHistory = !this.showHistory;
			this.selectedIndex = 0;
			this.listScroll = 0;
			this.tui.requestRender();
			return;
		}

		if (this.mode === "detail") {
			this.handleDetailInput(data);
			return;
		}
		this.handleListInput(data);
	}

	// ---------------------------------------------------------------------- list

	private handleListInput(data: string): void {
		const agents = this.visibleAgents();
		if (agents.length === 0) return;
		const selected = agents[this.selectedIndex];

		if (matchesKey(data, "up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		} else if (matchesKey(data, "down")) {
			this.selectedIndex = Math.min(agents.length - 1, this.selectedIndex + 1);
		} else if (matchesKey(data, "pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - this.listVisibleRows);
		} else if (matchesKey(data, "pageDown")) {
			this.selectedIndex = Math.min(agents.length - 1, this.selectedIndex + this.listVisibleRows);
		} else if (matchesKey(data, "return") || matchesKey(data, "right")) {
			if (selected) this.openDetail(selected.id);
			return;
		} else if (data === "k") {
			if (selected) void this.run(async () => (await this.options.interrupt(selected.id)) + ` · ${selected.id}`);
			return;
		} else if (data === "R") {
			if (selected) void this.run(async () => (await this.options.resume(selected.id)) + ` · ${selected.id}`);
			return;
		} else if (data === "d" || data === "D") {
			if (selected) {
				this.options.remove(selected.id);
				this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.visibleAgents().length - 1));
				this.actionMessage = `removed ${selected.id} from the list`;
			}
			return;
		} else if (data === "c" || data === "C") {
			if (selected) {
				this.options.showPaths(selected);
				this.actionMessage = `transcript path shown for ${selected.id}`;
			}
			return;
		} else {
			return;
		}

		this.ensureSelectionVisible();
		this.tui.requestRender();
	}

	private renderList(width: number): string[] {
		const agents = this.visibleAgents();
		if (this.selectedIndex >= agents.length) this.selectedIndex = Math.max(0, agents.length - 1);
		this.ensureSelectionVisible();

		const all = this.options.getAgents();
		const running = all.filter((agent) => !isFinished(agent.status)).length;
		const finished = all.length - running;
		const subtitle = this.showHistory
			? ` ${running} running · ${finished} history`
			: running > 0
				? ` ${running} running subagent${running === 1 ? "" : "s"}`
				: " no running subagents";

		const body: string[] = [];
		const help = this.listHelp(finished);
		const helpLines = wrapTextWithAnsi(this.theme.fg("dim", help), Math.max(1, width - 3)).length;
		let rows = this.computeListRows(helpLines, this.actionMessage);
		if (agents.length > rows) rows = this.computeListRows(helpLines + 1, this.actionMessage);
		this.listVisibleRows = rows;

		if (agents.length === 0) {
			body.push(
				this.theme.fg(
					"dim",
					all.length === 0
						? " No subagents yet. Ask the model to call the subagent tool, or press x to close."
						: this.showHistory
							? " No subagents in this view."
							: " No running subagents. Press h to show finished ones.",
				),
			);
		} else {
			const inner = Math.max(20, width - 2); // the frame spends two columns on its borders
			const visible = agents.slice(this.listScroll, this.listScroll + rows);
			for (let offset = 0; offset < visible.length; offset++) {
				const agent = agents[this.listScroll + offset]!;
				body.push(this.renderListRow(agent, this.listScroll + offset === this.selectedIndex, inner));
			}
		}

		const footer = this.actionMessage ? `${this.actionMessage}\n${help}` : help;
		return this.frame(band(padAnsi(subtitle, Math.max(1, width - 2))), body, footer, width);
	}

	/**
	 * One row: status, name, id, elapsed, what it is doing, cost. The name gets
	 * whatever columns are left, so nothing else is ever pushed off the line.
	 */
	private renderListRow(agent: Subagent, selected: boolean, width: number): string {
		const meta = statusMeta(agent.status);
		const elapsed = formatDuration((agent.endedAt ?? Date.now()) - agent.startedAt);
		const activity = activityLabel(agent);
		const mark = agent.streaming ? "▌" : " ";
		const status = this.theme.fg(meta.tone, padAnsi(`${meta.icon} ${meta.label}`, 11));
		const tail = [
			agent.readOnly ? this.theme.fg("muted", "ro") : "",
			this.theme.fg("dim", elapsed.padStart(6)),
			activity ? this.theme.fg(agent.pendingDialogs > 0 ? "warning" : "accent", activity) : "",
			canResume(agent) ? this.theme.fg("warning", "↻") : "",
			this.theme.fg("dim", compactUsage(agent)),
		]
			.filter(Boolean)
			.join(" ");
		const id = this.theme.fg("dim", agent.id);
		const indent = selected ? ">" : " ";
		// The name takes whatever the fixed columns leave, so nothing gets pushed off.
		const fixed = visibleWidth(`${indent}${status} ${mark} ${id} ${tail}`);
		const nameWidth = Math.max(8, width - fixed);
		const name = this.theme.fg(selected ? "accent" : "muted", padAnsi(fitOneLine(agent.name, nameWidth), nameWidth));
		const line = [indent + status, mark + name, id, tail].filter(Boolean).join(" ");
		return truncateToWidth(line, width, "…", true);
	}

	private listHelp(finished: number): string {
		const parts = ["↑/↓ move", "Enter logs", "k stop"];
		if (this.options.getAgents().some(canResume)) parts.push("R resume");
		if (finished > 0 || this.showHistory) parts.push("h all");
		parts.push("d drop", "c path", "f full", "x close");
		return parts.join(" · ");
	}

	// -------------------------------------------------------------------- detail

	private handleDetailInput(data: string): void {
		const agent = this.detailAgent();
		if (!agent) {
			if (matchesKey(data, "left") || matchesKey(data, "return")) this.backToList();
			return;
		}

		if (matchesKey(data, "left")) {
			this.backToList();
			return;
		}
		if (matchesKey(data, "up")) return this.scrollDetail(-1, agent);
		if (matchesKey(data, "down")) return this.scrollDetail(1, agent);
		if (matchesKey(data, "pageUp")) return this.scrollDetail(-this.detailOutputRows, agent);
		if (matchesKey(data, "pageDown")) return this.scrollDetail(this.detailOutputRows, agent);
		if (data === "t" || data === "T") return this.setView("tail");
		if (data === "i" || data === "I") return this.setView("info");
		if (data === "p" || data === "P") return this.setView("task");
		if (data === "o" || data === "O") return this.setView("reply");
		if (data === "Tab" || data === "\t") return this.cycleView();

		if (data === "R") {
			void this.run(async () => (await this.options.resume(agent.id)) + ` · ${agent.id}`);
			return;
		}
		if (data === "r") {
			this.detailFollow = true;
			this.detailScrollTop = 0;
			this.tui.requestRender();
			return;
		}
		if (data === "w" || data === "W") {
			this.wrapOutput = !this.wrapOutput;
			this.detailCache = undefined;
			this.tui.requestRender();
			return;
		}
		if (data === "m" || data === "M") {
			this.startComposing();
			return;
		}
		if (data === "k") {
			void this.run(async () => (await this.options.interrupt(agent.id)) + ` · ${agent.id}`);
			return;
		}
		if (data === "d" || data === "D") {
			this.options.remove(agent.id);
			this.actionMessage = `removed ${agent.id} from the list`;
			this.backToList();
			return;
		}
		if (data === "c" || data === "C") {
			this.options.showPaths(agent);
			this.actionMessage = "transcript path shown";
			this.tui.requestRender();
		}
	}

	private renderDetail(width: number): string[] {
		const agent = this.detailAgent();
		if (!agent) {
			return this.frame(
				band(padAnsi(" subagent gone", Math.max(1, width - 2))),
				[this.theme.fg("dim", " This subagent is no longer registered.")],
				this.detailHelp(),
				width,
			);
		}

		const inner = Math.max(1, width - 4);
		const header = this.detailHeader(agent, inner);

		const help = this.detailHelp();
		const helpHeight = wrapTextWithAnsi(this.theme.fg("dim", help), Math.max(1, width - 3)).length;
		const pausedHint = this.view === "tail" && !this.detailFollow;
		const reserved =
			header.length + 1 + helpHeight + (pausedHint ? 1 : 0) + (this.actionMessage ? 1 : 0) + (this.composing ? 1 : 0) + FRAME_CHROME;
		const available = Math.max(4, this.contentHeight() - reserved);
		this.detailOutputRows = available;

		const lines = this.detailLines(agent, inner);
		const maxTop = Math.max(0, lines.length - available);
		if (this.detailFollow) this.detailScrollTop = maxTop;
		else this.detailScrollTop = Math.min(this.detailScrollTop, maxTop);
		const top = this.detailScrollTop;

		const body: string[] = [...header, ""];
		const slice = lines.slice(top, top + available);
		for (let index = 0; index < slice.length; index++) {
			const line = slice[index]!;
			// Mark a line cut in the middle of a wrapped paragraph.
			body.push(line.cont && top > 0 && index === 0 ? `…${line.text.slice(1)}` : line.text);
		}
		if (slice.length === 0) body.push(this.theme.fg("dim", " (no output yet)"));

		if (pausedHint) {
			body.push(this.theme.fg("dim", ` ⏸ paused at line ${Math.min(top + 1, lines.length)}/${lines.length} · r follows`));
		}
		if (this.composing && this.input) {
			// Keep the embedded Input's cursor marker in sync (CJK IME needs the real cursor).
			this.input.focused = this.focused;
			body.push(this.input.render(Math.max(1, inner))[0] ?? "");
		}
		if (this.actionMessage) body.push(this.theme.fg("dim", ` ${this.actionMessage}`));

		return this.frame(band(padAnsi(` ${oneLine(agent.name, 30)} · ${VIEW_LABEL[this.view]}`, Math.max(1, width - 2))), body, help, width);
	}

	/**
	 * Three or four lines of state that must be visible in every view; the rest
	 * of the record lives on the overview page.
	 */
	private detailHeader(agent: Subagent, inner: number): string[] {
		const meta = statusMeta(agent.status);

		const state: string[] = [this.theme.fg(meta.tone, `${meta.icon} ${meta.label}`)];
		if (!isFinished(agent.status)) {
			state.push(this.theme.fg("accent", agent.typing ? "▌ typing" : agent.streaming ? "▌ working" : "idle"));
			if (agent.retrying) state.push(this.theme.fg("warning", "↻ retrying"));
			if (agent.pendingDialogs > 0) state.push(this.theme.fg("warning", `⚑ ${agent.pendingDialogs} dialog`));
			const queued = agent.queuedSteering + agent.queuedFollowUp;
			if (queued > 0) state.push(this.theme.fg("warning", `⇄ ${queued} queued`));
			const silent = Date.now() - agent.lastActivityAt;
			if (silent > 45_000) state.push(this.theme.fg("warning", `silent ${formatDuration(silent)}`));
		}
		if (canResume(agent)) state.push(this.theme.fg("warning", "↻ resumable (R)"));
		const identity = [
			agent.id,
			agent.pid ? `pid ${agent.pid}` : "",
			agent.proc && !agent.proc.alive ? "child gone" : "",
		]
			.filter(Boolean)
			.join(" ");
		state.push(this.theme.fg("dim", identity));
		state.push(this.theme.fg("dim", formatDuration((agent.endedAt ?? Date.now()) - agent.startedAt)));
		const lines = [` ${this.joinFits(state, inner)}`];

		if (this.view !== "task") {
			const room = inner - 16;
			lines.push(
				` ${this.theme.fg("muted", "task")} ${this.theme.fg("muted", fitOneLine(agent.task, room))}${
					wasTruncated(agent.task, room) ? this.theme.fg("dim", " (p)") : ""
				}`,
			);
		}

		const facts = [
			this.theme.fg("dim", formatUsage(agent.usage)),
			agent.model ? this.theme.fg("accent", `${agent.model}${agent.thinkingLevel ? ` (${agent.thinkingLevel})` : ""}`) : "",
			agent.outputChars > 0 ? this.theme.fg("dim", `${formatTokens(agent.outputChars)} out`) : "",
			agent.readOnly ? this.theme.fg("warning", `read-only ${agent.sandbox ?? "bwrap"}`) : "",
		].filter(Boolean);
		lines.push(` ${this.joinFits(facts, inner)}`);

		// An error is worth a line whenever there is one, not only once it is fatal.
		if (agent.lastError) {
			const tone: StatusTone = isFinished(agent.status) ? "error" : "warning";
			lines.push(` ${this.theme.fg(tone, `${agent.retrying ? "↻ retrying:" : "✗"} ${fitOneLine(agent.lastError, inner - 12)}`)}`);
		} else if (agent.note && isFinished(agent.status)) {
			lines.push(` ${this.theme.fg(meta.tone, `note ${fitOneLine(agent.note, inner - 12)}`)}`);
		}
		return lines;
	}

	/** Join colored parts with a separator, dropping the ones that no longer fit. */
	private joinFits(parts: string[], width: number): string {
		const separator = this.theme.fg("muted", " · ");
		const gap = visibleWidth(separator);
		let out = "";
		let used = 0;
		for (const part of parts) {
			const size = visibleWidth(part) + (out.length > 0 ? gap : 0);
			if (used + size > width) continue;
			out += (out.length > 0 ? separator : "") + part;
			used += size;
		}
		return out;
	}

	private detailHelp(): string {
		if (this.composing) return "Enter send · Esc cancel · C-u clear";
		const agent = this.detailAgent();
		const parts = ["↑/↓ scroll", "← back"];
		if (this.view === "tail") parts.push("i overview", "p task", "o reply");
		else parts.push("t log", "i overview", "p task", "o reply");
		parts.push(this.wrapOutput ? "w cut" : "w wrap");
		if (agent && canResume(agent)) parts.push("R resume");
		parts.push("m send", "k stop", "d drop");
		if (!this.fullscreen && this.canFullscreen()) parts.push("f full");
		parts.push("x close");
		return parts.join(" · ");
	}

	private detailLines(agent: Subagent, inner: number): BodyLine[] {
		const key = this.contentSignature(agent) + `:${inner}:${this.wrapOutput}`;
		if (this.detailCache?.key === key) return this.detailCache.lines;
		const lines =
			this.view === "info"
				? this.infoEntries(agent, inner)
				: this.view === "task"
					? this.taskEntries(agent, inner)
					: this.view === "reply"
						? this.replyEntries(agent, inner)
						: this.tailEntries(agent, inner);
		this.detailCache = { key, lines };
		return lines;
	}

	/** Cheap change detector for the rendered detail body. */
	private contentSignature(agent: Subagent): string {
		const last = agent.items[agent.items.length - 1];
		return [
			this.view,
			agent.items.length,
			last?.id ?? 0,
			last?.text.length ?? 0,
			agent.task.length,
			agent.lastAssistantText.length,
			agent.stderr.length,
			agent.status,
			agent.lastError ?? "",
			agent.note ?? "",
			agent.turnCount,
			agent.streaming ? 1 : 0,
			agent.pendingDialogs,
			agent.queuedSteering,
			agent.queuedFollowUp,
		].join(":");
	}

	// Rendering: entries become lines with a hanging indent, so a wrapped item
	// stays readable and a cut window can mark the line it cut.

	private renderEntries(entries: Entry[], inner: number): BodyLine[] {
		const out: BodyLine[] = [];
		for (const entry of entries) {
			const indent = Math.max(1, Math.round(visibleWidth(entry.prefix)));
			const contentWidth = Math.max(8, inner - indent);
			for (const raw of entry.content.split("\n")) {
				if (raw.length === 0) {
					out.push({ text: truncateToWidth(entry.prefix, inner) });
					continue;
				}
				const body = this.theme.fg(entry.tone, raw);
				if (!this.wrapOutput) {
					out.push({ text: truncateToWidth(entry.prefix + body, inner, "…", true) });
					continue;
				}
				const wrapped = wrapTextWithAnsi(body, contentWidth);
				if (wrapped.length === 0) {
					out.push({ text: truncateToWidth(entry.prefix, inner) });
					continue;
				}
				wrapped.forEach((part, index) => {
					out.push({
						text: (index === 0 ? entry.prefix : " ".repeat(indent)) + part,
						...(index === 0 ? {} : { cont: true }),
					});
				});
			}
		}
		return out;
	}

	/** The live activity log: every recorded item, newest at the bottom. */
	private tailEntries(agent: Subagent, inner: number): BodyLine[] {
		const entries: Entry[] = [];
		for (const item of agent.items) {
			const { marker, tone } = itemPrefix(item.kind);
			const elapsed = `+${formatDuration(Math.max(0, item.time - agent.startedAt))}`.padStart(GUTTER_WIDTH);
			const prefix = this.theme.fg("dim", `${elapsed} `) + this.theme.fg(tone, `${marker} `);
			// Assistant text is the one kind that can swallow the whole log.
			const previewed = item.kind === "text" ? previewText(item.text) : { text: item.text, hint: "" };
			entries.push({ prefix, tone, content: previewed.text });
			if (previewed.hint) entries.push({ prefix: " ".repeat(visibleWidth(prefix)), tone: "dim", content: previewed.hint });
		}
		return this.renderEntries(entries, inner);
	}

	/** Everything recorded about this subagent. */
	private infoEntries(agent: Subagent, inner: number): BodyLine[] {
		const entries: Entry[] = [];
		const meta = statusMeta(agent.status);
		const finished = isFinished(agent.status);
		const row = (name: string, value: string, tone: EntryTone = "muted") => {
			entries.push({ prefix: " " + this.theme.fg("dim", `${name.padEnd(INFO_LABEL_WIDTH)} `), tone, content: value });
		};
		const heading = (title: string) => {
			if (entries.length > 0) entries.push({ prefix: "", tone: "dim", content: "" });
			const rule = `── ${title} `;
			// The prefix costs a column, so the rule has to stop one short of the width.
			entries.push({ prefix: " ", tone: "muted", content: rule + "─".repeat(Math.max(0, inner - 1 - visibleWidth(rule))) });
		};

		heading("record");
		row(
			"status",
			[
				`${meta.icon} ${meta.label}`,
				`turn ${agent.turnCount}`,
				finished ? "" : agent.typing ? "▌ typing" : agent.streaming ? "▌ working" : "idle",
				agent.retrying ? "↻ retrying" : "",
				agent.pendingDialogs > 0 ? `⚑ ${agent.pendingDialogs} dialog unanswered` : "",
				agent.queuedSteering + agent.queuedFollowUp > 0
					? `⇄ ${agent.queuedSteering} steering, ${agent.queuedFollowUp} follow-up queued`
					: "",
				canResume(agent) ? "↻ resumable (R resumes it in place)" : "",
			]
				.filter(Boolean)
				.join(" · "),
			meta.tone,
		);
		row(
			"child",
			[
				agent.pid ? `pid ${agent.pid}` : "no pid",
				agent.pid ? (agent.proc && !agent.proc.alive ? "exited" : "alive") : "",
				`started ${formatTime(agent.startedAt)}`,
				finished && agent.endedAt ? `ended ${formatTime(agent.endedAt)}` : "",
				`ran ${formatDuration((agent.endedAt ?? Date.now()) - agent.startedAt)}`,
				finished ? "" : `active ${formatTime(agent.lastActivityAt)}`,
			]
				.filter(Boolean)
				.join(" · "),
		);
		row(
			"model",
			[agent.model ?? "child default", agent.thinkingLevel ? `thinking ${agent.thinkingLevel}` : ""].filter(Boolean).join(" · ") ||
				"not reported yet",
		);
		row("cwd", shortenPath(agent.cwd));
		row("transcript", shortenPath(agent.transcriptPath));
		if (agent.tools) row("tools", agent.tools);
		if (agent.readOnly) {
			row(
				"sandbox",
				`${agent.sandbox ?? "bwrap"}: workspace and config read-only, only the transcript writable, network on, no host devices`,
				"warning",
			);
		}

		heading("usage");
		row("tokens", formatUsage(agent.usage) || "nothing spent yet");
		row(
			"output",
			[
				`${formatTokens(agent.outputChars)} streamed`,
				`${agent.items.length} activity items logged`,
				agent.lastAssistantText ? `${agent.lastAssistantText.length} chars of reply (o)` : "no reply yet",
			].join(" · "),
		);

		heading("problems");
		if (agent.lastError) row("error", fitOneLine(agent.lastError, inner - INFO_LABEL_WIDTH - 4), isFinished(agent.status) ? "error" : "warning");
		if (agent.note) row("note", fitOneLine(agent.note, inner - INFO_LABEL_WIDTH - 4), meta.tone);
		const stderr = agent.stderr.trim();
		if (stderr) {
			const lines = stderr.split("\n");
			const kept = lines.slice(0, STDERR_PREVIEW_LINES);
			row("stderr", kept.join("\n" + " ".repeat(INFO_LABEL_WIDTH + 1)), "error");
			if (lines.length > kept.length) {
				row("", `… ${lines.length - kept.length} more lines - the transcript has everything`, "dim");
			}
		}
		if (!agent.lastError && !agent.note && !stderr) row("", "nothing recorded", "dim");

		heading("content");
		const valueWidth = Math.max(20, inner - INFO_LABEL_WIDTH - 4);
		row("task", `${agent.task.length} chars - p reads it all`);
		row("", fitOneLine(agent.task, valueWidth));
		const reply = agent.lastAssistantText.trim();
		row(
			"reply",
			reply
				? `${reply.length} chars - o reads it all`
				: finished
					? "none recorded"
					: "still streaming (t follows the log)",
		);
		if (reply) row("", fitOneLine(reply, valueWidth), "toolOutput");
		const lastTool = [...agent.items].reverse().find((item) => item.kind === "tool");
		if (lastTool) {
			row("last tool", `${fitOneLine(lastTool.text, valueWidth - 12)} · +${formatDuration(lastTool.time - agent.startedAt)}`);
		}
		return this.renderEntries(entries, inner);
	}

	/** The whole instruction, not the one-line summary in the header. */
	private taskEntries(agent: Subagent, inner: number): BodyLine[] {
		const entries: Entry[] = [];
		const meta = [
			`cwd ${shortenPath(agent.cwd)}`,
			agent.model ? `model ${agent.model}${agent.thinkingLevel ? ` thinking=${agent.thinkingLevel}` : ""}` : "",
			agent.readOnly
				? `read-only child: ${agent.sandbox ?? "bwrap"} sandbox - workspace and config read-only, only the transcript is writable, network on, no host devices; tools ${agent.tools ?? "read, grep, find, ls, bash"}`
				: "",
			`transcript ${shortenPath(agent.transcriptPath)}`,
			`${agent.task.length} chars as sent`,
		]
			.filter(Boolean)
			.join("\n");
		entries.push({ prefix: " ", tone: "dim", content: meta });
		entries.push({ prefix: "", tone: "dim", content: "" });
		entries.push({ prefix: " ", tone: "muted", content: "instruction" });
		entries.push({ prefix: " ", tone: "accent", content: agent.task.length > 0 ? agent.task : "(empty)" });
		if (agent.lastAssistantText.trim()) {
			entries.push({ prefix: "", tone: "dim", content: "" });
			entries.push({ prefix: " ", tone: "dim", content: "the reply lives on key o" });
		}
		return this.renderEntries(entries, inner);
	}

	/** The whole reply, plus whatever the child wrote to stderr. */
	private replyEntries(agent: Subagent, inner: number): BodyLine[] {
		const entries: Entry[] = [];
		const note = agent.status === "settled" ? undefined : agent.note;
		// The header already carries `lastError`; only a note adds something here.
		if (note && note !== agent.lastError) entries.push({ prefix: " ", tone: "error", content: note });

		const reply = agent.lastAssistantText.trim();
		if (reply) {
			entries.push({ prefix: "", tone: "dim", content: "" });
			entries.push({ prefix: " ", tone: "dim", content: `${reply.length} chars of reply` });
			entries.push({ prefix: " ", tone: "toolOutput", content: reply });
		} else {
			entries.push({
				prefix: " ",
				tone: "dim",
				content: agent.streaming ? "(reply still streaming - t shows the live log)" : "(no assistant reply recorded)",
			});
		}

		const stderr = agent.stderr.trim();
		if (stderr) {
			entries.push({ prefix: "", tone: "dim", content: "" });
			entries.push({ prefix: " ", tone: "error", content: "stderr" });
			const lines = stderr.split("\n");
			entries.push({ prefix: " ", tone: "error", content: lines.slice(0, STDERR_PREVIEW_LINES).join("\n") });
			if (lines.length > STDERR_PREVIEW_LINES) {
				entries.push({ prefix: " ", tone: "dim", content: `… ${lines.length - STDERR_PREVIEW_LINES} more lines` });
			}
		}
		if (canResume(agent)) {
			entries.push({ prefix: "", tone: "dim", content: "" });
			entries.push({ prefix: " ", tone: "warning", content: "↻ R resumes this task in place (m sends it an instruction too)" });
		}
		entries.push({ prefix: "", tone: "dim", content: "" });
		entries.push({ prefix: " ", tone: "dim", content: `full child output: ${shortenPath(agent.transcriptPath)}` });
		return this.renderEntries(entries, inner);
	}

	private scrollDetail(delta: number, agent: Subagent): void {
		const inner = Math.max(1, (this.fullscreen ? this.termWidth() : Math.min(this.termWidth(), MAX_BOX_WIDTH)) - 4);
		const total = this.detailLines(agent, inner).length;
		const maxTop = Math.max(0, total - this.detailOutputRows);
		if (maxTop === 0) return;
		if (this.detailFollow) {
			this.detailFollow = false;
			this.detailScrollTop = maxTop;
		}
		this.detailScrollTop = Math.min(maxTop, Math.max(0, this.detailScrollTop + delta));
		if (this.detailScrollTop >= maxTop) {
			this.detailFollow = true;
			this.detailScrollTop = 0;
		}
		this.tui.requestRender();
	}

	// ------------------------------------------------------------------ compose

	private startComposing(): void {
		this.composing = true;
		const target = this.detailAgent();
		const resumable = target ? canResume(target) : false;
		this.input = new Input({
			prompt: resumable ? "↻ " : "↳ ",
			placeholder: resumable
				? "resume this task in place (Enter continues it, empty Enter just says \"continue\")"
				: "message this subagent (Enter sends as steer/prompt)",
		});
		this.input.focused = this.focused;
		this.input.onSubmit = (value) => {
			const text = value.trim();
			this.stopComposing();
			const agent = this.detailAgent();
			// An empty message only makes sense as "continue": a running task needs real input.
			if (!agent || (text.length === 0 && !canResume(agent))) {
				this.tui.requestRender();
				return;
			}
			void this.run(async () => this.options.send(agent.id, text));
		};
		this.input.onEscape = () => {
			this.stopComposing();
			this.tui.requestRender();
		};
		this.tui.requestRender();
	}

	private stopComposing(): void {
		this.composing = false;
		this.input = undefined;
	}

	// ------------------------------------------------------------------ plumbing

	private async run(action: () => Promise<string>): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.actionMessage = "…";
		this.tui.requestRender();
		try {
			this.actionMessage = await action();
		} catch (error) {
			this.actionMessage = error instanceof Error ? error.message : String(error);
		} finally {
			this.busy = false;
			this.tui.requestRender();
		}
	}

	private visibleAgents(): Subagent[] {
		const all = this.options.getAgents();
		const running = all.filter((agent) => !isFinished(agent.status));
		if (this.showHistory) return all;
		if (running.length > 0) return running;
		return all;
	}

	private detailAgent(): Subagent | undefined {
		if (!this.detailId) return undefined;
		return this.options.getAgents().find((agent) => agent.id === this.detailId);
	}

	private openDetail(id: string): void {
		this.detailId = id;
		this.mode = "detail";
		this.view = "tail";
		this.detailFollow = true;
		this.detailScrollTop = 0;
		this.detailCache = undefined;
		this.tui.requestRender();
	}

	private setView(next: DetailView): void {
		if (this.view === next) return;
		this.view = next;
		// Only the activity tail follows the child; everything else starts at the
		// top so nothing above the fold gets lost.
		this.detailFollow = next === "tail";
		this.detailScrollTop = 0;
		this.detailCache = undefined;
		this.tui.requestRender();
	}

	private cycleView(): void {
		const order: DetailView[] = ["tail", "info", "task", "reply"];
		const next = order[(order.indexOf(this.view) + 1) % order.length]!;
		this.setView(next);
	}

	private backToList(): void {
		this.stopComposing();
		this.mode = "list";
		this.detailId = undefined;
		this.tui.requestRender();
	}

	private close(): void {
		this.options.onClose?.();
		this.done("closed");
	}

	private ensureSelectionVisible(): void {
		if (this.selectedIndex < this.listScroll) this.listScroll = this.selectedIndex;
		if (this.selectedIndex >= this.listScroll + this.listVisibleRows) {
			this.listScroll = this.selectedIndex - this.listVisibleRows + 1;
		}
	}

	private computeListRows(helpLines: number, hasAction: boolean | string | undefined): number {
		const chrome = 2 + 1 + helpLines + (hasAction ? 1 : 0) + 1;
		return Math.max(3, this.contentHeight() - chrome);
	}

	private termWidth(): number {
		return Math.max(40, process.stdout.columns ?? 80);
	}

	private contentHeight(): number {
		const rows = Math.max(12, process.stdout.rows ?? 30);
		return this.fullscreen
			? Math.max(8, rows - FULLSCREEN_MARGINS.top - FULLSCREEN_MARGINS.bottom)
			: Math.max(8, Math.floor(rows * 0.7));
	}

	private canFullscreen(): boolean {
		return (
			this.termWidth() - FULLSCREEN_MARGINS.left - FULLSCREEN_MARGINS.right >= MIN_CONTENT_WIDTH &&
			process.stdout.rows - FULLSCREEN_MARGINS.top - FULLSCREEN_MARGINS.bottom >= MIN_CONTENT_HEIGHT
		);
	}

	private setFullscreen(next: boolean): void {
		if (next === this.fullscreen) return;
		if (next && !this.canFullscreen()) {
			this.actionMessage = "terminal too small for fullscreen";
			return;
		}
		this.fullscreen = next;
		this.detailCache = undefined;
		this.options.onFullscreenToggle?.(next);
		this.tui.requestRender();
	}

	private frame(subtitle: string, body: string[], footer: string, width: number): string[] {
		const inner = Math.max(1, width - 2);
		const lines: string[] = [border(`╭${"─".repeat(inner)}╮`), border("│") + band(padAnsi(subtitle, inner)) + border("│")];
		const row = (content = "") => `${border("│")}${padAnsi(truncateToWidth(content, inner, "…", true), inner)}${border("│")}`;
		for (const line of body) lines.push(row(line));
		lines.push(row());
		for (const line of wrapTextWithAnsi(this.theme.fg("dim", footer), Math.max(1, inner - 1))) {
			lines.push(row(` ${line}`));
		}
		lines.push(border(`╰${"─".repeat(inner)}╯`));
		return lines;
	}
}

/** Would `oneLine(text, max)` actually cut something? */
function wasTruncated(text: string, max: number): boolean {
	return text.replace(/\s+/g, " ").trim().length > max;
}

/**
 * Collapse to one line and cut to a *visible* width, because CJK and emoji take
 * two columns and `oneLine` counts characters.
 */
function fitOneLine(text: string, width: number): string {
	return truncateToWidth(oneLine(text, 4_000), Math.max(4, width), "…");
}

/** Preview assistant text so one long answer cannot bury the activity log. */
function previewText(text: string): { text: string; hint: string } {
	const lines = text.split("\n");
	let kept = lines.slice(0, TEXT_PREVIEW_LINES).join("\n");
	if (kept.length > TEXT_PREVIEW_CHARS) kept = `${kept.slice(0, TEXT_PREVIEW_CHARS)}…`;
	const droppedLines = lines.length - TEXT_PREVIEW_LINES;
	if (droppedLines <= 0 && text.length <= TEXT_PREVIEW_CHARS) return { text, hint: "" };
	const collapsed = text.replace(/\s+/g, " ").length;
	return { text: kept, hint: `… ${droppedLines > 0 ? `${droppedLines} more lines, ` : ""}${collapsed} chars total - o reads the reply` };
}
