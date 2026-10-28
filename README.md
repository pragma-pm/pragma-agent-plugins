# Pragma agent plugins

Plugins that make coding agents track their work in [Pragma](https://pragma.pm): the task they are on, the time it took, the requirement or issue it answers. One folder per agent harness; Claude Code first.

```
claude plugin marketplace add pragma-pm/pragma-agent-plugins
claude plugin install pragma@pragma.pm
```

Then, in a session opened in the repository to track: `/pragma:setup`.

## Claude Code: the `pragma` plugin

What a tracked session looks like:

- Before the agent changes a file, it pins a Pragma task: it finds or creates the requirement or issue the work answers, finds or creates a task under it, assigns you, moves the task to *in progress*. A file change while nothing is pinned is refused once.
- When the task is done, the agent logs the time you spent, from the transcript's timestamps, and closes the task. A close without a time entry, or with unlogged minutes beyond a small slack, is refused once with the minutes computed.
- A closed task may complete its requirement or issue: the agent then offers to move it, as a choice among its allowed transitions. You decide; the agent never closes a requirement or an issue on its own. Every such question is an interactive choice, never a line of text to answer.
- A `◷ Pragma` button under the prompt opens a menu of the session's Pragma objects: the project, the requirements and issues, the tasks, with the minutes logged on each. An entry opens its page. A task's minutes can be adjusted, a task deleted with its minutes moved to the previous one.

Every refusal is a warning, not a lock: the same call repeated goes through. The person is in charge, not the rule.

### Setup

`/pragma:setup` walks through, once per machine and once per repository:

1. The Pragma MCP server (`https://api.pragma.pm/mcp`), registered under the name `pragma` in your user config, and signed in.
2. Who you are in Pragma: your actor id, stored in `~/.claude/pragma/identity.json`.
3. The repository: its organization and the two default projects for work that belongs to no initiative, stored in `~/.claude/pragma/repositories.json`. The hooks are inert in any other directory.
4. Permission rules for the Pragma tools the agent calls on your behalf, so neither you nor the auto-mode classifier is asked for each.
5. Your preference for work of a few minutes: on the need's previous task, or a task of its own.

### What the plugin reads and writes

Hooks and menu run on your machine. They read the session transcript for timestamps and keep their state under `~/.claude/pragma/`. The only network calls are the agent's own calls to the Pragma MCP server, and the menu's, which go through the same tool path and the same permission check. Nothing is sent anywhere else, and nothing is committed in your repository: the mapping is per person because permissions are.

Requirements: Claude Code 2.1.275 or later, `python3` on the PATH.

### Layout

```
.claude-plugin/        plugin and marketplace manifests (the repository root is the plugin)
claude-code/hooks/     pragma_hooks.py (the hooks), PROTOCOL.md (what the agent is told), register.tsx (the menu)
claude-code/skills/    /pragma:setup
claude-code/types/     the menu's state contract
```

Other harnesses get a folder each. The rules are the same everywhere; only the plumbing differs, and the shared part is extracted when the second harness arrives.

### Development

```
claude --plugin-dir /path/to/pragma-agent-plugins   # loads the plugin, hot-reloads the menu on edit
claude plugin validate .                            # manifests, hooks, the menu module
tsc -p .                                            # once the engine has written .claude-plugin/types/
```

## License

[Unlicense](LICENSE): public domain.
