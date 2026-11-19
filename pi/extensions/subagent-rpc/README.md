# subagent-rpc

Delegate a task to a **`pi --mode rpc` child process**, keep talking to it while it
runs, and get woken up automatically when it finishes.

## Semantics

**One subagent = one task.** `start` spawns the child and sends the first prompt;
the task stays open while the child runs, and you can push updates into it
(`steer` / `follow_up` / `prompt`) and read feedback (activity tail, usage, final
output). When the child settles cleanly the task is done: the child is shut down,
the record is kept for inspection, and the parent model is woken up with the
result. A settled task is closed — start a new subagent for more work.

**A provider failure is not a completed task.** When the model service breaks
(pi's automatic retries give up, or the assistant turn ends with `error`), the
record becomes `failed`, never `done`, and the child is **kept alive** so
`resume` can continue that same child with everything it already did. The footer
status line, `/subagent`, the settle message and `status` all say the task is
resumable. Killing a child (or a child that died on its own) is not resumable —
there is no session file for a `--no-session` child, so a fresh child would start
from zero.

Subagents inherit this session's extensions, so a child can open dialogs; those
are forwarded to the parent UI and **auto-cancelled after 110s** so a child can
never wedge a task. `PI_SUBAGENT_DEPTH` stops the tool from being registered
inside a child at all.

## Actions

| Action | Params | Result |
| ------ | ------ | ------ |
| `start` | `task` (required), `name?`, `cwd?`, `model?`, `thinking?`, `tools?`, `readOnly?`, `systemPrompt?`, `wait?`, `timeoutSeconds?` | Spawns a child and sends the first prompt. Returns the id immediately, or blocks and returns the output when `wait:true` |
| `send` | `id`, `message`, `mode?` (`auto\|steer\|follow_up\|prompt`) | `auto` steers a running child, otherwise prompts it |
| `resume` | `id`, `message?` | Continue a `failed`/`aborted` task in place; without `message` it says "continue after the error" |
| `status` | `id`, `tail?` | Activity tail, usage, final assistant text, stderr tail, transcript path |
| `list` | – | Compact list of every subagent in this session |
| `interrupt` | `id` (or `"all"`) | Aborts the current turn, keeps the task open |
| `kill` | `id` (or `"all"`) | Stops the child (`stdin` close → `SIGTERM` → `SIGKILL`) |
| `clear` | – | Forgets finished records |

Up to **8** concurrent subagents.

### Read-only subagents (research and review)

`readOnly: true` is for the two jobs that must never touch the tree: investigating
a problem and reviewing a change. It runs the child inside a **bubblewrap
sandbox** (`sandbox.ts`), because an allowlist of "safe" shell commands is not a
security boundary — nearly every reader has a write flag, and every wrapper is an
escape hatch. Inside the sandbox:

| | |
| --- | --- |
| filesystem | `--ro-bind / /` — the workspace, `~`, and the config dir are read-only |
| writable host file | **only this subagent's `transcript.jsonl`**, bind-mounted over the read-only view |
| pi's state dir | a private tmpfs with every entry it holds (`auth.json`, `models.json`, `settings.json`, `extensions`, `sessions`, …) re-bound read-only, so pi can read its config and create the `*.lock` dirs it needs to start, while anything it writes there dies with the sandbox |
| scratch | `--tmpfs` on `/tmp`, `$TMPDIR` and the agent `tmp/` dir — private, gone with the process |
| prompt file | re-bound `--ro-bind` after the tmpfs, so `--append-system-prompt` still resolves |
| network | allowed (`--unshare-all --share-net`): the model API, docs, sources |
| devices | only bwrap's own `/dev` exists (`null`, `zero`, `full`, `random`, `urandom`, `tty`, `ptmx`) — `> /dev/null` works, while `/dev/sda`, `/dev/mem`, `/dev/kmsg` and every other host device node is simply not there |
| namespaces | pid, ipc, uts, cgroup, user all unshared; `--die-with-parent --new-session` |

So `jj log`, `jj show`, `jj diff`, `git log`, `git diff`, `rg`, `cat`, `curl` all
work, and a write simply fails at the syscall — loudly, in the activity tail. The
preamble tells the child exactly that, and to deliver findings as text with
`file:line` evidence and a *proposed* patch instead of applying one. The marker is
`PI_SUBAGENT_READONLY=1` plus `PI_SUBAGENT_SANDBOX=bwrap` in the child's
environment.

> **Flag order matters.** `--proc` and `--dev` must come *after* `--ro-bind / /`:
> mounts are applied in argument order, so putting them first lets the root bind
> shadow them and the child ends up with the host's real `/dev` — a directory full
> of device nodes that every call fails to open (`/dev/null: Permission denied`),
> which is both useless and misleading. Mounted last, `/dev` is bwrap's own set and
> works.

Alongside the sandbox, the child still gets the conservative tool selection
(`--tools read,grep,find,ls,bash`, an exact selection so extension tools such as
`codemode` are never declared) and `--no-mcp`, since `--tools` does not hide MCP
tools. If you pass your own `tools`, the state-changing ones (`write`, `edit`,
`codemode`, `mcp__*`) are filtered out and the drop is logged to the activity
line. The record shows `ro` in `/subagent`, `[read-only]` in the settle message,
`sandbox: "bwrap"` in tool details, and the sandbox line in the detail view.

**No `bwrap`, no read-only child.** `start` probes the sandbox once and refuses
with a reason (`install bubblewrap, or set PI_SUBAGENT_BWRAP=/path/to/bwrap`)
rather than running an unsandboxed child that was promised to be read-only. The
host also needs user namespaces (`/proc/sys/kernel/unprivileged_userns_clone` = 1
on Debian/Ubuntu); the probe reports whatever bwrap complains about.

```
subagent{action:"start", task:"review the parser for edge cases", readOnly:true}
```

## Watching them

Subagents show up in the **footer status line** without opening anything. The
footer is one line shared with every other extension, so the format stays terse:
a `sub` label, then one flag per state.

| Footer | Meaning |
| --- | --- |
| `sub ⏳3` | 3 running, none producing tokens right now |
| `sub ▌2` | 2 running, at least one streaming (`↻` in place of `▌` means one is retrying) |
| `sub ▌ refactor footer 4m00s` | exactly one running, so its name and elapsed time fit (names are dropped on narrow terminals) |
| `sub ⚑1` | 1 dialog waiting for an answer in this terminal |
| `sub ✗1f↻` | 1 failed/aborted in the last 10 minutes, `↻` when all of them are resumable |

- `/subagent` — open the live view; `/subagent <id>` jumps to one subagent,
  `/subagent ls` prints a text list
- `/subagent-send <id> <text>` — message a running subagent, or continue a
  failed/aborted one: a stopped-but-live child is resumed in place, so there is
  no separate retry command
- `/subagent-kill <id|all> [--force]` — interrupt, or `--force` to kill

### List keys

A row is `status · name · id · ro · elapsed · activity · ↻ · cost · context`, and
the name absorbs whatever columns are left so nothing else gets cut off.

| Key | Action |
| --- | --- |
| `↑`/`↓`, `PgUp`/`PgDn` | select |
| `Enter` | open detail |
| `k` | interrupt selected |
| `R` | resume a failed/aborted task |
| `d` | drop the record (the child keeps running until it settles) |
| `c` | show the transcript path |
| `h` | include finished subagents |
| `f` | toggle fullscreen |
| `x` / `Esc` | close |

### Detail keys

The detail view is four pages, so a record is readable instead of summarized:

| Key | Page |
| --- | --- |
| `t` | **activity log** — every recorded item, newest at the bottom |
| `i` | **overview** — the whole record: state, child/model/cwd/tools/sandbox, usage, output, problems, plus pointers to the task, the reply and the transcript |
| `p` | **instruction** — the task text exactly as sent |
| `o` | **reply** — the whole final answer plus the stderr tail |
| `Tab` | cycle the four pages |
| `↑`/`↓`, `PgUp`/`PgDn` | scroll the current page |
| `r` | follow the activity log again (scrolling away pauses it, and a line at the bottom says where you stopped) |
| `w` | wrap ⇄ truncate |
| `m` | message this subagent (continues the task if it stopped early) |
| `R` | resume a failed/aborted task |
| `k` | interrupt |
| `d` | drop the record |
| `←` | back to the list |

Above the pages, three or four header lines carry the state that matters at a
glance: status, `▌ typing` / `⇄ 1 queued` / `⚑ 1 dialog` / `↻ resumable`, id, pid,
elapsed, the task in one line, and usage · model · cost. On a narrow terminal the
parts that do not fit are dropped instead of chopped in half.

In the activity log every line starts with its time since start (`+4m02s`) and a
kind marker (`❯` tool call, `↳` tool result, `▎` assistant text, `→` what you
sent, `⇄` queue, `⚑` dialog, `·` system, `✗` error), with wrapped lines indented
under their item. Assistant text is previewed — three lines, then
`… N more lines - o reads the reply` — because one long answer used to push the
whole log off screen.

## Transcripts

Every subagent appends its messages to `<agent dir>/tmp/subagent-rpc/<id>/transcript.jsonl`
(default `~/.pi/agent`) — that is where full child output lives once the record is
dropped or the session ends. `c` in the view prints the path. It is also the **one
file a sandboxed read-only child may write to**, which is what keeps its output
readable while everything else it touches is read-only.

## Verifying without touching your config

`PI_CODING_AGENT_DIR` relocates the whole config directory, so a scratch agent dir
exercises the real discovery path (symlinked folder under `extensions/`) without any
global change and without `-e`:

```bash
T=$(mktemp -d); mkdir -p "$T/extensions"
ln -sfn /path/to/subagent-rpc "$T/extensions/subagent-rpc"
cp ~/.pi/agent/auth.json "$T/"
ln -s ~/.pi/agent/{npm,skills,models.json} "$T/"

PI_CODING_AGENT_DIR="$T" pi            # normal TUI, extension discovered

# recursion fuse: at depth 1 the tool is never registered
printf '{"type":"get_commands","id":"g1"}\n' \
  | PI_CODING_AGENT_DIR="$T" PI_SUBAGENT_DEPTH=1 pi --mode rpc --no-session \
  | grep -o '"name":"subagent[^"]*"'  # all depths: "subagent"; depth 0 also has "subagent-send"/"subagent-kill"

rm -rf "$T"
```

## Checking the sandbox by hand

`buildBwrapArgs()` is pure argv building, and the recipe is short enough to run
directly — the three properties that matter are a blocked host write, a writable
transcript, and a usable `/dev/null`:

```bash
T=$(mktemp)   # stand-in for a subagent transcript: the one writable file
bwrap --unshare-all --share-net --new-session --die-with-parent \
      --ro-bind / / --tmpfs /tmp --ro-bind "$T" "$T" --proc /proc --dev /dev \
      --chdir "$PWD" -- sh -c '
  echo x > "$HOME/should-fail" || echo WRITE_BLOCKED
  echo x >> "'"$T"'" && echo TRANSCRIPT_OK
  echo x > /dev/null && echo NULL_OK
  test -e /dev/sda && echo HOST_DEVICE_PRESENT || echo NO_HOST_DEVICES'
```

Mount order is the part to get right: `--proc` and `--dev` belong **after**
`--ro-bind / /`, and any path that must stay writable (the transcript) belongs
last, after the tmpfs mounts that would otherwise cover it.

To type-check the sources against an installed pi, use a `tsconfig.json` with
`allowImportingTsExtensions`, `strict`, and `paths` pointing at
`/usr/lib/node_modules/pi/packages/*/dist/index.d.ts`. Without a `tsc` at hand,
`deno check --no-lock --allow-import *.ts` catches real mistakes in these files
even though the pi packages do not resolve — ignore its `not a dependency` and
implicit-`any` noise and read the rest.

Layout changes in the view are reviewable without a live child: render
`SubagentManager` against fake `Subagent` records and print the lines with the
ANSI stripped (`stripTerminalSequences`) — one screen per view, at a wide and a
narrow width, plus the footer text from `statusLineParts`. Wrapping, column
budgets and the empty states are exactly what that catches.

## Limitations

- The read-only sandbox **stops accidents, not a determined agent**: the child
  still reads the whole workspace, runs with your credentials, and keeps network
  access (research needs it), so it could still send what it reads somewhere. It
  can no longer *change* anything on the host — writes fail with `EROFS` — but do
  not treat it as containment for hostile code.
- A read-only child needs `bwrap` and working user namespaces. pi's own state dir
  has to be writable or pi dies at startup with `EROFS` on `trust.json.lock` (its
  config store locks are `mkdir(<file>.lock)` directories, taken even for plain
  reads, and the file is created if missing), so the directory is *replaced* by a
  tmpfs and its contents re-bound read-only. Consequence: a token refresh inside a
  read-only child succeeds and then evaporates instead of persisting. If pi ever
  exposes a read-only credentials storage, the whole exception can go away.
- One task per subagent: after it settles, start a new one.
- Only an in-place resume exists. If the child died (crash, `kill`, `/reload`),
  the task cannot be continued — start a new subagent.
- A `failed`/`aborted` child stays alive so it can be resumed; `kill` (or `clear`)
  frees the process.
- Records live in memory; a restart loses them (transcripts stay on disk). **`/reload`
  counts as a restart**: `session_shutdown` reaps every running child, so finish or
  kill active subagents before reloading.
- A child inherits global extensions; a misbehaving one is logged to the activity
  tail rather than filtered out.
- Child dialogs are answered by the parent UI; nobody answering within 110s
  cancels them.
