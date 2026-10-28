// The time-tracking hooks on the module runtime: the protocol in the system prompt, the pin line
// beside each prompt, the gates on tool calls, the tracking of the Pragma calls, the ledger of
// unlogged time across sessions. The state lives in `$.state` (the menu reads it live) and is
// mirrored into `$.store`, so a restarted or resumed session finds it again.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PromptComposeSection } from 'claude-code'

import type { Identity, Mapping, TrackingState } from '../../types'
import { pendingSections, settleQueuedAction } from '../menu/queued'
import { WRITE_TOOLS, gateClose, gateLog, gateWork } from './gates'
import { addMoment, describePin, initialState, isRecord, isTrackingState, loggedMinutes, needFigure, taskFigure, titleOf } from './state'
import { ambiguitySentence, fillProtocol } from './texts'
import { hhmm, hm, isoDay } from './time'
import { TOOL_PREFIX, parseAnswer, track } from './track'

const INTERIM_NUDGE_MINUTES = 30
const LEDGER_THRESHOLD_MINUTES = 5
const RETENTION_DAYS = 14
const LEDGER_KEY = 'ledger'

const noSession: TrackingState | null = null
/** The session's tracking state; null while the directory is not registered. The menu declares the same reference to read it. */
const sessionAtom = atom({ plugin: 'pragma', key: 'session' } as const, noSession)

// The directory's registration and the person, read from ~/.claude/pragma at the session's
// start and at each prompt: the setup skill writes them mid-session.
let mapping: Mapping | null = null
let identity: Identity = { actorId: null, taskForShortWork: false }

export function currentMapping(): Mapping | null {
  return mapping
}

function sessionKey(sessionId: string): string {
  return `session:${sessionId}`
}

async function nowSeconds($: EngineInterface): Promise<number> {
  return (await $.clock.now()) / 1000
}

async function readJson($: EngineInterface, path: string): Promise<unknown> {
  try {
    return JSON.parse(await $.fs.read(path))
  } catch {
    return null
  }
}

function parseIdentity(value: unknown): Identity {
  const record = isRecord(value) ? value : null
  const actorId = record?.['actorId']
  const preferences = record?.['preferences']
  return {
    actorId: typeof actorId === 'string' && actorId !== '' ? actorId : null,
    taskForShortWork: isRecord(preferences) && preferences['taskForShortWork'] === true,
  }
}

function parseMapping(directory: string, entry: Record<string, unknown>): Mapping {
  const organizationId = entry['organizationId']
  const organizationName = entry['organizationName']
  const defaultProjects: Mapping['defaultProjects'] = {}
  const declared = entry['defaultProjects']
  if (isRecord(declared)) {
    for (const [kind, project] of Object.entries(declared)) {
      if (!isRecord(project)) continue
      const id = project['id']
      const title = project['title']
      if (typeof id === 'string' && typeof title === 'string') defaultProjects[kind] = { id, title }
    }
  }
  return {
    directory,
    organizationId: typeof organizationId === 'string' ? organizationId : null,
    organizationName: typeof organizationName === 'string' ? organizationName : null,
    defaultProjects,
  }
}

/** A directory and every parent of it, up to the root. */
function ancestorsOf(path: string): string[] {
  const paths = [path]
  let current = path
  while (current !== '/' && current !== '') {
    current = current.replace(/\/[^/]*$/, '')
    paths.push(current === '' ? '/' : current)
  }
  return paths
}

/** The session's working directory as the file system has it: symbolic links followed, as the registration was written. */
async function realCwd($: EngineInterface): Promise<string> {
  const cwd = await $.session.cwd()
  const stat = await $.fs.stat(cwd, { resolve: true }).catch(() => null)
  return stat?.realPath ?? cwd
}

/** The directories a registration may be keyed by: the git root when there is one, the working directory, their parents. */
async function directoryCandidates($: EngineInterface): Promise<string[]> {
  const candidates: string[] = []
  const repository = await $.session.repo().catch(() => null)
  if (repository !== null) candidates.push(repository.root)
  const cwd = await $.session.cwd()
  for (const base of [await realCwd($), cwd]) candidates.push(...ancestorsOf(base))
  return [...new Set(candidates)]
}

