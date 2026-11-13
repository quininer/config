# subagent-rpc

Delegate a task to a **`pi --mode rpc` child process**, keep talking to it while it
runs, and get woken up automatically when it finishes.

## Semantics

**One subagent = one task.** `start` spawns the child and sends the first prompt;
the task stays open while the child runs, and you can push updates into it
(`steer` / `follow_up` / `prompt`) and read feedback (activity tail, usage, final
output). When the child reports `agent_settled` the task is over: the child is
shut down, the record is kept for inspection, and the parent model is woken up
with the result. A finished subagent cannot take more messages — start a new one.

Subagents inherit this session's extensions, so a child can open dialogs; those
are forwarded to the parent UI and **auto-cancelled after 110s** so a child can
never wedge a task. `PI_SUBAGENT_DEPTH` stops the tool from being registered
inside a child at all.

## Actions

| Action | Params | Result |
| ------ | ------ | ------ |
| `start` | `task` (required), `name?`, `cwd?`, `model?`, `thinking?`, `tools?`, `systemPrompt?`, `wait?`, `timeoutSeconds?` | Spawns a child and sends the first prompt. Returns the id immediately, or blocks and returns the output when `wait:true` |
| `send` | `id`, `message`, `mode?` (`auto\|steer\|follow_up\|prompt`) | `auto` steers a running child, otherwise prompts it |
| `status` | `id`, `tail?` | Activity tail, usage, final assistant text, stderr tail, transcript path |
| `list` | – | Compact list of every subagent in this session |
| `interrupt` | `id` (or `"all"`) | Aborts the current turn, keeps the task open |
| `kill` | `id` (or `"all"`) | Stops the child (`stdin` close → `SIGTERM` → `SIGKILL`) |
| `clear` | – | Forgets finished records |

Up to **8** concurrent subagents.

## Watching them

- `/subagents` — open the live view; `/subagents <id>` jumps to one subagent,
  `/subagents ls` prints a text list
- `Ctrl+Alt+A` — same as `/subagents`
- `/subagent-send <id> <text>` — message a running subagent
- `/subagent-kill <id|all> [--force]` — interrupt, or `--force` to kill

### List keys

| Key | Action |
| --- | --- |
| `↑`/`↓`, `PgUp`/`PgDn` | select |
| `Enter` | open detail |
| `k` / `K` | interrupt selected / all running |
| `d` | remove record |
| `c` | show transcript path |
| `f` | toggle fullscreen |
| `h` | toggle history |
| `x` / `Esc` | close |

### Detail keys

| Key | Action |
| --- | --- |
| `↑`/`↓`, `PgUp`/`PgDn` | scroll the tail |
| `r` | resume tail-follow |
| `w` | toggle wrap |
| `m` | message this subagent |
| `k` | interrupt |
| `d` | remove record |
| `←` | back to list |

## Transcripts

Every subagent appends its messages to `<agent dir>/tmp/subagent-rpc/<id>/transcript.jsonl`
(default `~/.pi/agent`) — that is where full child output lives once the record is
dropped or the session ends. `c` in the view prints the path.

## Install

Symlink this folder into the extensions directory pi auto-discovers:

```bash
ln -sfn /path/to/subagent-rpc ~/.pi/agent/extensions/subagent-rpc
```

…or register it as a package (records a path in `settings.json`):

```bash
pi install /path/to/subagent-rpc
```

Both were verified: `/subagents`, `/subagent-send`, `/subagent-kill` appear and the
`subagent` tool registers. Reload a running session with `/reload` afterwards.

Pick **one** of them: doing both makes pi refuse to start with
`Tool "subagent" conflicts with ...` because the extension is discovered twice.

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
  | grep -o '"name":"subagent[^"]*"'  # all depths: "subagents"; depth 0 also has "subagent-send"/"subagent-kill"

rm -rf "$T"
```

## Limitations

- One task per subagent: after it settles, start a new one.
- Records live in memory; a restart loses them (transcripts stay on disk). **`/reload`
  counts as a restart**: `session_shutdown` reaps every running child, so finish or
  kill active subagents before reloading.
- A child inherits global extensions; a misbehaving one is logged to the activity
  tail rather than filtered out.
- Child dialogs are answered by the parent UI; nobody answering within 110s
  cancels them.
