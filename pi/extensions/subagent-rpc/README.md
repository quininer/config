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

Running subagents show up in the **footer status line** (`⏳ sub 2 name…`,
`⚑ 1 dialog`, `✗ 1 failed ↻`) without opening anything.

- `/subagent` — open the live view; `/subagent <id>` jumps to one subagent,
  `/subagent ls` prints a text list
- `/subagent-send <id> <text>` — message a running subagent, or continue a
  failed/aborted one: a stopped-but-live child is resumed in place, so there is
  no separate retry command
- `/subagent-kill <id|all> [--force]` — interrupt, or `--force` to kill

### List keys

| Key | Action |
| --- | --- |
| `↑`/`↓`, `PgUp`/`PgDn` | select |
| `Enter` | open detail |
| `k` | interrupt selected |
| `R` | resume a failed/aborted task |
| `d` | remove record |
| `c` | show transcript path |
| `f` | toggle fullscreen |
| `h` | toggle history |
| `x` / `Esc` | close |

### Detail keys

The detail body has three views, so the whole instruction and the whole reply are
readable and not just the one-line summary:

| Key | Action |
| --- | --- |
| `t` / `p` / `o` | activity tail / **full instruction** / **full reply** |
| `↑`/`↓`, `PgUp`/`PgDn` | scroll the current view |
| `r` | resume tail-follow (activity view) |
| `w` | wrap ⇄ truncate (in every view) |
| `m` | message this subagent (continues the task if it stopped early) |
| `R` | resume a failed/aborted task |
| `k` | interrupt |
| `d` | remove record |
| `←` | back to list |

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
`/usr/lib/node_modules/pi/packages/*/dist/index.d.ts`.

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