/**
 * The registration of the nearest registered directory (a key of repositories.json that is the
 * working directory or one of its parents) and the person; null when none is registered, or
 * when PRAGMA_TIME_GATE is off.
 */
export async function refreshRegistration($: EngineInterface): Promise<Mapping | null> {
  mapping = null
  const gate = await $.env.get('PRAGMA_TIME_GATE')
  if (gate?.toLowerCase() === 'off') return null
  const home = (await $.env.get('HOME')) ?? ''
  identity = parseIdentity(await readJson($, `${home}/.claude/pragma/identity.json`))
  const registrations = await readJson($, `${home}/.claude/pragma/repositories.json`)
  if (!isRecord(registrations)) return null
  for (const candidate of await directoryCandidates($)) {
    const entry = registrations[candidate]
    if (isRecord(entry)) {
      mapping = parseMapping(candidate, entry)
      break
    }
  }
  return mapping
}

/** The session's state, restored from the store after a restart; null while the directory is not registered. */
export async function loadState($: EngineInterface): Promise<TrackingState | null> {
  if (mapping === null) return null
  const sessionId = await $.session.id()
  const current = await read($, sessionAtom)
  if (current !== null && current.sessionId === sessionId) {
    current.actorId = identity.actorId
    return current
  }
  const stored = await $.store.get(sessionKey(sessionId))
  const state = isTrackingState(stored) && stored.sessionId === sessionId ? stored : initialState(sessionId, mapping, identity.actorId, await nowSeconds($))
  state.actorId = identity.actorId
  return state
}

export async function saveState($: EngineInterface, state: TrackingState): Promise<void> {
  state.updatedAt = await nowSeconds($)
  await update($, sessionAtom, () => state)
  await $.store.set(sessionKey(state.sessionId), state)
}

/** The states of sessions nobody has resumed for RETENTION_DAYS leave the store. */
async function pruneStore($: EngineInterface, now: number): Promise<void> {
  for (const key of await $.store.keys()) {
    if (!key.startsWith('session:')) continue
    const stored = await $.store.get(key)
    if (!isTrackingState(stored) || now - stored.updatedAt > RETENTION_DAYS * 86_400) await $.store.delete(key)
  }
}

// ---------------------------------------------------------------- ledger

type LedgerRow = {
  sessionId: string
  directory: string
  needId: string | null
  needTitle: string | null
  taskId: string | null
  taskTitle: string | null
  workingMinutes: number
  loggedMinutes: number
  unloggedMinutes: number
  date: string
  updatedAt: number
}

function isLedgerRow(value: unknown): value is LedgerRow {
  return isRecord(value) && typeof value['sessionId'] === 'string' && typeof value['directory'] === 'string' && typeof value['unloggedMinutes'] === 'number' && typeof value['updatedAt'] === 'number'
}

async function readLedger($: EngineInterface): Promise<LedgerRow[]> {
  const stored = await $.store.get(LEDGER_KEY)
  return Array.isArray(stored) ? stored.filter(isLedgerRow) : []
}

/** The session's row of the ledger of unlogged time: what the need has been worked on, minus what was logged. */
async function upsertLedger($: EngineInterface, state: TrackingState, now: number, byPerson: boolean): Promise<void> {
  const rows = (await readLedger($)).filter(row => now - row.updatedAt < RETENTION_DAYS * 86_400 && row.sessionId !== state.sessionId)
  if (state.need !== null || state.task !== null) {
    const working = needFigure(state, { at: now, byPerson }).minutes
    const logged = loggedMinutes(state)
    rows.push({
      sessionId: state.sessionId,
      directory: state.directory,
      needId: state.need?.id ?? null,
      needTitle: state.need === null ? null : titleOf(state, state.need.id),
      taskId: state.task?.id ?? null,
      taskTitle: state.task === null ? null : titleOf(state, state.task.id),
      workingMinutes: working,
      loggedMinutes: logged,
      unloggedMinutes: Math.max(0, working - logged),
      date: isoDay(now),
      updatedAt: now,
    })
  }
  await $.store.set(LEDGER_KEY, rows)
}

