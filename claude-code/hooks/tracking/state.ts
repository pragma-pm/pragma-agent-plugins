// The session's tracking state and the figures read off it: where a pin counts from, what a
// task has unlogged, what the need has been worked on.

import type { Mapping, Pin, Span, TaskRecord, TimeEntry, TrackingState } from '../../types'
import { spanMinutes, spansOf, working, type Moment } from './time'

export const ACTIVITY_TYPES: ReadonlySet<string> = new Set(['task', 'meeting'])
export const NEED_TYPES: ReadonlySet<string> = new Set(['requirement', 'issue'])
export const CLOSING_CATEGORIES: ReadonlySet<string> = new Set(['in_review', 'done'])

export function initialState(sessionId: string, mapping: Mapping, actorId: string | null, now: number): TrackingState {
  return {
    sessionId,
    startedAt: now,
    directory: mapping.directory,
    organizationId: mapping.organizationId,
    actorId,
    need: null,
    task: null,
    titles: {},
    types: {},
    projects: {},
    projectOf: {},
    needOf: {},
    lastNeedSeen: null,
    stateCategories: {},
    tasks: {},
    timeEntries: [],
    assigned: {},
    turns: [],
    settledAt: 0,
    warnedCalls: [],
    workGateOpen: false,
    updatedAt: now,
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A stored value is this session's state when it carries the fields every write keeps. */
export function isTrackingState(value: unknown): value is TrackingState {
  return (
    isRecord(value) &&
    typeof value['sessionId'] === 'string' &&
    typeof value['startedAt'] === 'number' &&
    Array.isArray(value['turns']) &&
    Array.isArray(value['timeEntries']) &&
    isRecord(value['tasks'])
  )
}

export function manageableType(id: string): string | null {
  return /^manageable_([a-z_]+)__/.exec(id)?.[1] ?? null
}

export function titleOf(state: TrackingState, id: string, fallback?: string): string {
  return state.titles[id] ?? fallback ?? (id === '' ? '?' : id)
}

/** The item's record, created on first sight: `seenAt` is where a close with no pin counts from. */
export function recordOf(state: TrackingState, id: string, now: number): TaskRecord {
  const record = (state.tasks[id] ??= {})
  record.seenAt ??= now
  return record
}

/** Where a pinned need or task starts counting; pins older than `countedFrom` start at the pin. */
export function countedFrom(pin: Pin | TaskRecord | null | undefined): number | null {
  return pin?.countedFrom ?? pin?.pinnedAt ?? null
}

export function addMoment(state: TrackingState, moment: Moment): void {
  const current = state.turns[state.turns.length - 1]
  if (current === undefined || moment.byPerson) state.turns.push({ start: moment.at, last: moment.at })
  else current.last = Math.max(current.last, moment.at)
}

/**
 * Where a task pinned now starts counting. A task still pinned owns the time until now. Otherwise
 * the new task takes the current turn and the gap before it — the person writing the prompt, from
 * the session opening for the first one — minus what a time entry or a closed task already
 * accounts for. Unpinned turns before that (answering a question) stay unlogged.
 */
export function countingStart(state: TrackingState, now: number): number {
  if (state.task !== null) return now
  const spans = spansOf(state.turns, { at: now, byPerson: false })
  const gapBefore = spans.length > 1 ? spans[spans.length - 2] : spans[0]
  const accounted = state.timeEntries.map(entry => entry.at)
  for (const task of Object.values(state.tasks)) if (task.closedAt !== undefined) accounted.push(task.closedAt)
  return Math.max(gapBefore?.start ?? now, ...accounted)
}

/** The task's last time entry, else where its pin started counting; `logged` says which. */
export function unloggedSince(state: TrackingState, activityId: string): { since: number | null; logged: boolean } {
  const entries = state.timeEntries.filter(entry => entry.activityId === activityId).map(entry => entry.at)
  const pinStart = countedFrom(state.tasks[activityId]) ?? 0
  const since = Math.max(...entries, pinStart)
  return { since: since > 0 ? since : null, logged: entries.length > 0 }
}

export type MinutesSince = { minutes: number; ambiguous: Span[] }

/** The certain working minutes since `since`, and the ambiguous spans, the timeline closed by `closing`. */
export function minutesSince(state: TrackingState, since: number, closing: Moment): MinutesSince {
  const { seconds, ambiguous } = working(state.turns, since, closing)
  return { minutes: Math.round(seconds / 60), ambiguous }
}

export type TaskFigure = {
  id: string
  /** The minutes the next time entry will carry. */
  unloggedMinutes: number
  ambiguousMinutes: number
  ambiguous: Span[]
  since: number
  sinceLastEntry: boolean
}

/**
 * The pinned task's own figure: the minutes the next time entry will carry, counted from the
 * task's last time entry, else from where its pin started counting. Null while no task is pinned.
 */
export function taskFigure(state: TrackingState, closing: Moment): TaskFigure | null {
  if (state.task === null) return null
  const { since, logged } = unloggedSince(state, state.task.id)
  if (since === null) return null
  // A deleted entry settles what came before it: the user decided, nothing re-asks.
  const from = Math.max(since, state.settledAt)
  const { minutes, ambiguous } = minutesSince(state, from, closing)
  return { id: state.task.id, unloggedMinutes: minutes, ambiguousMinutes: spanMinutes(ambiguous), ambiguous, since: from, sinceLastEntry: logged }
}

export type NeedFigure = { minutes: number; ambiguousMinutes: number; ambiguous: Span[] }

/** The working minutes since the need started counting (else since the session started). */
export function needFigure(state: TrackingState, closing: Moment): NeedFigure {
  const since = countedFrom(state.need) ?? state.startedAt
  const { seconds, ambiguous } = working(state.turns, since, closing)
  // A time entry settles the spans before it: the protocol asks the user before logging.
  const settledBefore = Math.max(state.settledAt, ...state.timeEntries.map(entry => entry.at))
  const open = ambiguous.filter(span => span.end > settledBefore)
  return { minutes: Math.round(seconds / 60), ambiguousMinutes: spanMinutes(open), ambiguous: open }
}

export function loggedMinutes(state: TrackingState, activityId?: string): number {
  return state.timeEntries.filter(entry => activityId === undefined || entry.activityId === activityId).reduce((sum, entry) => sum + entry.duration, 0)
}

export function isAssigned(state: TrackingState, activityId: string, actorId: string): boolean {
  return (state.assigned[activityId] ?? []).includes(actorId)
}

export function recordAssignment(state: TrackingState, activityId: string | null, actorId: string | null): void {
  if (activityId === null || activityId === '' || actorId === null || actorId === '') return
  const workers = (state.assigned[activityId] ??= [])
  if (!workers.includes(actorId)) workers.push(actorId)
}

export function entryById(state: TrackingState, entryId: string | null): TimeEntry | undefined {
  return entryId === null ? undefined : [...state.timeEntries].reverse().find(entry => entry.id === entryId)
}

export function latestEntryOf(state: TrackingState, activityId: string | null): TimeEntry | undefined {
  return activityId === null ? undefined : [...state.timeEntries].reverse().find(entry => entry.activityId === activityId)
}

export function projectTitle(state: TrackingState, mapping: Mapping | null, manageableId: string): string {
  const projectId = state.projectOf[manageableId]
  if (projectId === undefined) return ''
  const fromDefaults = Object.values(mapping?.defaultProjects ?? {}).find(project => project.id === projectId)?.title
  return state.projects[projectId] ?? fromDefaults ?? ''
}

/** `task «T» under requirement «N» (Project)`, or one side of it; null while nothing is pinned. */
export function describePin(state: TrackingState, mapping: Mapping | null): string | null {
  const parts: string[] = []
  if (state.task !== null) parts.push(`task «${titleOf(state, state.task.id)}»`)
  if (state.need !== null) {
    const project = projectTitle(state, mapping, state.need.id)
    parts.push(`${manageableType(state.need.id) ?? 'need'} «${titleOf(state, state.need.id)}»${project === '' ? '' : ` (${project})`}`)
  }
  return parts.length === 0 ? null : parts.join(' under ')
}
