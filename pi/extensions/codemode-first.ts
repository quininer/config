/**
 * codemode-first — a `bash` call should be one command, not a shell program.
 *
 * Why: a chain of commands, a `$(…)`, a multi-line script or a heredoc is a program
 * squeezed into a string. The quoting is fragile, the output of a step in the middle
 * cannot be inspected, and a failure mid-chain says nothing about which step failed.
 * codemode does that better — one plain command per `tools.bash` call, JavaScript for
 * branching, loops, filtering and joining — so this guard removes the composed form
 * instead of discouraging it. A block costs one retry and the retry is the lesson; a
 * warning is skimmed.
 *
 * Blocks: `$(…)`, backticks, `<(…)`, any pipe, `;`, `&&`, `||`, several lines, `<<EOF`,
 * `( … )`, `{ …; }`, background `&`, `for`/`while`/`if`/`case`/`eval`, and `sh -c '…'`
 * around any of it. Allows: one command with its arguments, quoting and redirection —
 * `rg foo src`, `make build > target/log`, `awk '{print $1}' f`. Even a single pipe
 * composes commands, so `rg foo src | head` is codemode's job: filtering output is
 * `output.split("\n").filter(…)`, not a pipeline. The scan is quote-aware, so
 * `awk '{print $1}'` and `rg 'a|b'` are not findings; `$((…))` is arithmetic; a trailing
 * `;`, a trailing newline and `# comments` are formatting.
 *
 * Checked everywhere, including inside codemode: `tools.bash` called from a codemode
 * script (`parentToolCallId`) is still a `bash` call, and models compose shell there
 * just as happily. A blocked call rejects, which throws and aborts the whole script, so
 * every `tools.bash` call has to be one plain command from the start. codemode composes
 * *results* in JavaScript; a shell program behind one `tools.bash` call is the same
 * mistake one layer down, and gets a reason saying so rather than being told to go find
 * codemode. The guard stays inert only while codemode is not an active tool, since a
 * read-only subagent given `read,grep,find,ls,bash` has nowhere to put the work.
 *
 * Blind spots: hidden indirection (`C='a && b'; sh -c "$C"`) and an unrelated program's
 * option that runs a shell itself. The scan is lexical on purpose — a real parser would
 * false-positive on half of the harmless commands in a session.
 *
 * The model is told the rule, never the construct it hit — naming `&&` hands it
 * something to route around — while findings go to the TUI notification, where a human
 * can check that the rule fired. `before_agent_start` states the rule up front, so it
 * is rarely tripped. Off for the session with `/codemode-first off`, for the process
 * with `PI_CODEMODE_FIRST=off`; nothing else is configurable, on purpose.
 *
 * Load with `-e pi/extensions/codemode-first.ts` or a symlink in
 * ~/.pi/agent/extensions. Two sections below: the analysis, then the wiring.
 */

