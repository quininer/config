/**
 * TUI manager for subagents: a list of live subagent tasks plus a detail view
 * that tails their activity, modeled on pi-simple-background-tasks'
 * `BackgroundTasksManager`.
 *
 * Two modes (`list`, `detail`), one 1s refresh tick, overlay-friendly rendering
 * (every line is truncated to the supplied width and re-colored, because Pi
 * resets styling per line). The detail view tails the activity log (`t`), shows
 * the full instruction (`p`) or the full reply (`o`), and can message (`m`) or
 * resume (`R`) the task without leaving the overlay.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
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
import { formatDuration, formatUsage, isFinished, isResumable, oneLine, statusMeta } from "./utils.ts";

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
const DETAIL_ITEM_WINDOW = 150;
const VIEW_LABEL: Record<"tail" | "task" | "reply", string> = {
	tail: "activity",
	task: "instruction",
	reply: "reply",
};
/** What the detail body shows. */
type DetailView = "tail" | "task" | "reply";
const MAX_BOX_WIDTH = 118;
/** 1 line/column margins plus room for the editor + footer in regular mode. */
export const FULLSCREEN_MARGINS = { top: 1, left: 1, right: 1, bottom: 6 } as const;
const MIN_CONTENT_WIDTH = 90;
const MIN_CONTENT_HEIGHT = 30;

const BORDER = "\x1b[38;2;83;160;215m";
const BAND_BG = "\x1b[48;2;183;223;255m";
const BAND_FG = "\x1b[38;2;11;70;110m";
const RESET = "\x1b[0m";