async function ledgerReminders($: EngineInterface, directory: string, sessionId: string): Promise<string[]> {
  return (await readLedger($))
    .filter(row => row.directory === directory && row.sessionId !== sessionId && row.unloggedMinutes >= LEDGER_THRESHOLD_MINUTES)
    .map(
      row =>
        `- ${row.date}: ~${hm(row.unloggedMinutes)} unlogged on «${row.taskTitle ?? '?'}» (${row.taskId ?? 'no task id'}) under ` +
        `«${row.needTitle ?? '?'}» — log it (dateOfWork ${row.date}) or say why not.`,
    )
}

// ---------------------------------------------------------------- the lines for the model

/** The pin and its figures, read beside each prompt. */
function promptLine(state: TrackingState, now: number): string {
  const pin = describePin(state, mapping)
  if (pin === null) {
    return (
      'Pragma: no task pinned. Work that changes files needs a pin first (need → task → transition to in_progress, see the protocol ' +
      'in the system prompt); answering a question needs none.'
    )
  }
  const closing = { at: now, byPerson: true }
  const need = needFigure(state, closing)
  const task = taskFigure(state, closing)
  const taskPart =
    task === null
      ? ''
      : ` Task: ${hm(task.unloggedMinutes)} unlogged since ${task.sinceLastEntry ? 'its last time entry' : 'it started counting'} ` +
        `(${hhmm(task.since)})${task.ambiguousMinutes > 0 ? `, +${hm(task.ambiguousMinutes)} ambiguous` : ''}.`
  const nudge =
    task !== null && task.unloggedMinutes >= INTERIM_NUDGE_MINUTES
      ? ` Over ${INTERIM_NUDGE_MINUTES} minutes unlogged: log an interim entry first — add_time_entry({ activityId: "${task.id}", ` +
        `duration: ${task.unloggedMinutes}, remaining: <minutes left or 0>, note: "interim" }) — then one line to the user.` +
        ambiguitySentence(task.ambiguous)
      : ''
  const ambiguous = need.ambiguousMinutes > 0 ? ` (+${hm(need.ambiguousMinutes)} in ambiguous turns or gaps: ask before logging them)` : ''
  return (
    `Pragma pin: ${pin}.${taskPart} Need, since it was first pinned: ${hm(need.minutes)} working${ambiguous}, ` +
    `${hm(loggedMinutes(state))} logged this session.${nudge} Different work than the pin? Log the current task, then re-pin.`
  )
}

/** The variables a command's paths may name. The engine reads variables by literal name only: any other is left unresolved. */
async function shellVariables($: EngineInterface, cwd: string): Promise<Record<string, string>> {
  const variables: Record<string, string> = { PWD: cwd }
  const home = await $.env.get('HOME')
  if (home !== undefined) variables['HOME'] = home
  const temporary = await $.env.get('TMPDIR')
  if (temporary !== undefined) variables['TMPDIR'] = temporary
  const user = await $.env.get('USER')
  if (user !== undefined) variables['USER'] = user
  return variables
}

/** The keys the engine carries on a tool.call event beside the tool's own arguments. */
const RESERVED_KEYS: ReadonlySet<string> = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent'])

/** The tool's own arguments: what a repeated call repeats, the id of the call left out. */
function argumentsOf(event: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(event).filter(([key]) => !RESERVED_KEYS.has(key)))
}