import {
	type ExtensionAPI,
	type ExtensionContext,
	type RegisteredCommand,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------- analysis

/*
 * Quote awareness is the whole trick: `awk '{print $1}'` and `rg 'a|b'` are one command
 * whose arguments merely look like shell syntax, so nothing inside single quotes is
 * read. Inside double quotes `$(` and backticks stay active — `echo "$(date)"` really
 * does run a command.
 */

type FindingKind =
	| "command-substitution"
	| "process-substitution"
	| "heredoc"
	| "multi-command"
	| "pipeline"
	| "background"
	| "subshell"
	| "group"
	| "control-flow"
	| "eval"
	| "nested-shell";

interface Finding {
	kind: FindingKind;
	/** What was seen, e.g. "`&&` and newlines join 3 commands". */
	detail: string;
}

interface AnalysisOptions {
	/** Recursion depth for nested shells; internal. */
	depth?: number;
}

interface Analysis {
	findings: Finding[];
	/** Commands the text holds, counting `;`/`&&`/`||`/`|`/newline splits. */
	commandCount: number;
	/** `|` and `|&` occurrences. */
	pipelineCount: number;
	/** True when the guard should react. */
	complex: boolean;
}

/** Words that are only meaningful as shell syntax at the start of a command. */
const RESERVED = new Set([
	"for",
	"while",
	"until",
	"if",
	"case",
	"select",
	"function",
	"coproc",
	"do",
	"then",
	"else",
	"elif",
	"fi",
	"done",
	"esac",
	"eval",
]);

/** Words that may sit before a command without becoming the command itself. */
const PREFIXES = new Set([
	"sudo",
	"doas",
	"env",
	"command",
	"time",
	"nohup",
	"nice",
	"ionice",
	"stdbuf",
	"timeout",
	"watch",
	"!",
]);

/** Programs that run their `-c` argument as a shell program. */
const SHELL_RUNNERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh"]);
const SHELL_C_RE = new RegExp(
	`(?:^|[\\s;|&(])(${[...SHELL_RUNNERS].join("|")})[ \\t]+(?:-[A-Za-z]*c|--command)[ \\t]`,
	"g",
);

const MAX_NESTED_DEPTH = 2;
const DETAIL_LIMIT = 4;

/** Analyze one `command` string. Pure: no fs, no env, no I/O. */
function analyzeShell(input: string, options: AnalysisOptions = {}): Analysis {
	const depth = options.depth ?? 0;

	// Trailing whitespace and line continuations are formatting, not structure.
	const text = input.replace(/\\[ \t]*\r?\n/g, " ").replace(/\s+$/, "");

	const findings: Finding[] = [];
	const seen = new Map<FindingKind, string>();
	const add = (kind: FindingKind, detail: string) => {
		if (!seen.has(kind)) findings.push({ kind, detail });
		seen.set(kind, detail);
	};

	let quote: "none" | "single" | "double" = "none";
	let atCommandPos = true;
	let word = "";
	let prevMeaningful = "";
	let hardSeparators = 0;
	let newlines = 0;
	let pipelines = 0;
	let listOps = 0; // `;`, `&&`, `||`

	const endWord = () => {
		if (word.length > 0) {
			if (atCommandPos) {
				// `FOO=1 cmd` keeps command position; `cmd` claims it.
				const isAssignment = /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
				if (!isAssignment) {
					if (RESERVED.has(word)) {
						if (word === "eval") add("eval", "`eval` runs a built string as shell code");
						else add("control-flow", `\`${word}\` loop or conditional`);
					}
					atCommandPos = PREFIXES.has(word);
				}
			}
			word = "";
		}
	};

	for (let i = 0; i < text.length; i++) {
		const c = text[i];

		if (quote === "single") {
			if (c === "'") quote = "none";
			else word += c;
			continue;
		}

		if (c === "\\") {
			// An escaped character is literal either way; consume the next one.
			i++;
			word += text[i] ?? "";
			prevMeaningful = text[i] ?? "";
			continue;
		}

		if (quote === "none") {
			if (c === "'") {
				quote = "single";
				continue;
			}
			if (c === '"') {
				quote = "double";
				continue;
			}
			// A `#` only starts a comment where a command could begin.
			if (c === "#" && (atCommandPos || /[\s]/.test(prevMeaningful))) {
				const nl = text.indexOf("\n", i);
				i = nl === -1 ? text.length : nl - 1;
				prevMeaningful = " ";
				continue;
			}
		} else if (c === '"') {
			quote = "none";
			continue;
		}

		// --- expansions (active inside double quotes as well) -------------------
		if (c === "$" && text[i + 1] === "(") {
			if (text[i + 2] === "(") {
				// Arithmetic: `$(( … ))` unless a substitution hides inside it.
				const end = matchParen(text, i + 2);
				const inner = text.slice(i + 2, end);
				if (/\$\(|`/.test(inner)) add("command-substitution", "`$(…)` command substitution");
				i = end - 1;
				prevMeaningful = ")";
				continue;
			}
			add("command-substitution", "`$(…)` command substitution");
			i = matchParen(text, i + 1) - 1;
			prevMeaningful = ")";
			continue;
		}
		if (c === "`") {
			add("command-substitution", "backtick command substitution");
			const end = text.indexOf("`", i + 1);
			i = end === -1 ? text.length : end;
			prevMeaningful = "`";
			continue;
		}
		if (quote === "none" && (c === "<" || c === ">") && text[i + 1] === "(") {
			add("process-substitution", "`" + c + "(…) process substitution");
			i = matchParen(text, i + 1) - 1;
			prevMeaningful = ")";
			continue;
		}
		if (quote === "none" && c === "<" && text[i + 1] === "<") {
			if (text[i + 2] === "<") {
				i += 2; // `<<<` here-string: one command, one word.
				continue;
			}
			add("heredoc", "`<<` heredoc feeds a script on stdin");
			i += text[i + 2] === "-" ? 2 : 1;
			prevMeaningful = "<";
			continue;
		}

		if (quote !== "none") {
			word += c;
			prevMeaningful = c;
			continue;
		}

		// --- operators (unquoted only) -------------------------------------------
		if (c === ";" || c === "\n") {
			endWord();
			if (c === "\n") newlines++;
			if (!isTrailing(text, i + 1)) {
				hardSeparators++;
				if (c === ";") listOps++;
			}
			atCommandPos = true;
			prevMeaningful = c;
			continue;
		}
		if (c === "&") {
			if (text[i + 1] === "&") {
				endWord();
				if (!isTrailing(text, i + 2)) {
					hardSeparators++;
					listOps++;
				}
				i++;
				atCommandPos = true;
				prevMeaningful = "&";
				continue;
			}
			if (text[i + 1] === ">") {
				i++; // `&>` redirect
				prevMeaningful = ">";
				continue;
			}
			if (/[0-9>]/.test(prevMeaningful)) {
				prevMeaningful = "&"; // `2>&1`
				continue;
			}
			endWord();
			add("background", "`&` runs the command in the background");
			atCommandPos = true;
			prevMeaningful = "&";
			continue;
		}
		if (c === "|") {
			endWord();
			if (text[i + 1] === "|") {
				if (!isTrailing(text, i + 2)) {
					hardSeparators++;
					listOps++;
				}
				i++;
				atCommandPos = true;
			} else {
				pipelines++;
				if (text[i + 1] === "&") i++;
				atCommandPos = true;
			}
			prevMeaningful = c;
			continue;
		}
		if (c === "(") {
			endWord();
			if (atCommandPos) add("subshell", "`( … )` subshell grouping");
			atCommandPos = true;
			prevMeaningful = "(";
			continue;
		}
		if (c === ")") {
			endWord();
			atCommandPos = false;
			prevMeaningful = ")";
			continue;
		}
		if (c === "{" && (text[i + 1] === " " || text[i + 1] === "\n")) {
			endWord();
			if (atCommandPos) add("group", "`{ …; }` command group");
			prevMeaningful = "{";
			continue;
		}
		if (c === "}" || c === "[" || c === "]" || c === ",") {
			endWord();
			prevMeaningful = c;
			continue;
		}
		if (c === ">" || c === "<") {
			endWord();
			if (text[i + 1] === "&" || text[i + 1] === ">" || text[i + 1] === "|" || text[i + 1] === "-") i++;
			prevMeaningful = c;
			continue;
		}
		if (/\s/.test(c)) {
			endWord();
			prevMeaningful = " ";
			continue;
		}

		word += c;
		prevMeaningful = c;
	}
	endWord();

	// Nested shells: `sh -c '…'` is a program that would otherwise read as one word.
	if (depth < MAX_NESTED_DEPTH) {
		for (const nested of nestedShellArgs(text)) {
			const inner = analyzeShell(nested.code, { ...options, depth: depth + 1 });
			if (inner.complex) {
				const what = inner.findings.map((f) => f.detail).slice(0, DETAIL_LIMIT).join(", ");
				add("nested-shell", `\`${nested.shell} -c\` runs a program using ${what}`);
			}
		}
	}

	const commandCount = hardSeparators + 1;
	if (listOps > 0 || newlines > 0) {
		const how = [listOps > 0 ? "`;`/`&&`/`||`" : "", newlines > 0 ? "newlines" : ""].filter(Boolean).join(" and ");
		add("multi-command", `${how} join ${commandCount} commands`);
	}
	// Pipes are decided last because the wording depends on how many there were: one
	// pipe reads as a habit, four read as a program.
	if (pipelines > 0) {
		add(
			"pipeline",
			pipelines > 1 ? `${pipelines} pipes chain ${pipelines + 1} commands` : "pipe into the next command",
		);
	}
	return {
		findings,
		commandCount,
		pipelineCount: pipelines,
		complex: findings.length > 0,
	};
}

/** One-line description of the findings, for tool errors and notifications. */
function describeFindings(findings: Finding[]): string {
	const parts = findings.map((f) => f.detail);
	if (parts.length <= DETAIL_LIMIT) return parts.join("; ");
	return `${parts.slice(0, DETAIL_LIMIT).join("; ")}; +${parts.length - DETAIL_LIMIT} more`;
}

/** True when only whitespace (or a closing `)`) follows, so a separator is trailing. */
function isTrailing(text: string, from: number): boolean {
	for (let i = from; i < text.length; i++) {
		const c = text[i];
		if (/\s/.test(c)) continue;
		// A comment makes the rest of the line irrelevant; `)` and `;` close something.
		if (c === "#") return true;
		if (c === ")" || c === ";") continue;
		return false;
	}
	return true;
}

/** Index just past the `)` closing the `(` at `open`. Best effort past EOF. */
function matchParen(text: string, open: number): number {
	let depth = 0;
	let quote: "none" | "single" | "double" = "none";
	for (let i = open; i < text.length; i++) {
		const c = text[i];
		if (quote === "single") {
			if (c === "'") quote = "none";
			continue;
		}
		if (c === "\\") {
			i++;
			continue;
		}
		if (quote === "double") {
			if (c === '"') quote = "none";
			continue;
		}
		if (c === "'") {
			quote = "single";
			continue;
		}
		if (c === '"') {
			quote = "double";
			continue;
		}
		if (c === "(") depth++;
		else if (c === ")") {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return text.length;
}

/** Extract the quoted program passed to `sh -c …`, with the shell's name. */
function* nestedShellArgs(text: string): Generator<{ shell: string; code: string }> {
	SHELL_C_RE.lastIndex = 0;
	for (const match of text.matchAll(SHELL_C_RE)) {
		const shell = match[1];
		let i = (match.index ?? 0) + match[0].length;
		while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
		const quote = text[i];
		if (quote !== "'" && quote !== '"') continue;
		let code = "";
		for (i++; i < text.length; i++) {
			const c = text[i];
			if (c === "\\" && quote === '"') {
				code += text[i + 1] ?? "";
				i++;
				continue;
			}
			if (c === quote) break;
			code += c;
		}
		if (code.trim().length > 0) yield { shell, code };
	}
}

// ---------------------------------------------------------------- wiring
const GUIDELINE_HEADING = "## Bash calls must be one plain command (codemode-first)";
/** Opt out of the whole extension for one process. */
const ENV_OFF = new Set(["off", "0", "false", "no"]);

function guidelineBlock(): string {
	return (
		`${GUIDELINE_HEADING}\n\n` +
		"A `bash` call runs one command with its arguments, including `tools.bash` calls made from a " +
		"codemode script. Anything that composes steps — a pipe, `;`, `&&`, `$(…)`, several lines — is " +
		"rejected before it runs. Put the composition in codemode: one command per call, then branch, loop, " +
		"filter and join the returned output in JavaScript."
	);
}

/**
 * What the model sees: the rule, and where the work goes. A nested call is already inside
 * codemode, so it is told to split the shell up rather than to go and find codemode.
 */
function blockReason(nested: boolean): string {
	return nested
		? "Blocked by codemode-first: a `tools.bash` call runs one command with its arguments; this one " +
			"composes several steps. The rejection throws and aborts the script, so give every call a single " +
			"plain command and compose the results in JavaScript."
		: "Blocked by codemode-first: a `bash` call runs one command with its arguments; this one composes " +
			"several steps. Rewriting it in shell will be blocked again — put the composition in codemode, " +
			"one command per call.";
}

export default function (pi: ExtensionAPI) {
	const envOff = ENV_OFF.has((process.env.PI_CODEMODE_FIRST ?? "").trim().toLowerCase());
	let enabled = !envOff;
	let blocked = 0;
	let blockedNested = 0;
	let lastNotice = 0;

	/** Blocking is only fair while there is somewhere else to put the composition. */
	function codemodeAvailable(): boolean {
		try {
			return pi.getActiveTools().includes("codemode");
		} catch {
			return true;
		}
	}

	function offReason(): string {
		return enabled || !envOff ? "" : " (PI_CODEMODE_FIRST=off)";
	}

	pi.on("before_agent_start", async (event) => {
		if (!enabled || !codemodeAvailable()) return undefined;
		if (event.systemPrompt.includes(GUIDELINE_HEADING)) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${guidelineBlock()}` };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled || event.toolName !== "bash") return undefined;
		// Nested calls are checked too: `tools.bash` inside a codemode script is where the
		// shell program goes to hide once top-level chains are blocked.
		const nested = Boolean(event.parentToolCallId);
		if (!codemodeAvailable()) return undefined;

		const command = (event.input as Record<string, unknown>).command;
		if (typeof command !== "string" || command.trim() === "") return undefined;

		const analysis = analyzeShell(command);
		if (!analysis.complex) return undefined;

		blocked++;
		if (nested) blockedNested++;
		const now = Date.now();
		if (now - lastNotice > 2000) {
			lastNotice = now;
			ctx.ui.notify(
				`Blocked a complex bash call${nested ? " inside codemode" : ""} (#${blocked}): ` +
					describeFindings(analysis.findings),
				"warning",
			);
		}
		return { block: true, reason: blockReason(nested) };
	});

	const commandDefinition: Omit<RegisteredCommand, "name" | "sourceInfo"> = {
		description: "Turn the complex-bash guard off or on for this session",
		handler: async (args: string, ctx: ExtensionContext) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				enabled = arg === "on";
				ctx.ui.notify(
					enabled
						? `codemode-first on — complex bash calls are blocked again${codemodeAvailable() ? "" : ", but codemode is not active, so nothing is blocked"}`
						: "codemode-first off — any bash command runs again (this session only)",
					"info",
				);
				return;
			}
			if (arg !== "" && arg !== "status") {
				ctx.ui.notify("Usage: /codemode-first [on|off|status]", "error");
				return;
			}
			ctx.ui.notify(
				`codemode-first is ${enabled ? "on" : "off"}${offReason()}\n` +
					`blocked so far: ${blocked}${blockedNested > 0 ? ` (${blockedNested} inside codemode)` : ""}\n` +
					`codemode tool: ${codemodeAvailable() ? "active" : "not active — guard idle"}\n` +
					`checks every \`bash\` call, including \`tools.bash\` made from a codemode script; ` +
					`any pipe counts as composition`,
				"info",
			);
		},
	};

	pi.registerCommand("codemode-first", commandDefinition);
}