function padAnsi(value: string, width: number): string {
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

function border(text: string): string {
	return `${BORDER}${text}${RESET}`;
}

function band(text: string): string {
	return `${BAND_BG}${BAND_FG}${text}${RESET}`;
}

function itemPrefix(kind: ActivityItem["kind"]): { marker: string; tone: "accent" | "success" | "warning" | "error" | "muted" } {
	switch (kind) {
		case "system":
			return { marker: "·", tone: "muted" };
		case "turn":
			return { marker: "—", tone: "muted" };
		case "text":
			return { marker: " ", tone: "accent" };
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
	private detailCache: { key: string; lines: string[] } | undefined;
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

		if (matchesKey(data, "up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		} else if (matchesKey(data, "down")) {
			this.selectedIndex = Math.min(agents.length - 1, this.selectedIndex + 1);
		} else if (matchesKey(data, "pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - this.listVisibleRows);
		} else if (matchesKey(data, "pageDown")) {
			this.selectedIndex = Math.min(agents.length - 1, this.selectedIndex + this.listVisibleRows);
		} else if (matchesKey(data, "return") || matchesKey(data, "right")) {
			const selected = agents[this.selectedIndex];
			if (selected) this.openDetail(selected.id);
			return;
		} else if (data === "k") {
			const selected = agents[this.selectedIndex];
			if (selected) void this.run(async () => (await this.options.interrupt(selected.id)) + ` · ${selected.id}`);
			return;
		} else if (data === "R") {
			const selected = agents[this.selectedIndex];
			if (selected) void this.run(async () => (await this.options.resume(selected.id)) + ` · ${selected.id}`);
			return;
		} else if (data === "d" || data === "D") {
			const selected = agents[this.selectedIndex];
			if (selected) {
				this.options.remove(selected.id);
				this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.visibleAgents().length - 1));
				this.actionMessage = `removed ${selected.id} from the list`;
			}
			return;
		} else if (data === "c" || data === "C") {
			const selected = agents[this.selectedIndex];
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
			const nameWidth = Math.max(12, width - 74);
			const visible = agents.slice(this.listScroll, this.listScroll + rows);
			for (let offset = 0; offset < visible.length; offset++) {
				const agent = visible[offset];
				const index = this.listScroll + offset;
				body.push(this.renderListRow(agent, index === this.selectedIndex, nameWidth, width));
			}
		}

		const footer = this.actionMessage ? `${this.actionMessage}\n${help}` : help;
		return this.frame(band(padAnsi(subtitle, Math.max(1, width - 2))), body, footer, width);
	}

	private renderListRow(agent: Subagent, selected: boolean, nameWidth: number, width: number): string {
		const meta = statusMeta(agent.status);
		const elapsed = formatDuration((agent.endedAt ?? Date.now()) - agent.startedAt);
		const usage = formatUsage(agent.usage, agent.model);
		const activity = this.activityLabel(agent);
		const mark = agent.streaming ? "▌" : " ";
		const name = padAnsi(oneLine(agent.name, nameWidth), nameWidth);
		const status = this.theme.fg(meta.tone, `${meta.icon} ${meta.label}`.padEnd(10));
		const tail = [
			status,
			`${mark}${this.theme.fg(selected ? "accent" : "muted", name)}`,
			this.theme.fg("dim", agent.id),
			agent.readOnly ? this.theme.fg("muted", "ro") : "",
			this.theme.fg("dim", elapsed.padStart(6)),
			activity ? this.theme.fg("warning", activity) : "",
			canResume(agent) ? this.theme.fg("warning", "↻ R") : "",
			usage ? this.theme.fg("dim", usage) : "",
		]
			.filter(Boolean)
			.join(" ");
		const line = selected ? `>${padAnsi(tail, Math.max(1, width - 4))}` : ` ${padAnsi(tail, Math.max(1, width - 2))}`;
		return truncateToWidth(line, width, "…", true);
	}

	private activityLabel(agent: Subagent): string {
		if (agent.pendingDialogs > 0) return `⚑ ${agent.pendingDialogs} dialog`;
		if (agent.retrying) return "retrying…";
		if (agent.streaming && agent.typing) return "typing…";
		if (agent.streaming) return "working…";
		return "";
	}

	private listHelp(finished: number): string {
		const parts = ["↑/↓ select", "Enter logs", "k interrupt"];
		if (this.options.getAgents().some(canResume)) parts.push("R resume");
		if (finished > 0 || this.showHistory) parts.push("h history");
		parts.push("d remove", "c paths", "f fullscreen", "x close");
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
		if (matchesKey(data, "up")) {
			this.scrollDetail(-1, agent);
			return;
		}
		if (matchesKey(data, "down")) {
			this.scrollDetail(1, agent);
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.scrollDetail(-this.detailOutputRows, agent);
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.scrollDetail(this.detailOutputRows, agent);
			return;
		}
		if (data === "t" || data === "T") {
			this.setView("tail");
			return;
		}
		if (data === "p" || data === "P") {
			this.setView("task");
			return;
		}
		if (data === "o" || data === "O") {
			this.setView("reply");
			return;
		}
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
			this.detailFollow = true;
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

		const meta = statusMeta(agent.status);
		const inner = Math.max(1, width - 4);
		const header: string[] = [];
		header.push(
			` ${this.theme.fg(meta.tone, `${meta.icon} ${meta.label}`)} ${this.theme.fg("accent", oneLine(agent.name, 40))} ` +
				this.theme.fg("dim", `${agent.id}${agent.pid ? ` pid ${agent.pid}` : ""}`),
		);
		if (this.view !== "task") {
			header.push(
				` ${this.theme.fg("muted", `task: ${oneLine(agent.task, inner - 8)}`)}${
					agent.note ? this.theme.fg("warning", ` (${oneLine(agent.note, 60)})`) : ""
				}`,
			);
		}
		const usageLine = ` ${this.theme.fg(
			"dim",
			[
				formatUsage(agent.usage, agent.model),
				`${formatDuration((agent.endedAt ?? Date.now()) - agent.startedAt)}`,
				`turns ${agent.turnCount}`,
				agent.readOnly ? `read-only ${agent.tools ?? ""}`.trim() : "",
				agent.streaming ? "streaming" : "",
				agent.retrying ? "retrying" : "",
				agent.pendingDialogs > 0 ? `⚠ ${agent.pendingDialogs} unanswered dialog` : "",
				canResume(agent) ? "↻ resumable (R)" : "",
			]
				.filter(Boolean)
				.join(" · "),
		)}`;
		header.push(usageLine);
		if (agent.lastError && isResumable(agent.status)) {
			header.push(` ${this.theme.fg("error", `error: ${oneLine(agent.lastError, inner - 8)}`)}`);
		}

		const body: string[] = [...header, ""];

		const help = this.detailHelp();
		const helpHeight = wrapTextWithAnsi(this.theme.fg("dim", help), Math.max(1, width - 3)).length;
		const reserved = header.length + 1 + helpHeight + (this.actionMessage ? 1 : 0) + (this.composing ? 1 : 0) + 4;
		const available = Math.max(4, this.contentHeight() - reserved);
		this.detailOutputRows = available;

		const lines = this.detailLines(agent, inner);
		const maxTop = Math.max(0, lines.length - available);
		if (this.detailFollow) this.detailScrollTop = maxTop;
		else this.detailScrollTop = Math.min(this.detailScrollTop, maxTop);
		const slice = lines.slice(this.detailScrollTop, this.detailScrollTop + available);
		body.push(...(slice.length > 0 ? slice : [this.theme.fg("dim", " (no output yet)")]));

		if (this.composing && this.input) {
			// Keep the embedded Input's cursor marker in sync (CJK IME needs the real cursor).
			this.input.focused = this.focused;
			const promptWidth = Math.max(1, inner);
			body.push(this.input.render(promptWidth)[0] ?? "");
		}
		if (this.actionMessage) body.push(this.theme.fg("dim", ` ${this.actionMessage}`));

		return this.frame(
			band(padAnsi(` ${oneLine(agent.name, 30)} · ${VIEW_LABEL[this.view]}`, Math.max(1, width - 2))),
			body,
			help,
			width,
		);
	}

	private detailHelp(): string {
		if (this.composing) return "Enter send · Esc cancel · C-u clear";
		const agent = this.detailAgent();
		const wrap = this.wrapOutput ? "w truncate" : "w wrap";
		const parts = ["↑/↓ scroll", "← list", "t activity", "p instruction", "o reply", wrap];
		if (agent && canResume(agent)) parts.push("R resume");
		parts.push("m message", "k interrupt", "c paths", "f fullscreen", "d remove", "x close");
		return parts.join(" · ");
	}

	private detailLines(agent: Subagent, inner: number): string[] {
		const key = `${this.contentSignature(agent)}:${inner}:${this.wrapOutput}`;
		if (this.detailCache?.key === key) return this.detailCache.lines;
		const lines =
			this.view === "task"
				? this.taskLines(agent, inner)
				: this.view === "reply"
					? this.replyLines(agent, inner)
					: this.tailLines(agent, inner);
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
				agent.task.length,
				agent.lastAssistantText.length,
				agent.stderr.length,
				agent.status,
				agent.lastError ?? "",
			].join(":");
		}

	/** Wrap or truncate already-colored lines to the detail width. */
	private fit(lines: string[], inner: number): string[] {
		const out: string[] = [];
		for (const line of lines) {
			if (this.wrapOutput) {
				const wrapped = wrapTextWithAnsi(line, inner);
				if (wrapped.length === 0) out.push("");
				for (const next of wrapped) out.push(next);
			} else {
				out.push(truncateToWidth(line, inner, "…", true));
			}
		}
		return out;
	}

	/** Live activity tail. */
	private tailLines(agent: Subagent, inner: number): string[] {
		const lines: string[] = [];
		for (const item of agent.items.slice(-DETAIL_ITEM_WINDOW)) {
			const { marker, tone } = itemPrefix(item.kind);
			const body = item.text.split("\n");
			body.forEach((raw, index) => {
				const label = index === 0 ? marker : " ".repeat(marker.length);
				lines.push(this.theme.fg(tone, `${label} ${raw}`));
			});
		}
		return this.fit(lines, inner);
	}

	/** The whole instruction, not the one-line summary in the header. */
	private taskLines(agent: Subagent, inner: number): string[] {
		const lines: string[] = [];
		for (const meta of [
			`cwd ${agent.cwd}`,
			agent.model ? `model ${agent.model}${agent.thinkingLevel ? ` thinking=${agent.thinkingLevel}` : ""}` : "",
			agent.readOnly
				? `read-only child: ${agent.sandbox ?? "bwrap"} sandbox - workspace and config read-only, only the transcript is writable, network on, no host devices; tools ${agent.tools ?? "read, grep, find, ls, bash"}`
				: "",
			`transcript ${agent.transcriptPath}`,
		]
			.filter(Boolean)
			.map((line) => this.theme.fg("dim", line))) {
			lines.push(meta);
		}
		lines.push("", this.theme.fg("muted", "instruction, as sent"), "");
		for (const raw of agent.task.split("\n")) lines.push(this.theme.fg("accent", raw.length > 0 ? raw : " "));
		if (agent.lastAssistantText.trim()) lines.push("", this.theme.fg("dim", "…the reply lives on key o"));
		return this.fit(lines, inner);
	}

	/** The whole reply, plus whatever stopped the task. */
	private replyLines(agent: Subagent, inner: number): string[] {
		const lines: string[] = [];
		const failure = agent.lastError ?? (agent.status === "settled" ? undefined : agent.note);
		if (failure) lines.push(this.theme.fg("error", `error: ${failure}`), "");

		const reply = agent.lastAssistantText.trim();
		if (reply) {
			for (const raw of reply.split("\n")) lines.push(this.theme.fg("toolOutput", raw.length > 0 ? raw : " "));
		} else {
			lines.push(
				this.theme.fg("dim", agent.streaming ? "(reply still streaming - t shows the live activity)" : "(no assistant reply yet)"),
			);
		}

		const stderr = agent.stderr.trim();
		if (stderr) {
			lines.push("", this.theme.fg("error", "stderr:"));
			for (const raw of stderr.split("\n")) lines.push(this.theme.fg("error", raw));
		}
		if (canResume(agent)) {
			lines.push("", this.theme.fg("warning", `↻ R resumes this task in place (m sends it an instruction too)`));
		}
		return this.fit(lines, inner);
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
		const resumable = this.detailAgent() ? canResume(this.detailAgent()!) : false;
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
		// Only the activity tail follows the child; the instruction and reply views
		// start at the top, so nothing above the fold gets lost.
		this.detailFollow = next === "tail";
		this.detailScrollTop = 0;
		this.detailCache = undefined;
		this.tui.requestRender();
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
			process.stdout.columns - FULLSCREEN_MARGINS.left - FULLSCREEN_MARGINS.right >= MIN_CONTENT_WIDTH &&
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
