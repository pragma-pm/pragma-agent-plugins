import { atom, read, update } from 'claude-code'
import type { BoxHoverProps, EngineInterface, Register, TextHoverProps, ToolCallArgs } from 'claude-code'

import type { Editing, ObjectKind, Pending, PragmaObject, SessionEntry, TrackingState } from '../types'
import { withoutKey } from './menu/queued'
import { currentMapping, registerTracking } from './tracking/hooks'
import { taskFigure } from './tracking/state'
import { APP_URL } from './tracking/texts'

// The plugin's time-tracking hooks (`tracking/`, beside this file) keep the session's Pragma
// objects (the pinned need and task, every item it touched, the time entries) in `$.state`.
// This module draws one `Pragma` button in the hint row under the prompt; pressed, a menu of
// those objects hangs under it. An entry opens its page in the browser. A task's logged minutes
// can be adjusted, and a task deleted with its minutes moved to the previous task: the press
// runs the Pragma calls through the engine's tool call; one the engine refuses is queued as a
// user-role row the model carries out at its next turn.

const GLYPH = '◷' // ◷ WHITE CIRCLE WITH UPPER RIGHT QUADRANT
const BRAND = '#875ec6' // the webapp's --color-purple-500; a 256-color terminal draws xterm 98
const MENU_LIMIT = 200 // objects kept from the session state
const MENU_ROWS = 10 // objects the menu shows at first, and per `show more` press: the hint area does not scroll
const ADJUST_STEP = 5 // minutes per press

// Cells the engine's mode pill takes before this tree in the hint row, separator included
// (`▸▸ auto mode on · `), by permission mode.
const PILL_WIDTH: Record<string, number> = {
  auto: '▸▸ auto mode on · '.length,
  acceptEdits: '⏵⏵ accept edits on · '.length,
  plan: '⏸ plan mode on · '.length,
  bypassPermissions: '⏵⏵ bypass permissions on · '.length,
}

const KIND_ORDER: readonly ObjectKind[] = ['project', 'requirement', 'issue', 'task', 'other']

// The state library wants each reference written in the file that reads it: `pending`,
// `hidden` and `session` are declared again where the tracking hooks write them.
const noEditing: Editing | null = null
const noDeleting: string | null = null
const noPending: Record<string, Pending> = {}
const noHidden: string[] = []
const noSession: TrackingState | null = null
const initialRowLimit: number = MENU_ROWS
const menuOpen = atom({ plugin: 'pragma', key: 'menuOpen' } as const, false)
const editing = atom({ plugin: 'pragma', key: 'editing' } as const, noEditing)
const deleting = atom({ plugin: 'pragma', key: 'deleting' } as const, noDeleting)
const pending = atom({ plugin: 'pragma', key: 'pending' } as const, noPending)
const hidden = atom({ plugin: 'pragma', key: 'hidden' } as const, noHidden)
const session = atom({ plugin: 'pragma', key: 'session' } as const, noSession)
const rowLimit = atom({ plugin: 'pragma', key: 'rowLimit' } as const, initialRowLimit)

type Session = {
  objects: PragmaObject[]
  // The pinned task's minutes not yet logged, null while no task is pinned.
  unloggedMinutes: number | null
  ambiguousMinutes: number
  loggedTodayMinutes: number
  nowSeconds: number
  permissionMode: string | null
}

