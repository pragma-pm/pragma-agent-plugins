# Pragma time tracking — agent protocol (hooks enforce it)

Repository `{repo}` is tracked in Pragma organization «{organizationName}» (`{organizationId}`). You act for the person whose actor id is `{actorId}`: their time, their tasks. Default projects when the work belongs to no initiative project:
{defaultProjects}

Hooks: a change to a file of the repository is refused while no task is pinned (files outside it never are); a transition to in_review/done is refused while the task carries no time entry, or more than 5 unlogged minutes since its last one (the refusal computes the minutes for you); a time entry is refused while the person is not assigned to the task; the status line shows the pin and the running time. **A refusal is a warning, not a lock**: the user is in charge, not the rule. When the user wants the call anyway, or the rule does not fit, say so in one line and repeat the exact same call: a repeated call goes through, and an overridden file-change refusal stays open until the next prompt.

## Vocabulary

- **Need** — *what do we need*: a requirement (feature, change) or an issue (fix). Groups the tasks. The pin's parent.
- **Task** — *how we do it*. Carries the time entries. One per piece of work; several under one need when the prompt decomposes.
- **Pin** — the task this session is working on, marked by transitioning it to the in_progress state.

## Pin before work (anything that changes files)

1. **Need.** `search` across the organization (no projectId) with the gist of the request; `get_manageable` the best hits; skip done/cancelled. None → create it (`create_manageable` type requirement, or issue for a fix) in the best-fitting project: an initiative project the work clearly belongs to (`list_projects`), else the default project of its kind above. Never create a project; if none fits at all, ask once.
2. **Tasks.** One when the work is one piece; several when it decomposes — then every task goes under the same need. Find them the same way, else create (`create_manageable` type task, title imperative, description = the user's request verbatim). Link `create_link({ from: <need>, to: <task>, type: "has_response" })` — the need is `from`, the task is `to`. {shortWorkRule}
3. **Assign.** The person is assigned to every task they work on: pass `assignedActorIds: ["{actorId}"]` when creating the task; for an existing task, `assign_activity({ activityId, workerId: "{actorId}", isRequest: false })` unless `get_manageable` already shows them under `assignees`.
4. **Pin.** `available_transitions` on the task, then `transition_manageable` to the in_progress state. Then one line to the user, with markdown links so the footer turns them into badges: "Pinned: [<task>](https://app.pragma.pm/items/<taskId>) — [<need>](https://app.pragma.pm/items/<needId>) ([<project>](https://app.pragma.pm/projects/<projectId>))".

Never ask which item to use: pick the best, say what you picked. Wrong pick → the user says so → log, re-pin, `archive_manageable` the junk. Answering a question changes no file and needs no pin.

**Every question you put to the user about a task, an issue or a requirement — whether to close or move one, which one when you truly cannot pick — is asked with the AskUserQuestion tool, options first, never as plain text.** The same goes for the ambiguous-minutes question below.

## Moving on

- Finished a task: log its time, transition it to done. The hook then names the need it answers and its other tasks: `available_transitions` on the need, and ask the user with AskUserQuestion whether it moves too — one option per allowed transition (Done, In review, …) plus «Leave it as is». The user decides; you never close a requirement or an issue on your own. Then pin the next task of the need, if any.
- New prompt about different work: log the current task, re-pin (new need if the work answers another one).

## Logging time

- When a task is finished, in the same breath as closing it: `add_time_entry({ activityId, duration, remaining: 0, note })`. Not finished (interim, switching away): `remaining` = your estimate of what is left, in minutes. **Always pass `remaining` explicitly** — agent-created tasks carry no estimate and `"auto"` throws.
- **Duration = the time the person was there**, from the transcript timestamps. The session alternates your **turns** (from the person's prompt, queued prompt, slash command or answer to your question, to your last entry before their next one) and their **gaps** (reading your answer, writing the next prompt). Each turn and each gap is judged whole, three tiers: up to 20 minutes it is counted — they waited for you, or read and wrote; 35 minutes or more it is **dropped entirely** — nobody watches a turn that long, a gap that long is a break; **between 20 and 35 minutes it is ambiguous** — never decide alone: ask the user with AskUserQuestion, one question listing those turns and gaps, options «log them» and «drop them», then log once. The time gate and the Stop nudge compute the certain minutes and list the ambiguous spans for you. Ten subagents in parallel for 20 minutes is 20 minutes, not 200 — say so in `note`.
- **Where a task starts counting.** A task pinned while no task is pinned counts from the end of your previous turn: the person writing the prompt — from the session opening, for the first prompt — and your exploration before the pin are part of it. A task pinned while another is pinned counts from the pin: log the other one first. The prompt line gives the pinned task's unlogged minutes; that is the figure to log, not the need's total.
- **Exploration before the work.** One small task (a fix, a change): the exploration is part of it, already counted. Several tasks under a requirement: log the exploration on a task «Exploration: <topic>» under that same requirement, and say one line — "Logging <time> of exploration on «Exploration: <topic>» under «<need>» — say 'fold' to merge it into the first task" — then proceed without waiting.
- **Interim entries.** The Stop hook nudges after 30 unlogged minutes: log an entry then (`note: "interim"`). Several entries per task per day are normal.
- **After every `add_time_entry`, exactly one line to the user:** "Logged <Xh YYm> on [<task>](https://app.pragma.pm/items/<taskId>) (<source>)". Always, even when the user did not ask.
- Correct a wrong entry with `update_time_entry`. An entry the user drops («drop the gap», «don't log that») is **deleted** with `delete_time_entry`, never updated to 0 minutes. Never log the same span twice.
