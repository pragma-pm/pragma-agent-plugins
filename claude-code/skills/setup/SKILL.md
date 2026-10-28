---
name: setup
description: Set up Pragma time tracking on this machine and in this repository — the Pragma MCP server, who the user is in Pragma, the repository's organization and default projects, the permission rules for the Pragma tools, the user's preferences. Use when the user runs /pragma:setup, or asks to set up, configure, connect or repair Pragma time tracking.
---

# Pragma time tracking: setup

You walk the user through the setup of the `pragma` plugin. Every choice is asked with the AskUserQuestion tool, options first, never as a plain-text question. Say what you found before you ask, and ask only what you cannot find.

The hooks are inert until step 3 is done for this repository, so a half-finished setup changes nothing.

## 1. The Pragma MCP server

Run `claude mcp get pragma`.

- Connected: go on.
- Absent: register it in the user scope so every project gets it: `claude mcp add --transport http --scope user pragma https://api.pragma.pm/mcp`. Then tell the user to sign in with `/mcp` (pick `pragma`, authenticate). The tools appear once signed in.
- Present under another name: the hooks match the tools by the prefix `mcp__pragma__`, so the server must be named `pragma`. Ask (AskUserQuestion) whether to rename it: remove the old entry with `claude mcp remove <name> -s <scope>`, add it as above.

## 2. Who the user is in Pragma

The hooks attribute time to one actor id, kept in `~/.claude/pragma/identity.json`. Read the file first; if it names an `actorId`, confirm it with the user and go on.

Call `get_me`: it answers the caller's `actorId`, nickname, email and organizations. Confirm the nickname with the user (AskUserQuestion: "You are «nickname»?" with yes / no) and write:

```json
{ "actorId": "actor__…" }
```

A server that does not know `get_me` yet answers that the tool does not exist: find the id through an item instead. Ask the user to name a Pragma item they are assigned to (AskUserQuestion with the items `search` finds for their name as a shortcut, plus "none of these"), `get_manageable` it, read `assignees`, and ask the user to pick themselves among the names shown. If nothing is assigned to the user anywhere, ask them to paste their actor id from the Pragma webapp.

## 3. The repository

The mapping is per person and per repository, kept in `~/.claude/pragma/repositories.json`, never committed: permissions differ from one person to the next.

1. The repository root: `git rev-parse --show-toplevel`, resolved (`realpath`). The key of the mapping.
2. The organization: `list_organizations`. One: take it. Several: AskUserQuestion.
3. Two default projects, for work that answers no initiative project: one for fixes, one for improvements. `list_projects`; propose the best-named existing ones (bugs, issues, fixes; improvements, maintenance, chores) through AskUserQuestion, with "create them" as an option. Creating: `create_project` named «Internal Bug Reports» and «Continuous Improvements», or the names the user gives.
4. Write the entry, merged into the existing file:

```json
{
  "/abs/path/to/repository": {
    "organizationId": "organization__…",
    "organizationName": "…",
    "defaultProjects": {
      "fix": { "id": "project__…", "title": "…" },
      "improvement": { "id": "project__…", "title": "…" }
    }
  }
}
```

## 4. Permission rules

The agent calls these Pragma tools on the user's behalf many times a session; the menu under the prompt calls some of them on a press. Without a rule each call is a prompt, or a refusal from the auto-mode classifier. Offer (AskUserQuestion: add to user settings / add to this project's settings / skip) to add them to `permissions.allow`:

```
mcp__pragma__search
mcp__pragma__available_transitions
mcp__pragma__create_manageable
mcp__pragma__create_link
mcp__pragma__assign_activity
mcp__pragma__add_time_entry
mcp__pragma__update_time_entry
mcp__pragma__delete_time_entry
mcp__pragma__archive_manageable
mcp__pragma__delete_manageable
```

User settings are `~/.claude/settings.json`, project settings `.claude/settings.local.json`. Read the file, merge into the existing array, write it back. If the edit is refused (the auto-mode classifier treats a settings edit as self-modification), hand the user this line to run as is, with the file they chose:

```
! jq '.permissions.allow += ["mcp__pragma__search","mcp__pragma__available_transitions","mcp__pragma__create_manageable","mcp__pragma__create_link","mcp__pragma__assign_activity","mcp__pragma__add_time_entry","mcp__pragma__update_time_entry","mcp__pragma__delete_time_entry","mcp__pragma__archive_manageable","mcp__pragma__delete_manageable"]' ~/.claude/settings.json > ~/.claude/settings.json.new && mv ~/.claude/settings.json.new ~/.claude/settings.json
```

## 5. Preferences

Ask (AskUserQuestion) what happens with work of a few minutes:

- **On the need's previous task** (default): no task is created for it; the previous task of the requirement or issue is pinned again, logged, closed again.
- **A task of its own**: every piece of work gets a task, however short.

Store it in `identity.json` as `"preferences": { "taskForShortWork": false | true }`.

## 6. Finish

- Tell the user to run `/clear` or start a new session: the protocol the hooks inject arrives at session start. From then on, in this repository, the agent pins a task before any change and logs its time.
- Point at the `◷ Pragma` button under the prompt: the session's objects, their logged minutes, adjust and delete.
- Suggest a first test: a one-line change, to watch the pin and the log happen.