function shorten(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`
}

function separated(text: string): string {
  return text === '' ? '' : ` · ${text}`
}

// `12m`, `2h51m`: every figure carries its units.
function hm(minutes: number): string {
  const whole = Math.round(minutes)
  return whole >= 60 ? `${Math.floor(whole / 60)}h${String(whole % 60).padStart(2, '0')}m` : `${whole}m`
}

function kindOf(id: string): ObjectKind {
  if (id.startsWith('project__')) return 'project'
  const match = /^manageable_([a-z_]+)__/.exec(id)
  const kind = match?.[1]
  return kind === 'requirement' || kind === 'issue' || kind === 'task' ? kind : 'other'
}

function urlOf(id: string): string {
  return kindOf(id) === 'project' ? `${APP_URL}/projects/${id}` : `${APP_URL}/items/${id}`
}

function loggedTodayMinutes(entries: readonly { duration: number; at: number }[], nowSeconds: number): number {
  const today = new Date(nowSeconds * 1000).toDateString()
  return entries
    .filter(entry => new Date(entry.at * 1000).toDateString() === today)
    .reduce((sum, entry) => sum + entry.duration, 0)
}

// The session's time entries per object: a task's own; a need's, those of its tasks (the
// hooks keep task → need in `needOf`).
function entriesByObject(state: TrackingState): Record<string, SessionEntry[]> {
  const entries: Record<string, SessionEntry[]> = {}
  for (const entry of state.timeEntries) {
    const sessionEntry: SessionEntry = { id: entry.id, duration: entry.duration, at: entry.at }
    ;(entries[entry.activityId] ??= []).push(sessionEntry)
    const needId = state.needOf[entry.activityId]
    if (needId !== undefined) (entries[needId] ??= []).push(sessionEntry)
  }
  return entries
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function dayLabel(atSeconds: number, nowSeconds: number): string {
  const startOfDay = (date: Date): number => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const day = new Date(atSeconds * 1000)
  const daysAgo = Math.round((startOfDay(new Date(nowSeconds * 1000)) - startOfDay(day)) / 86_400_000)
  if (daysAgo === 0) return 'today'
  if (daysAgo === 1) return 'yesterday'
  return `${day.getDate()} ${MONTHS[day.getMonth()]}`
}

// The days the work was logged on, oldest first; nothing when it is all today's.
function workDaysLabel(entries: readonly SessionEntry[], nowSeconds: number): string {
  const moments = entries.map(entry => entry.at).sort((a, b) => a - b)
  const labels = [...new Set(moments.map(moment => dayLabel(moment, nowSeconds)))]
  if (labels.length === 0 || (labels.length === 1 && labels[0] === 'today')) return ''
  const text = labels.join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function collectObjects(state: TrackingState): PragmaObject[] {
  const pinnedIds = new Set([state.need?.id, state.task?.id].filter((id): id is string => typeof id === 'string'))
  const closedIds = new Set(Object.entries(state.tasks).filter(([, task]) => task.closedAt !== undefined).map(([id]) => id))
  const entries = entriesByObject(state)
  const titles: Record<string, string> = { ...state.titles }
  const defaultProjects = Object.values(currentMapping()?.defaultProjects ?? {})
  for (const projectId of Object.values(state.projectOf)) {
    titles[projectId] ??= state.projects[projectId] ?? defaultProjects.find(project => project.id === projectId)?.title ?? projectId
  }
  const objects = Object.entries(titles).filter(([id]) => state.tasks[id]?.archivedAt === undefined).map(([id, title]): PragmaObject => {
    const own = entries[id] ?? []
    return {
      kind: kindOf(id), id, title, url: urlOf(id), isPinned: pinnedIds.has(id), isClosed: closedIds.has(id),
      pinnedAt: state.tasks[id]?.pinnedAt ?? null,
      needId: state.needOf[id] ?? null,
      entries: own,
      loggedMinutes: own.reduce((sum, entry) => sum + entry.duration, 0),
    }
  })
  const rank = (object: PragmaObject): number =>
    KIND_ORDER.indexOf(object.kind) * 4 + (object.isPinned ? 0 : object.isClosed ? 2 : 1)
  return objects.sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title)).slice(0, MENU_LIMIT)
}

// The labels of the engine's mode pills as its SessionMode site last drew them (`auto mode on`,
// `plan mode on`, …): the hint row reads them for the width of the pill before its tree.
let modeLabels: readonly string[] = []

function permissionMode(labels: readonly string[]): string | null {
  const text = labels.join(' ')
  if (text.includes('auto mode')) return 'auto'
  if (text.includes('accept edits')) return 'acceptEdits'
  if (text.includes('plan mode')) return 'plan'
  if (text.includes('bypass')) return 'bypassPermissions'
  return null
}

async function readSession($: EngineInterface): Promise<Session> {
  const state = await read($, session)
  if (state === null) return { objects: [], unloggedMinutes: null, ambiguousMinutes: 0, loggedTodayMinutes: 0, nowSeconds: 0, permissionMode: null }
  const nowSeconds = (await $.clock.now()) / 1000
  // The figure shown while the person reads: the turn ended at the agent's last moment, the gap since is judged by the hooks' rule.
  const figure = taskFigure(state, { at: nowSeconds, byPerson: true })
  return {
    nowSeconds,
    permissionMode: permissionMode(modeLabels),
    objects: collectObjects(state),
    unloggedMinutes: figure?.unloggedMinutes ?? null,
    ambiguousMinutes: figure?.ambiguousMinutes ?? 0,
    loggedTodayMinutes: loggedTodayMinutes(state.timeEntries, nowSeconds),
  }
}

async function openInBrowser($: EngineInterface, url: string): Promise<void> {
  const opened = await $.process.run(['open', url]).catch(() => null)
  if (opened?.exitCode === 0) return
  const fallback = await $.process.run(['xdg-open', url]).catch(() => null)
  if (fallback?.exitCode !== 0) $.ui.toast(`Could not open ${url}`)
}

// Every figure says what it counts: the pinned task's unlogged minutes, the day's logged ones.
function taskLabel(session: Session): string {
  if (session.unloggedMinutes === null) return ''
  const ambiguous = session.ambiguousMinutes > 0 ? ` (+${hm(session.ambiguousMinutes)} ambiguous)` : ''
  return `${hm(session.unloggedMinutes)} unlogged on the task${ambiguous}`
}

function timeLabel(session: Session): string {
  const parts = [taskLabel(session), `${hm(session.loggedTodayMinutes)} logged today`]
  return parts.filter(part => part !== '').join(' · ')
}

const SECTION_TITLE: Record<ObjectKind, string> = {
  project: 'Project', requirement: 'Requirements', issue: 'Issues', task: 'Tasks', other: 'Other',
}

type Section = { kind: ObjectKind; objects: PragmaObject[] }

// The objects grouped by kind, in KIND_ORDER, the empty kinds left out; `limit` rows in all.
function sections(objects: readonly PragmaObject[], limit: number): Section[] {
  const kept = objects.slice(0, limit)
  return KIND_ORDER.map(kind => ({ kind, objects: kept.filter(object => object.kind === kind) })).filter(
    section => section.objects.length > 0,
  )
}

// Footer link badges made from Pragma titles outlive their setting until /clear; the engine
// flattens them into the hint text, so the row leaves those parts out.
function hintWithoutPragmaBadges(hint: string, objects: readonly PragmaObject[]): string {
  const isPragmaTitle = (part: string): boolean => {
    const text = part.replace(/…$/, '')
    return text.length >= 4 && objects.some(object => object.title.startsWith(text))
  }
  return hint
    .split(' · ')
    .map(part => part.trim())
    .filter(part => part !== '' && !isPragmaTitle(part))
    .join(' · ')
    .replace(/\s*·\s*$/, '')
}

// A task's row joins the hover group of the need it answers; the need's title lights while any
// row of the group is under the pointer. The surface applies it, no hook runs.
function needGroup(object: PragmaObject): { hover?: BoxHoverProps } {
  return object.kind === 'task' && object.needId !== null ? { hover: { scope: object.needId } } : {}
}

function needHighlight(object: PragmaObject): { hover?: TextHoverProps } {
  return object.kind === 'requirement' || object.kind === 'issue' ? { hover: { scope: object.id, color: BRAND, bold: true } } : {}
}

// ---------------------------------------------------------------- menu actions

// The task the deleted one's minutes go to: the task of the same need pinned last before it,
// else the task pinned last before it, else none.
function previousTask(objects: readonly PragmaObject[], task: PragmaObject): PragmaObject | null {
  const before = objects
    .filter(object => object.kind === 'task' && object.id !== task.id && object.pinnedAt !== null)
    .filter(object => task.pinnedAt === null || (object.pinnedAt ?? 0) < task.pinnedAt)
    .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0))
  return before.find(object => object.needId === task.needId) ?? before[0] ?? null
}

type EntryChange = { id: string | null; from: number; to: number }

// The delta applied to the latest entry first; a cut larger than it carries on to the earlier ones.
function adjustedEntries(entries: readonly SessionEntry[], delta: number): EntryChange[] {
  const latestFirst = [...entries].sort((a, b) => b.at - a.at)
  const changes: EntryChange[] = []
  let remaining = delta
  for (const entry of latestFirst) {
    if (remaining === 0) break
    const to = Math.max(0, entry.duration + remaining)
    remaining -= to - entry.duration
    changes.push({ id: entry.id, from: entry.duration, to })
  }
  return changes
}

function entryReference(id: string | null): string {
  return id ?? 'id unknown: read it with get_time_entries for today'
}

function adjustInstruction(task: PragmaObject, changes: readonly EntryChange[], target: number): string {
  const steps = changes
    .map(change => change.to === 0
      ? `delete_time_entry({ activityId: "${task.id}", timeEntryId: "${entryReference(change.id)}" }) (was ${change.from}; a dropped entry is deleted, never set to 0)`
      : `update_time_entry({ activityId: "${task.id}", timeEntryId: "${entryReference(change.id)}", duration: ${change.to} }) (was ${change.from})`)
    .join('; then ')
  return (
    `Pragma menu action, pressed by the user in the Pragma menu of the pragma plugin: set the time logged this session on ` +
    `task «${task.title}» (${task.id}) from ${hm(task.loggedMinutes)} to ${hm(target)}. Do it first, before the rest ` +
    `of the turn: ${steps}. Then one line to the user: "Adjusted «${task.title}»: ${hm(task.loggedMinutes)} → ${hm(target)}".`
  )
}

function deleteInstruction(task: PragmaObject, target: PragmaObject | null): string {
  const minutes = hm(task.loggedMinutes)
  const move =
    target === null
      ? ''
      : ` First move its ${minutes} logged this session to task «${target.title}» (${target.id}): ` +
        `add_time_entry({ activityId: "${target.id}", duration: ${task.loggedMinutes}, remaining: 0, ` +
        `note: "re-allocated from the deleted task «${task.title}»" }), then delete each entry of the deleted task: ` +
        task.entries.map(entry => `delete_time_entry({ activityId: "${task.id}", timeEntryId: "${entryReference(entry.id)}" })`).join(', ') +
        '.'
  const pin = task.isPinned ? ' It was the pinned task: nothing is pinned afterwards, pin again before the next file change.' : ''
  return (
    `Pragma menu action, pressed by the user in the Pragma menu of the pragma plugin: delete task «${task.title}» (${task.id}).` +
    move +
    ` Then delete_manageable({ id: "${task.id}" }) (archive_manageable if the delete is refused).${pin}` +
    ` Do it first, before the rest of the turn, then one line to the user saying what was done.`
  )
}

async function queueAction($: EngineInterface, taskId: string, kind: Pending['kind'], label: string, text: string): Promise<void> {
  const result = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  if (result.deny !== undefined) {
    $.ui.toast(`Pragma: ${label} refused: ${result.deny}`)
    return
  }
  const action: Pending = { kind, label, state: 'queued' }
  await update($, pending, queued => ({ ...queued, [taskId]: action }))
  $.ui.toast(`Pragma: ${label}, runs at the next turn`)
}

// ---------------------------------------------------------------- calls on the press

// The press runs the Pragma call itself, through the engine's tool call: the hooks above
// see it (the time-tracking hooks record it), the permission check reads the press as the
// user's consent, then the tool runs. Null when it went through; else why not, in one line.
async function callPragma($: EngineInterface, input: ToolCallArgs): Promise<string | null> {
  try {
    const outcome = await $.tool.call(input)
    if (outcome.deny !== undefined) return outcome.deny
    if (outcome.isError === true) return outcome.text ?? 'the tool reported an error'
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function markRunning($: EngineInterface, taskId: string, kind: Pending['kind'], label: string): Promise<void> {
  const action: Pending = { kind, label, state: 'running' }
  await update($, pending, actions => ({ ...actions, [taskId]: action }))
}

async function clearPending($: EngineInterface, taskId: string): Promise<void> {
  await update($, pending, actions => withoutKey(actions, taskId))
}

// A call the engine refused or that failed: the rest of the action rides a user-role row to
// the model's next turn.
async function fallBack($: EngineInterface, taskId: string, kind: Pending['kind'], label: string, reason: string, text: string): Promise<void> {
  $.ui.toast(`Pragma: ${label} did not go through (${shorten(reason, 80)})`)
  await clearPending($, taskId)
  await queueAction($, taskId, kind, label, text)
}

async function adjustLogged($: EngineInterface, task: PragmaObject, delta: number): Promise<void> {
  const target = Math.max(0, task.loggedMinutes + delta)
  const label = `adjust «${shorten(task.title, 40)}» to ${hm(target)}`
  const consent = `The user pressed "OK" in the Pragma menu to set the time logged this session on task «${task.title}» from ${hm(task.loggedMinutes)} to ${hm(target)}`
  await markRunning($, task.id, 'adjust', label)
  const changes = adjustedEntries(task.entries, delta)
  for (const [index, change] of changes.entries()) {
    // An entry brought to nothing is deleted, never kept at 0 minutes.
    const failure =
      change.id === null
        ? 'the entry has no id in the session state'
        : change.to === 0
          ? await callPragma($, { tool: 'mcp__pragma__delete_time_entry', activityId: task.id, timeEntryId: change.id, consent })
          : await callPragma($, { tool: 'mcp__pragma__update_time_entry', activityId: task.id, timeEntryId: change.id, duration: change.to, consent })
    if (failure !== null) {
      await fallBack($, task.id, 'adjust', label, failure, adjustInstruction(task, changes.slice(index), target))
      return
    }
  }
  await clearPending($, task.id)
  $.ui.toast(`Adjusted «${shorten(task.title, 40)}»: ${hm(task.loggedMinutes)} → ${hm(target)}`)
}

async function deleteTask($: EngineInterface, task: PragmaObject, target: PragmaObject | null): Promise<void> {
  const label = `delete «${shorten(task.title, 40)}»`
  const minutes = hm(task.loggedMinutes)
  const pressed = target === null ? (task.loggedMinutes > 0 ? `Drop its ${minutes}` : 'Delete') : `Move its ${minutes} to «${target.title}»`
  const consent = `The user pressed "${pressed}" in the Pragma menu to delete task «${task.title}»`
  const fail = (reason: string): Promise<void> => fallBack($, task.id, 'delete', label, reason, deleteInstruction(task, target))
  await markRunning($, task.id, 'delete', label)
  if (target !== null && task.loggedMinutes > 0) {
    const moved = await callPragma($, {
      tool: 'mcp__pragma__add_time_entry',
      activityId: target.id,
      duration: task.loggedMinutes,
      remaining: 0,
      note: `re-allocated from the deleted task «${task.title}»`,
      consent,
    })
    if (moved !== null) return fail(moved)
  }
  for (const entry of task.entries) {
    if (entry.id === null) continue
    const removed = await callPragma($, { tool: 'mcp__pragma__delete_time_entry', activityId: task.id, timeEntryId: entry.id, consent })
    if (removed !== null) return fail(removed)
  }
  const deleted = await callPragma($, { tool: 'mcp__pragma__delete_manageable', id: task.id, consent })
  if (deleted !== null) {
    const archived = await callPragma($, { tool: 'mcp__pragma__archive_manageable', id: task.id, consent })
    if (archived !== null) return fail(`${deleted}; archive: ${archived}`)
  }
  await update($, hidden, ids => (ids.includes(task.id) ? ids : [...ids, task.id]))
  await clearPending($, task.id)
  $.ui.toast(
    target === null
      ? `Deleted «${shorten(task.title, 40)}»`
      : `Deleted «${shorten(task.title, 40)}», ${minutes} moved to «${shorten(target.title, 40)}»`,
  )
}

// ---------------------------------------------------------------- hooks

export const register: Register = on => {
  // session.start, prompt.compose, prompt.submit, tool.call, turn.complete, session.end: one
  // hook per event is the engine's rule, and the tracking owns them; the menu's parts ride there.
  registerTracking(on)

  on('ui.render', { component: 'SessionMode' }, (_, e, next) => {
    modeLabels = e.props.modes
    return next(e)
  })

  // The dim hint row under the prompt: the Pragma button first, the engine's text after it.
  // While the menu is open, the rows under the button list the session's Pragma objects by
  // kind, the way a dropdown hangs under its control; an entry opens its page and the menu
  // stays open until the button is pressed again.
  // In a registered directory the button is there from the session start, so a person who just
  // ran the setup finds it; it stays uncolored until the session touches a Pragma item. Outside
  // one the hooks are inert and the row is the engine's own.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const session = await readSession($)
    const hiddenIds = await read($, hidden)
    const objects = session.objects.filter(object => !hiddenIds.includes(object.id))
    const isActive = objects.length > 0
    if (!isActive && currentMapping() === null) return next(e)

    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const isOpen = await read($, menuOpen)
    const toggle = (): void => void update($, menuOpen, open => !open)
    const hint = hintWithoutPragmaBadges(e.props.hint, objects)

    // The engine's own hint keeps its place; the button follows it. The menu rows below start
    // at the tree's left edge whatever the button's place in the row.
    // The engine's mode pill sits before this tree; the menu rows are pulled back under it by
    // its width, the first row padded by as much so it keeps its place after the pill.
    const pill = hint.includes('shift+tab') ? (PILL_WIDTH[session.permissionMode ?? ''] ?? 0) : 0
    const row = (
      <Box flexDirection="row" paddingLeft={isOpen ? pill : 0}>
        <Text dimColor>{hint === '' ? '' : `${hint} · `}</Text>
        <Button key="pragma" plain onPress={toggle}>
          <Text {...(isActive ? { color: BRAND } : { dimColor: true })}>{GLYPH} Pragma {isOpen ? '▴' : '▾'}</Text>
        </Button>
        <Text dimColor>{separated(isOpen ? timeLabel(session) : taskLabel(session))}</Text>
      </Box>
    )
    if (!isOpen) return row

    const edit = await read($, editing)
    const confirming = await read($, deleting)
    const queued = await read($, pending)
    const limit = await read($, rowLimit)
    // Another surface (desktop) draws native links; the terminal draws buttons.
    const drawsNativeLinks = e.surface !== 'terminal'
    const shown = sections(objects, limit)
    const shownObjects = shown.flatMap(section => section.objects)
    const notShown = objects.length - shownObjects.length
    const titleWidth = Math.max(0, ...shownObjects.map(object => shorten(object.title, 64).length))
    const daysWidth = Math.max(0, ...shownObjects.map(object => workDaysLabel(object.entries, session.nowSeconds).length))

    const startEditing = (task: PragmaObject): void => {
      void update($, deleting, () => null)
      void update($, editing, () => ({ taskId: task.id, delta: 0 }))
    }
    const startDeleting = (task: PragmaObject): void => {
      void update($, editing, () => null)
      void update($, deleting, () => task.id)
    }
    const cancel = (): void => {
      void update($, editing, () => null)
      void update($, deleting, () => null)
    }
    const confirmAdjust = (task: PragmaObject, delta: number): void => {
      cancel()
      if (delta === 0) return
      void adjustLogged($, task, delta)
    }
    const confirmDelete = (task: PragmaObject, target: PragmaObject | null): void => {
      cancel()
      void deleteTask($, task, target)
    }

    // The columns after a title: the minutes (`30m`, or `30m (25m)` while adjusting), the days;
    // each padded to the widest shown, so the controls line up.
    const figures = (object: PragmaObject, delta: number | null): string => {
      const title = shorten(object.title, 64)
      const pad = ' '.repeat(titleWidth - title.length)
      const logged = (object.loggedMinutes > 0 ? hm(object.loggedMinutes) : '').padStart(6)
      const adjusted = delta === null ? '' : ` (${hm(Math.max(0, object.loggedMinutes + delta))})`
      const days = delta === null ? workDaysLabel(object.entries, session.nowSeconds) : ''
      const daysColumn = daysWidth === 0 ? '' : `  ${days.padEnd(daysWidth)}`
      return `${pad}  ${logged}${adjusted}${daysColumn}`
    }

    const entry = (object: PragmaObject): JSX.Element => {
      const title = shorten(object.title, 64)
      const isTask = object.kind === 'task'
      const isEditing = edit !== null && edit.taskId === object.id
      const isConfirming = confirming === object.id
      const action = queued[object.id]
      const delta = isEditing ? edit.delta : null

      const marker = object.isPinned ? (
        <Text color="success">● </Text>
      ) : object.isClosed ? (
        <Text dimColor>✓ </Text>
      ) : (
        <Text>  </Text>
      )
      const name = drawsNativeLinks ? (
        <Link href={object.url} label={title} />
      ) : (
        <Button key={object.id} plain dimColor={object.isClosed} label={title} onPress={() => void openInBrowser($, object.url)} {...needHighlight(object)} />
      )

      let controls: JSX.Element = <Text></Text>
      if (action !== undefined) {
        const isRunning = action.state === 'running'
        const verb = action.kind === 'adjust' ? (isRunning ? 'adjusting…' : 'adjustment queued') : isRunning ? 'deleting…' : 'deletion queued'
        // `dismiss` clears a queued tag the model never answered; the row itself stays in the transcript.
        controls = (
          <Box flexDirection="row">
            <Text dimColor>{`  · ${verb}${isRunning ? '' : '  '}`}</Text>
            {isRunning ? (
              <Text></Text>
            ) : (
              <Button key={`${object.id}:dismiss`} plain dimColor label="dismiss" onPress={() => void update($, pending, actions => withoutKey(actions, object.id))} />
            )}
          </Box>
        )
      } else if (isEditing) {
        controls = (
          <Box flexDirection="row">
            <Text>  </Text>
            <Button key={`${object.id}:minus`} plain label={`−${ADJUST_STEP}`} onPress={() => void update($, editing, () => ({ taskId: object.id, delta: (delta ?? 0) - ADJUST_STEP }))} />
            <Text>  </Text>
            <Button key={`${object.id}:plus`} plain label={`+${ADJUST_STEP}`} onPress={() => void update($, editing, () => ({ taskId: object.id, delta: (delta ?? 0) + ADJUST_STEP }))} />
            <Text>  </Text>
            <Button key={`${object.id}:ok`} plain label="OK" onPress={() => confirmAdjust(object, delta ?? 0)} />
            <Text>  </Text>
            <Button key={`${object.id}:cancel`} plain dimColor label="Cancel" onPress={cancel} />
          </Box>
        )
      } else if (isTask && !isConfirming) {
        controls = (
          <Box flexDirection="row">
            <Text>  </Text>
            {object.loggedMinutes > 0 ? <Button key={`${object.id}:adjust`} plain dimColor label="adjust" onPress={() => startEditing(object)} /> : <Text></Text>}
            <Text>{object.loggedMinutes > 0 ? '  ' : ''}</Text>
            <Button key={`${object.id}:delete`} plain dimColor label="delete" onPress={() => startDeleting(object)} />
          </Box>
        )
      }

      const line = (
        <Box key={object.id} flexDirection="row" {...needGroup(object)}>
          {marker}
          {name}
          <Text dimColor>{figures(object, delta)}</Text>
          {controls}
        </Box>
      )
      if (!isConfirming) return line

      const target = previousTask(objects, object)
      const minutes = hm(object.loggedMinutes)
      return (
        <Box key={`${object.id}:confirming`} flexDirection="column">
          {line}
          <Box flexDirection="row">
            <Text color="warning">    Delete this task?</Text>
            {object.loggedMinutes > 0 && target !== null ? (
              <Box flexDirection="row">
                <Text>  </Text>
                <Button key={`${object.id}:move`} plain label={`Move its ${minutes} to «${shorten(target.title, 40)}»`} onPress={() => confirmDelete(object, target)} />
                <Text>  </Text>
                <Button key={`${object.id}:drop`} plain label={`Drop its ${minutes}`} onPress={() => confirmDelete(object, null)} />
              </Box>
            ) : (
              <Box flexDirection="row">
                <Text>  </Text>
                <Button key={`${object.id}:confirm`} plain label={object.loggedMinutes > 0 ? `Delete, drop its ${minutes}` : 'Delete'} onPress={() => confirmDelete(object, null)} />
              </Box>
            )}
            <Text>  </Text>
            <Button key={`${object.id}:keep`} plain dimColor label="Cancel" onPress={cancel} />
          </Box>
        </Box>
      )
    }

    const rows = shown.map(section => (
      <Box key={section.kind} flexDirection="column" paddingLeft={2}>
        <Text color={BRAND}>{SECTION_TITLE[section.kind]}</Text>
        <Box flexDirection="column" paddingLeft={2}>
          {section.objects.map(entry)}
        </Box>
      </Box>
    ))
    if (!isActive) {
      rows.push(
        <Box key="empty" flexDirection="row" paddingLeft={2}>
          <Text dimColor>No Pragma item in this session yet: the agent pins a task before its first file change.</Text>
        </Box>,
      )
    }
    // The hint area under the prompt does not scroll: past MENU_ROWS objects the menu pages.
    if (notShown > 0 || limit > MENU_ROWS) {
      rows.push(
        <Box key="paging" flexDirection="row" paddingLeft={2}>
          {notShown > 0 ? <Text dimColor>{`${notShown} more ${notShown === 1 ? 'item' : 'items'} not shown  `}</Text> : <Text></Text>}
          {notShown > 0 ? (
            <Button key="more" plain dimColor label={`show ${Math.min(MENU_ROWS, notShown)} more`} onPress={() => void update($, rowLimit, shownRows => shownRows + MENU_ROWS)} />
          ) : (
            <Text></Text>
          )}
          {limit > MENU_ROWS ? (
            <Box flexDirection="row">
              <Text>{notShown > 0 ? '  ' : ''}</Text>
              <Button key="fewer" plain dimColor label="show fewer" onPress={() => void update($, rowLimit, () => MENU_ROWS)} />
            </Box>
          ) : (
            <Text></Text>
          )}
        </Box>,
      )
    }

    // One blank row between the hint row and the menu.
    return (
      <Box flexDirection="column" marginLeft={-pill}>
        {row}
        <Box flexDirection="column" marginTop={1}>
          {rows}
        </Box>
      </Box>
    )
  })
}

