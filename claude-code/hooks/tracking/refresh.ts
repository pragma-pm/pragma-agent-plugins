// `/pragma:refresh`: the items of the Pragma menu read again from Pragma. The session learns an
// item's state from its own calls only: one closed, reopened, renamed, archived or deleted
// elsewhere (the webapp, another session) stays as the session last saw it until read again.
// The hooks make the calls (`get_manageable` per item, `get_workflow` for a state whose category
// the session does not know) and track them; this file reads the answers and brings the
// session's state to them.

import type { TrackingState } from '../../types'
import { CLOSING_CATEGORIES, isClosed, isRecord, recordOf, taskFigure, titleOf } from './state'
import { hm } from './time'
import { parseAnswer, stringField } from './track'

/** Declared by the manifest (`claude-code/commands/refresh.md`), which names it after the plugin; served by the hooks. */
export const REFRESH_COMMAND = 'pragma:refresh'

/** The categories the menu shows as closed: a task's closes (in review, done), and a cancel. */
const CLOSED_CATEGORIES: ReadonlySet<string> = new Set([...CLOSING_CATEGORIES, 'cancelled'])

/** What Pragma answered `get_manageable` for one item of the menu. */
export type ItemReading =
  | { id: string; kind: 'read'; status: string | null; stateId: string | null; workflowId: string | null }
  /** Deleted, or no longer visible to the person: Pragma answers both alike. */
  | { id: string; kind: 'gone' }
  | { id: string; kind: 'unreadable'; reason: string }

/** A tool call's outcome, as `$.tool.call` resolves it. */
export type CallOutcome = { deny?: string; isError?: boolean; text?: string }

/** The items the menu lists that Pragma can be asked about: its manageables, the archived left out. */
export function refreshableIds(state: TrackingState): string[] {
  return Object.keys(state.titles).filter(id => id.startsWith('manageable_') && state.tasks[id]?.archivedAt === undefined)
}

export function readingOf(id: string, outcome: CallOutcome): ItemReading {
  if (outcome.isError === true) {
    const reason = outcome.text ?? 'the tool reported an error'
    return /not found/i.test(reason) ? { id, kind: 'gone' } : { id, kind: 'unreadable', reason }
  }
  const answer = parseAnswer(outcome.text)
  if (!isRecord(answer)) return { id, kind: 'unreadable', reason: 'the answer is not an item' }
  return { id, kind: 'read', status: stringField(answer, 'status'), stateId: stringField(answer, 'workflowStateId'), workflowId: stringField(answer, 'workflowId') }
}

type Status = 'open' | 'closed' | 'archived'

/**
 * An item's status from its reading: archived; closed when its state's category closes it, or
 * when Pragma calls it inactive (done, cancelled); open otherwise. Null while the category is
 * unknown and the item active: in review (closed, for a task) or not, the reading cannot say.
 */
export function statusOf(state: TrackingState, reading: Extract<ItemReading, { kind: 'read' }>): Status | null {
  if (reading.status === 'archived') return 'archived'
  const category = reading.stateId === null ? undefined : state.stateCategories[reading.stateId]
  if (category !== undefined) return CLOSED_CATEGORIES.has(category) ? 'closed' : 'open'
  return reading.status === 'inactive' ? 'closed' : null
}

/** The workflows to read for the categories of the states the session does not know. */
export function unknownWorkflows(state: TrackingState, readings: readonly ItemReading[]): string[] {
  const workflows = readings.flatMap(reading =>
    reading.kind === 'read' && reading.workflowId !== null && statusOf(state, reading) === null ? [reading.workflowId] : [],
  )
  return [...new Set(workflows)]
}

export type RefreshOutcome = {
  /** What the person reads, as the command's output. */
  text: string
  /** What the model reads at its next turn; null when it has nothing to do. */
  context: string | null
}

/**
 * The session's state brought to the readings: a status Pragma changed, a title, an item gone.
 * A pinned task closed or gone outside the session is unpinned, as a close by the session would
 * unpin it; the minutes it had unlogged go to the model, to log. `titlesBefore` are the titles
 * the menu showed before the readings (tracking `get_manageable` has already renamed them).
 */
export function applyReadings(state: TrackingState, readings: readonly ItemReading[], titlesBefore: Readonly<Record<string, string>>, now: number): RefreshOutcome {
  const changes: string[] = []
  const unreadable: string[] = []
  let context: string | null = null
  // The figure the hint row showed the person: the turn ended at the agent's last moment.
  const pinned = taskFigure(state, { at: now, byPerson: true })

  for (const reading of readings) {
    const shown = titlesBefore[reading.id] ?? reading.id
    if (reading.kind === 'unreadable') {
      unreadable.push(`«${shown}» (${reading.reason})`)
      continue
    }
    const title = titleOf(state, reading.id)
    if (title !== shown) changes.push(`«${shown}» renamed «${title}»`)
    const status = reading.kind === 'gone' ? 'gone' : statusOf(state, reading)
    if (status === null) continue
    const record = recordOf(state, reading.id, now)
    if (status === 'gone' || status === 'archived') {
      record.archivedAt = now
      changes.push(`«${title}»: ${status === 'gone' ? 'deleted' : 'archived'} in Pragma, left out of the menu`)
    } else {
      const wasClosed = isClosed(record)
      record.status = status
      if (wasClosed !== (status === 'closed')) changes.push(`«${title}»: ${status === 'closed' ? 'closed' : 'reopened'} in Pragma`)
    }
    if (status !== 'open' && state.task?.id === reading.id) {
      state.task = null
      const unlogged = pinned?.id === reading.id ? pinned.unloggedMinutes : 0
      changes.push(
        `«${title}» was the pinned task: no longer pinned${unlogged > 0 ? `; its ${hm(unlogged)} unlogged go to the agent, to log at its next turn` : ''}`,
      )
      context = pinnedTaskNote(reading.id, title, status === 'closed', unlogged)
    }
  }
  // A need closed or gone with no task pinned under it leaves the pin, as a close would.
  const need = state.need === null ? undefined : state.tasks[state.need.id]
  if (state.task === null && need !== undefined && (isClosed(need) || need.archivedAt !== undefined)) state.need = null

  const count = `${readings.length} item${readings.length === 1 ? '' : 's'}`
  const lines = [`Pragma menu refreshed: ${count} read again from Pragma.${changes.length === 0 && unreadable.length === 0 ? ' Nothing changed.' : ''}`]
  lines.push(...changes.map(change => `- ${change}`))
  if (unreadable.length > 0) lines.push(`- Not read, left as they were: ${unreadable.join(', ')}`)
  return { text: lines.join('\n'), context }
}

/** What the model is to do with the minutes of a pinned task closed or gone outside the session. */
function pinnedTaskNote(taskId: string, title: string, closed: boolean, unlogged: number): string {
  const what = closed ? 'is closed in Pragma' : 'was archived or deleted in Pragma'
  const minutes =
    unlogged === 0
      ? ''
      : closed
        ? ` Its ${hm(unlogged)} unlogged are not logged yet: first in your next turn, on the task as it is (no reopen), ` +
          `add_time_entry({ activityId: "${taskId}", duration: ${unlogged}, remaining: 0, note: "logged after a close outside the session" }), ` +
          'then one line to the user.'
        : ` Its ${hm(unlogged)} unlogged have no task left: ask the user with AskUserQuestion whether to log them on another ` +
          'task of the need (which one) or drop them.'
  return (
    `Pragma: the pinned task «${title}» (${taskId}) ${what}, outside this session; /${REFRESH_COMMAND} unpinned it.${minutes} ` +
    'Pin a task again before the next file change.'
  )
}
