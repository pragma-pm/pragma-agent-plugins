// Following the Pragma calls the agent makes: which items it touched and their titles, the pin
// (a transition to in_progress), the closes, the time entries. Each call may leave a line for
// the model to read after the tool's result.

import type { Mapping, TrackingState } from '../../types'
import {
  ACTIVITY_TYPES, CLOSING_CATEGORIES, NEED_TYPES, countedFrom, countingStart, describePin, entryById, isRecord,
  latestEntryOf, manageableType, projectTitle, recordAssignment, recordOf, titleOf,
} from './state'
import { itemUrl, markdownLink, projectUrl } from './texts'
import { hm } from './time'

export const TOOL_PREFIX = 'mcp__pragma__'

/** A field of a tool's arguments or answer, as a string; null when absent or not one. */
export function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key]
  return typeof value === 'string' ? value : null
}

function numberField(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key]
  return typeof value === 'number' ? value : typeof value === 'string' && value !== '' && !Number.isNaN(Number(value)) ? Number(value) : null
}

function recordField(record: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  const value = record?.[key]
  return isRecord(value) ? value : null
}

function listField(record: Record<string, unknown> | null, key: string): unknown[] {
  const value = record?.[key]
  return Array.isArray(value) ? value : []
}

/** The JSON a tool answered, as the model reads it; null when it is not JSON. */
export function parseAnswer(text: string | undefined): unknown {
  if (text === undefined) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function rememberProject(state: TrackingState, data: unknown): void {
  if (Array.isArray(data)) {
    for (const item of data) rememberProject(state, item)
    return
  }
  if (!isRecord(data)) return
  const id = stringField(data, 'id')
  const title = stringField(data, 'title')
  if (id !== null && id.startsWith('project__') && title !== null) state.projects[id] = title
}

function rememberCategories(state: TrackingState, data: Record<string, unknown>): void {
  for (const transition of listField(data, 'transitions')) {
    if (!isRecord(transition)) continue
    const toStateId = stringField(transition, 'toStateId')
    const category = stringField(transition, 'toCategory')
    if (toStateId !== null && category !== null) state.stateCategories[toStateId] = category
  }
  for (const workflowState of listField(data, 'states')) {
    if (!isRecord(workflowState)) continue
    const id = stringField(workflowState, 'id')
    const category = stringField(workflowState, 'category')
    if (id !== null && category !== null) state.stateCategories[id] = category
  }
  const currentStateId = stringField(data, 'currentStateId')
  const currentCategory = stringField(data, 'currentCategory')
  if (currentStateId !== null && currentCategory !== null) state.stateCategories[currentStateId] = currentCategory
}

/** A transition of a task or a need: a pin, a close, or neither. The line for the model, if any. */
export function trackTransition(state: TrackingState, mapping: Mapping | null, manageableId: string, toStateId: string, now: number): string | null {
  const category = state.stateCategories[toStateId]
  const type = manageableType(manageableId)
  if (category === 'in_progress' && type !== null && ACTIVITY_TYPES.has(type)) {
    const previous = state.task
    const start = previous?.id === manageableId ? (countedFrom(previous) ?? now) : countingStart(state, now)
    state.task = { id: manageableId, pinnedAt: now, countedFrom: start }
    const record = recordOf(state, manageableId, now)
    record.pinnedAt = now
    record.countedFrom = start
    const needId = state.needOf[manageableId] ?? state.lastNeedSeen
    if (needId !== null && needId !== undefined && state.need?.id !== needId) state.need = { id: needId, pinnedAt: now, countedFrom: start }
    const projectId = needId === null || needId === undefined ? undefined : state.projectOf[needId]
    const project = needId === null || needId === undefined ? '' : projectTitle(state, mapping, needId)
    const needLink = needId === null || needId === undefined ? 'no need linked yet' : markdownLink(titleOf(state, needId), itemUrl(needId))
    const projectPart = project !== '' && projectId !== undefined ? ` (${markdownLink(project, projectUrl(projectId))})` : ''
    return (
      `Pinned ${describePin(state, mapping) ?? ''}. Tell the user in one line, markdown links kept (the footer turns them into badges): ` +
      `"Pinned: ${markdownLink(titleOf(state, manageableId), itemUrl(manageableId))} — ${needLink}${projectPart}".`
    )
  }
  if (category !== undefined && CLOSING_CATEGORIES.has(category) && type !== null && ACTIVITY_TYPES.has(type)) {
    recordOf(state, manageableId, now).closedAt = now
    if (state.task?.id === manageableId) state.task = null
    return needFollowUp(state, manageableId)
  }
  if (category !== undefined && CLOSING_CATEGORIES.has(category) && type !== null && NEED_TYPES.has(type)) {
    recordOf(state, manageableId, now).closedAt = now
    if (state.need?.id === manageableId && state.task === null) state.need = null
  }
  return null
}

/** A task closed: the need it answers may be complete. The agent offers, the user decides. */
export function needFollowUp(state: TrackingState, taskId: string): string | null {
  const needId = state.needOf[taskId]
  if (needId === undefined || state.tasks[needId]?.closedAt !== undefined) return null
  const others = Object.entries(state.needOf)
    .filter(([other, need]) => need === needId && other !== taskId && state.tasks[other]?.archivedAt === undefined)
    .map(([other]) => other)
  const stillOpen = others.filter(other => state.tasks[other]?.closedAt === undefined).map(other => titleOf(state, other))
  const seen =
    stillOpen.length > 0
      ? `${stillOpen.length} other task${stillOpen.length > 1 ? 's' : ''} of it seen this session still open: ${stillOpen.map(title => `«${title}»`).join(', ')}`
      : others.length > 0
        ? 'every other task of it seen this session is closed'
        : 'no other task of it seen this session'
  const kind = manageableType(needId) ?? 'need'
  const article = 'aeiou'.includes(kind.charAt(0)) ? 'an' : 'a'
  return (
    `Task «${titleOf(state, taskId)}» closed. The ${kind} it answers, «${titleOf(state, needId)}», may be complete (${seen}; its tasks ` +
    `outside this session: \`graph_get_neighbors\` on it). Offer to move it: \`available_transitions\` on the ${kind}, then ask the user ` +
    'with the AskUserQuestion tool, never in plain text: one option per allowed transition (Done, In review, …) plus «Leave it as is». ' +
    `Apply the answer with \`transition_manageable\`; the user decides, you never close ${article} ${kind} on your own.`
  )
}

/**
 * One Pragma call answered without error: what the session learns from it, and the line the
 * model reads after the tool's result, if any. `fields` are the call's arguments, `data` the
 * answer parsed from its text.
 */
export function track(state: TrackingState, mapping: Mapping | null, tool: string, fields: Record<string, unknown>, data: unknown, now: number): string | null {
  const name = tool.startsWith(TOOL_PREFIX) ? tool.slice(TOOL_PREFIX.length) : tool
  const answer = isRecord(data) ? data : null

  if ((name === 'available_transitions' || name === 'get_workflow') && answer !== null) {
    rememberCategories(state, answer)
    const id = stringField(fields, 'id')
    if (id !== null) recordOf(state, id, now)
    return null
  }

  if (name === 'create_manageable' && answer !== null) {
    const id = stringField(answer, 'id')
    if (id === null) return null
    state.titles[id] = stringField(answer, 'title') ?? id
    const kind = stringField(answer, 'type') ?? manageableType(id)
    if (kind !== null) state.types[id] = kind
    recordOf(state, id, now)
    const item = recordField(fields, 'item')
    const projectId = stringField(item, 'projectId')
    if (projectId !== null) state.projectOf[id] = projectId
    for (const actorId of listField(item, 'assignedActorIds')) if (typeof actorId === 'string') recordAssignment(state, id, actorId)
    if (kind !== null && NEED_TYPES.has(kind)) state.lastNeedSeen = id
    return null
  }

  if (name === 'get_manageable' && answer !== null) {
    const id = stringField(fields, 'id') ?? stringField(answer, 'id') ?? ''
    if (id === '') return null
    const title = stringField(answer, 'title') ?? stringField(recordField(answer, 'body'), 'title')
    if (title !== null) state.titles[id] = title
    recordOf(state, id, now)
    const scope = recordField(answer, 'scope')
    const scopeProjects = listField(scope, 'projectIds')
    const firstScopeProject = typeof scopeProjects[0] === 'string' ? scopeProjects[0] : null
    const projectId = stringField(answer, 'projectId') ?? stringField(scope, 'projectId') ?? firstScopeProject
    if (projectId !== null) state.projectOf[id] = projectId
    const type = manageableType(id)
    if (type !== null && NEED_TYPES.has(type)) state.lastNeedSeen = id
    // An assignment request still pending is not an assignment.
    for (const [actorId, assignment] of Object.entries(recordField(answer, 'assignees') ?? {})) {
      const pending = isRecord(assignment) && assignment['isRequest'] === true && assignment['accepted'] !== true
      if (!pending) recordAssignment(state, id, actorId)
    }
    return null
  }

  if (name === 'assign_activity' && answer !== null && answer['assigned'] === true) {
    if (answer['isRequest'] === false) {
      recordAssignment(state, stringField(answer, 'activityId') ?? stringField(fields, 'activityId'), stringField(answer, 'workerId') ?? stringField(fields, 'workerId'))
    }
    return null
  }

  if (name === 'create_link') {
    const source = stringField(fields, 'from') ?? ''
    const target = stringField(fields, 'to') ?? ''
    const sourceType = manageableType(source)
    const targetType = manageableType(target)
    if (stringField(fields, 'type') === 'has_response' && sourceType !== null && NEED_TYPES.has(sourceType) && targetType !== null && ACTIVITY_TYPES.has(targetType)) {
      state.needOf[target] = source
      state.lastNeedSeen = source
      recordOf(state, target, now)
    }
    return null
  }

  if (name === 'list_projects' || name === 'get_project' || name === 'create_project') {
    rememberProject(state, data)
    return null
  }

  if ((name === 'archive_manageable' || name === 'delete_manageable') && answer !== null) {
    // The task leaves the session's views (the Pragma menu); a pinned one is unpinned.
    const goneId = stringField(answer, 'id') ?? stringField(fields, 'id')
    if (goneId !== null) {
      recordOf(state, goneId, now).archivedAt = now
      if (state.task?.id === goneId) state.task = null
    }
    return null
  }

  if (name === 'transition_manageable' && answer !== null && answer['transitioned'] === true) {
    return trackTransition(state, mapping, stringField(fields, 'id') ?? '', stringField(fields, 'toStateId') ?? '', now)
  }

  if (name === 'revert_transition' && answer !== null && answer['reverted'] === true) {
    // Undoing a close within the 15-minute window re-pins the task, like a transition would.
    return trackTransition(state, mapping, stringField(answer, 'id') ?? stringField(fields, 'id') ?? '', stringField(answer, 'newStateId') ?? '', now)
  }

  if (name === 'add_time_entry' && answer !== null && answer['created'] === true) {
    const activityId = stringField(answer, 'activityId') ?? stringField(fields, 'activityId') ?? ''
    const duration = Math.trunc(numberField(answer, 'duration') ?? numberField(fields, 'duration') ?? 0)
    state.timeEntries.push({ id: stringField(answer, 'id'), activityId, duration, at: now, note: stringField(fields, 'note') })
    const source = stringField(fields, 'note') ?? 'measured'
    return (
      `Logged ${hm(duration)} on «${titleOf(state, activityId)}». Tell the user in one line, nothing more, markdown link kept: ` +
      `"Logged ${hm(duration)} on ${markdownLink(titleOf(state, activityId), itemUrl(activityId))} (${source})".`
    )
  }

  if (name === 'update_time_entry' && answer !== null && answer['updated'] === true) {
    // A corrected entry replaces the session's record of it: the entry id is the key when
    // known, else the latest entry on that activity.
    const activityId = stringField(answer, 'activityId') ?? stringField(fields, 'activityId') ?? ''
    const entryId = stringField(answer, 'id') ?? stringField(fields, 'timeEntryId')
    let target = entryById(state, entryId) ?? latestEntryOf(state, activityId)
    if (target === undefined) {
      target = { id: entryId, activityId, duration: 0, at: now, note: null }
      state.timeEntries.push(target)
    }
    target.id = entryId
    const duration = numberField(answer, 'duration') ?? numberField(fields, 'duration')
    if (duration !== null) target.duration = Math.trunc(duration)
    const note = stringField(fields, 'note')
    if (note !== null) target.note = note
    return `Corrected the entry on «${titleOf(state, activityId)}» to ${hm(target.duration)}. Tell the user in one line, nothing more.`
  }

  if (name === 'delete_time_entry' && answer !== null && answer['deleted'] === true) {
    // A dropped entry leaves the session's record. The spans it covered stay settled: the user
    // decided about them, so nothing asks about them again.
    const activityId = stringField(answer, 'activityId') ?? stringField(fields, 'activityId') ?? ''
    const target = entryById(state, stringField(answer, 'id') ?? stringField(fields, 'timeEntryId'))
    if (target !== undefined) {
      state.timeEntries = state.timeEntries.filter(entry => entry !== target)
      state.settledAt = Math.max(state.settledAt, target.at)
    }
    return `Deleted ${target === undefined ? 'an entry' : hm(target.duration)} on «${titleOf(state, activityId)}». Tell the user in one line, nothing more.`
  }

  return null
}