/** The reason to refuse a call, or null when it goes through. */
async function gate($: EngineInterface, state: TrackingState, tool: string, fields: Record<string, unknown>, now: number): Promise<string | null> {
  if (WRITE_TOOLS.has(tool)) {
    if (state.task !== null || state.workGateOpen || mapping === null) return null
    const cwd = await realCwd($)
    return gateWork(state, { tool, fields, cwd, root: mapping.directory, variables: await shellVariables($, cwd) })
  }
  if (tool === `${TOOL_PREFIX}transition_manageable`) return gateClose(state, fields, now)
  if (tool === `${TOOL_PREFIX}add_time_entry`) return gateLog(state, fields)
  return null
}

// ---------------------------------------------------------------- the hooks

// One hook per event without a matcher is the engine's rule: the menu's parts (its queued
// actions, its redraw) ride on the tracking's hooks.
export function registerTracking(on: On): void {
  on('session.start', async ($, e, next) => {
    await refreshRegistration($)
    const state = await loadState($)
    if (state !== null) {
      // Opening or resuming a session is the person's moment: the first prompt is written from there.
      const now = await nowSeconds($)
      addMoment(state, { at: now, byPerson: true })
      await saveState($, state)
      void pruneStore($, now)
    }
    // the menu's figures move with the clock even while nothing is written
    $.clock.every(60_000, () => $.ui.invalidate('ui.render'))
    return next(e)
  })

  // The protocol rides the system prompt: every request, compaction included.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const sections: PromptComposeSection[] = []
    if (mapping !== null) {
      sections.push({ id: 'pragma:protocol', scope: 'session', text: fillProtocol(mapping, identity) })
      const reminders = await ledgerReminders($, mapping.directory, await $.session.id())
      if (reminders.length > 0) {
        sections.push({ id: 'pragma:unlogged', scope: 'session', text: `Unlogged time from previous sessions in this directory:\n${reminders.join('\n')}` })
      }
    }
    sections.push(...(await pendingSections($)))
    return sections.length === 0 ? composed : { sections: [...composed.sections, ...sections] }
  })

  // A prompt of the person's is their moment: it ends the gap, and the pin line rides beside it.
  on('prompt.submit', async ($, e, next) => {
    if (e.isMeta === true || (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge')) return next(e)
    await refreshRegistration($)
    const state = await loadState($)
    if (state === null) return next(e)
    const now = await nowSeconds($)
    addMoment(state, { at: now, byPerson: true })
    state.workGateOpen = false // an override of the work gate holds for one turn
    await saveState($, state)
    return next({ ...e, context: [...(e.context ?? []), promptLine(state, now)] })
  })

  // The gates before a call; after it, the call is the agent's moment in the turn (an answered
  // question, the person's), and a Pragma call is tracked.
  on('tool.call', async ($, e, next) => {
    const state = await loadState($)
    if (state === null) return next(e)
    const fields = argumentsOf(e)
    if (WRITE_TOOLS.has(e.tool) || e.tool.startsWith(TOOL_PREFIX)) {
      const denial = await gate($, state, e.tool, fields, await nowSeconds($))
      await saveState($, state)
      if (denial !== null) return { deny: denial }
    }
    const result = await next(e)
    const settled = await loadState($)
    if (settled === null) return result
    const after = await nowSeconds($)
    const answered = result.deny === undefined && result.isError !== true
    addMoment(settled, { at: after, byPerson: answered && e.tool === 'AskUserQuestion' })
    let context: string | null = null
    if (answered && e.tool.startsWith(TOOL_PREFIX)) {
      context = track(settled, mapping, e.tool, fields, parseAnswer(result.text), after)
      await settleQueuedAction($, e.tool, fields)
    }
    await saveState($, settled)
    if (context === null || result.deny !== undefined) return result
    return { ...result, context: [...(result.context ?? []), context] }
  })

  // The end of a turn is the agent's last moment in it; the ledger takes a snapshot.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const state = await loadState($)
    if (state === null) return next(e)
    const now = await nowSeconds($)
    addMoment(state, { at: now, byPerson: false })
    await saveState($, state)
    await upsertLedger($, state, now, false)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    const state = await loadState($)
    if (state !== null) await upsertLedger($, state, await nowSeconds($), true) // the person ends the session
    return next(e)
  })
}
