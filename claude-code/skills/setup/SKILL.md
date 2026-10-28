---
name: setup
description: Set up Pragma time tracking on this machine and in this directory — the Pragma MCP server, who the user is in Pragma, the directory's organization and default projects, the permission rules for the Pragma tools, the user's preferences. Use when the user runs /pragma:setup, or asks to set up, configure, connect or repair Pragma time tracking.
---

# Pragma time tracking: setup

You walk the user through the setup of the `pragma` plugin. Every choice is asked with the AskUserQuestion tool, options first, never as a plain-text question. Say what you found before you ask, and ask only what you cannot find.

The hooks are inert until step 3 is done for this directory, so a half-finished setup changes nothing.

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

## 3. The directory

The registration is per person and per directory, kept in `~/.claude/pragma/directories.json`, never committed: permissions differ from one person to the next. The hooks cover the registered directory and every directory under it, and are inert elsewhere.

1. The directory: the one the session runs in, resolved (`pwd -P`). When it or one of its parents holds a `.git` entry (a code repository), the directory that holds it, so every sub-directory is covered. Find it by testing each parent for `.git`, never by running `git`: the user may not have it, and on a Mac without the developer tools the command opens an installer. Someone who keeps one directory per client registers each.
2. The organization: `list_organizations`. One: take it. Several: AskUserQuestion.
3. The default projects: where work goes when it answers no initiative project. Ask (AskUserQuestion) how the user files such work:
   - **One catch-all project.** `list_projects`; propose the best-fitting existing project, with «create one» as an option. Stored under the key `any`.
   - **One project per kind of work.** Propose the two usual kinds — problems (something is wrong) and improvements (something is wanted) — and ask (AskUserQuestion, multiSelect) which to keep and which others to add: the user may name any kind of their own (client requests, administration, …). Each kind gets a short lowercase key (`fix`, `improvement`, or a word for the user's kind) and a project: `list_projects`, propose the best-named existing one per kind, else create.
   - **None.** The agent asks which project each time no initiative project fits. Stored as `{}`.

   Creating a project: propose a name in the user's language and line of work («Problems», «Improvements» — software terms only when the organization's other projects use them) and validate it with the user (AskUserQuestion: the proposed name, «another name») before `create_project`.
4. Write the entry, merged into the existing file:

```json
{
  "/abs/path/to/directory": {
    "organizationId": "organization__…",
    "organizationName": "…",
    "defaultProjects": {
      "fix": { "id": "project__…", "title": "Problems" },
      "improvement": { "id": "project__…", "title": "Improvements" },
      "clients": { "id": "project__…", "title": "Client requests" }
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

- Tell the user to run `/clear` or start a new session: the protocol the hooks inject arrives at session start. From then on, in this directory and under it, the agent pins a task before any change and logs its time.
- Point at the `◷ Pragma` button under the prompt: the session's objects, their logged minutes, adjust and delete.
- Suggest a first test: ask for a small change to a file of the directory — a note, a document, a line of code, whatever the work is — and watch the pin and the log happen.
