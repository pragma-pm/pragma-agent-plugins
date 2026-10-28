// The gates: a call refused once, with the reason and what to do instead; the same call
// repeated goes through. The person is in charge, not the rule.

import type { TrackingState } from '../../types'
import { ACTIVITY_TYPES, CLOSING_CATEGORIES, isAssigned, manageableType, minutesSince, titleOf, unloggedSince } from './state'
import { insideRepository, resolvePath, shellWrittenPaths } from './shell'
import { OVERRIDE_SENTENCE, ambiguitySentence } from './texts'
import { COUNTED_SPAN_MINUTES, DROPPED_SPAN_MINUTES, hhmm } from './time'

/** Unlogged minutes a close lets through once the task carries an entry. */
export const CLOSE_SLACK_MINUTES = 5
const WARNED_CALLS_KEPT = 20

/** The tools that change files. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'NotebookEdit', 'Bash'])

/** djb2 of a text, as hex: the key a refused call is remembered by. */
function hashOf(text: string): string {
  let hash = 5381
  for (let index = 0; index < text.length; index++) hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0
  return hash.toString(16)
}

/**
 * Refuse a call the first time a rule catches it; the same call repeated goes through. The
 * reason to deny with, or null when the call goes through. The rule is part of the key: a retry
 * that a fix turned into another rule's catch is warned again, not let through.
 */
export function warned(state: TrackingState, rule: string, tool: string, fields: Record<string, unknown>, reason: string): string | null {
  const call = hashOf(JSON.stringify([rule, tool, fields]))
  if (state.warnedCalls.includes(call)) {
    state.warnedCalls = state.warnedCalls.filter(known => known !== call)
    return null
  }
  state.warnedCalls = [...state.warnedCalls, call].slice(-WARNED_CALLS_KEPT)
  return `${reason} ${OVERRIDE_SENTENCE}`
}

export type WorkGateInput = {
  tool: string
  fields: Record<string, unknown>
  /** The session's working directory, real path. */
  cwd: string
  /** The repository's root, real path. */
  root: string
  /** The environment variables the command names. */
  variables: Readonly<Record<string, string>>
}

/**
 * A change to the repository's files while no task is pinned: refused once. Only the
 * repository's files are gated: a personal file elsewhere (a status line, a scratch file) is
 * nobody's task. An overridden refusal opens the gate until the next prompt.
 */
export function gateWork(state: TrackingState, input: WorkGateInput): string | null {
  if (state.task !== null || state.workGateOpen) return null
  const written =
    input.tool === 'Bash'
      ? shellWrittenPaths(typeof input.fields['command'] === 'string' ? input.fields['command'] : '', input.cwd, input.variables)
      : [resolvePath(stringOf(input.fields['file_path']) ?? stringOf(input.fields['notebook_path']) ?? '', input.cwd, input.variables)]
  if (!written.some(path => insideRepository(path, input.root))) return null
  const reason = warned(
    state,
    'unpinned',
    input.tool,
    input.fields,
    'Pragma: no task pinned for this session, and this call changes files of the repository. Pin first: find or create the need ' +
      '(requirement, or issue for a fix) with `search` across the organization; find or create the task under it (`create_manageable` ' +
      'type task, then `create_link` need --has_response--> task); `available_transitions` on the task, then `transition_manageable` it ' +
      'to the in_progress state. Then tell the user in one line: "Pinned: [<task>](https://app.pragma.pm/items/<taskId>) — ' +
      '[<need>](https://app.pragma.pm/items/<needId>) (<project>)". Full protocol in the system prompt. Overriding opens this gate until ' +
      'the next prompt.',
  )
  if (reason === null) state.workGateOpen = true // overridden: the person wants the work done unpinned, this turn
  return reason
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** A closing transition of a task without a time entry, or with unlogged minutes beyond the slack: refused once. */
export function gateClose(state: TrackingState, fields: Record<string, unknown>, now: number): string | null {
  const manageableId = stringOf(fields['id']) ?? ''
  const type = manageableType(manageableId)
  if (type === null || !ACTIVITY_TYPES.has(type)) return null
  const category = state.stateCategories[stringOf(fields['toStateId']) ?? '']
  if (category === undefined) {
    return warned(
      state,
      'unknown-state',
      'mcp__pragma__transition_manageable',
      fields,
      'Pragma time gate: the target state is unknown to this session. Call `available_transitions` on this item first (it reveals the ' +
        'state categories), then retry.',
    )
  }
  if (!CLOSING_CATEGORIES.has(category)) return null
  const { since: lastEntry, logged } = unloggedSince(state, manageableId)
  const since = lastEntry ?? state.tasks[manageableId]?.seenAt ?? state.startedAt
  const { minutes, ambiguous } = minutesSince(state, since, { at: now, byPerson: false })
  // An interim entry does not cover the work after it.
  if (logged && minutes < CLOSE_SLACK_MINUTES && ambiguous.length === 0) return null
  const title = titleOf(state, manageableId)
  const unlogged = logged ? `${minutes} min on «${title}» since its last time entry` : `no time entry on «${title}» this session`
  return warned(
    state,
    'unlogged',
    'mcp__pragma__transition_manageable',
    fields,
    `Pragma time gate: ${unlogged}, and this transition closes it. Session: ${hhmm(since)}→${hhmm(now)}, ${minutes} min working wall clock ` +
      `(turns and the gaps between them judged whole: up to ${COUNTED_SPAN_MINUTES} min counted, ${DROPPED_SPAN_MINUTES} min or more ` +
      `dropped entirely).${ambiguitySentence(ambiguous)} Log it, then retry the transition: add_time_entry({ activityId: "${manageableId}", ` +
      `duration: ${minutes}, remaining: 0, note: "derived from the session's turns" }). Several tasks in that span? Split by commit ` +
      'timestamps or your judgment and say so in the note. Nothing to log (the user said so)? duration 0 with a note saying why. ' +
      'Then one line to the user: what you logged, on what.',
  )
}

/** A time entry while the worker is not known to be assigned: refused once. */
export function gateLog(state: TrackingState, fields: Record<string, unknown>): string | null {
  const activityId = stringOf(fields['activityId']) ?? ''
  const worker = stringOf(fields['workerId']) ?? state.actorId
  if (worker === null || worker === '' || isAssigned(state, activityId, worker)) return null
  return warned(
    state,
    'unassigned',
    'mcp__pragma__add_time_entry',
    fields,
    `Pragma: ${worker} is not known to be assigned to «${titleOf(state, activityId)}», and time is logged on assigned tasks only. ` +
      `Assign first — assign_activity({ activityId: "${activityId}", workerId: "${worker}", isRequest: false }) — or, when the ` +
      'assignment already exists, get_manageable the task so it is visible to this session. Then retry add_time_entry.',
  )
}
