import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

// The hooks through the engine: nothing sits beneath the plugin but these hooks, which stand
// for the engine and for Pragma.

const HOME = '/home/me'
const DIRECTORY = '/home/me/clients/acme'
const NEED = 'manageable_issue__n1'
const TASK = 'manageable_task__t1'

const FILES: Record<string, string> = {
  [`${HOME}/.claude/pragma/identity.json`]: JSON.stringify({ actorId: 'actor__me' }),
  [`${HOME}/.claude/pragma/directories.json`]: JSON.stringify({
    [DIRECTORY]: { organizationId: 'organization__o', organizationName: 'Org', defaultProjects: { improvement: { id: 'project__p', title: 'Improvements' } } },
  }),
}

/** What Pragma answers a call, by tool. */
function pragmaAnswer(tool: string, fields: Record<string, unknown>): unknown {
  const item = fields['item']
  const kind = typeof item === 'object' && item !== null && 'type' in item ? item.type : undefined
  const title = typeof item === 'object' && item !== null && 'title' in item ? item.title : undefined
  switch (tool) {
    case 'mcp__pragma__create_manageable':
      return { id: kind === 'issue' ? NEED : TASK, type: kind, title, created: true }
    case 'mcp__pragma__create_link':
      return { from: fields['from'], to: fields['to'], linkType: fields['type'], created: true }
    case 'mcp__pragma__available_transitions':
      return {
        currentStateId: 'ws_todo',
        currentCategory: 'todo',
        transitions: [
          { toStateId: 'ws_prog', toCategory: 'in_progress', allowed: true },
          { toStateId: 'ws_done', toCategory: 'done', allowed: true },
        ],
      }
    case 'mcp__pragma__transition_manageable':
      return { id: fields['id'], newStateId: fields['toStateId'], transitioned: true }
    case 'mcp__pragma__add_time_entry':
      return { id: 'time_entry__e1', activityId: fields['activityId'], duration: fields['duration'], created: true }
    default:
      return {}
  }
}

/**
 * What a test's Pragma holds beside `pragmaAnswer`: the organization's projects as `list_projects`
 * answers them, the project titles `get_project` answers by id, the items `get_manageable`
 * answers by id; and the calls it received, by tool.
 */
type Pragma = {
  projects?: { id: string; title: string }[]
  /** How the first `list_projects` calls go wrong, one per call; the later ones answer. */
  outages?: ('error' | 'deny')[]
  sheets?: Record<string, string>
  items?: Record<string, unknown>
  /** The workflows `get_workflow` answers by id. */
  workflows?: Record<string, unknown>
  calls?: string[]
  /** The clock's start, in milliseconds. */
  now?: number
  /** The session's working directory; the registered one by default. */
  cwd?: string
}

/** A need that already exists and its task, as `get_manageable` answers them: their project named by id alone. */
function existingItems(projectId: string): Record<string, unknown> {
  return {
    [NEED]: { id: NEED, manageableType: 'issue', body: { title: 'Login fails' }, scope: { projectIds: [projectId] }, assignees: {} },
    [TASK]: { id: TASK, manageableType: 'task', body: { title: 'Fix the token check' }, scope: { projectIds: [projectId] }, assignees: { actor__me: { isRequest: false } } },
  }
}

function engine(on: On, pragma: Pragma = {}): MockClock {
  mock.env(on, { HOME })
  mock.store(on)
  const clock = mock.clock(on, pragma.now === undefined ? undefined : { now: pragma.now })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: pragma.cwd ?? DIRECTORY }))
  on('session.repo', () => ({ value: null }))
  on('fs.read', (_, e) => {
    const text = FILES[e.path]
    if (text === undefined) throw new Error(`no such file: ${e.path}`)
    return { value: text }
  })
  on('fs.stat', (_, e) => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('tool.call', (_, e) => {
    const fields: Record<string, unknown> = e
    pragma.calls?.push(e.tool)
    if (e.tool === 'mcp__pragma__list_projects') {
      const outage = pragma.outages?.shift()
      if (outage === 'deny') return { deny: 'refused by the permission rules' }
      if (outage === 'error') return { result: null, text: 'the server is not connected', isError: true }
    }
    const id = fields['id']
    // an item Pragma does not hold, once the test says what it holds: deleted
    if (e.tool === 'mcp__pragma__get_manageable' && typeof id === 'string' && pragma.items !== undefined && pragma.items[id] === undefined) {
      return { result: null, text: 'Item not found or access denied.', isError: true }
    }
    const answer =
      e.tool === 'mcp__pragma__list_projects' ? (pragma.projects ?? [])
      : e.tool === 'mcp__pragma__get_manageable' && typeof id === 'string' ? (pragma.items?.[id] ?? {})
      // get_project answers its id under `metadata` and its title under `body`
      : e.tool === 'mcp__pragma__get_project' && typeof id === 'string' ? { metadata: { id }, body: { title: pragma.sheets?.[id] } }
      : e.tool === 'mcp__pragma__get_workflow' && typeof id === 'string' ? (pragma.workflows?.[id] ?? {})
      : e.tool.startsWith('mcp__pragma__') ? pragmaAnswer(e.tool, fields)
      : {}
    return { result: answer, text: JSON.stringify(answer) }
  })
  on('ui.toast', () => ({ value: undefined }))
  return clock
}

/** The agent finds the existing need and its task, as the protocol has it, up to the pin. */
async function findNeed($: Engine): Promise<void> {
  await $.tool.call({ tool: 'mcp__pragma__search', organizationId: 'organization__o', query: 'login fails' })
  await $.tool.call({ tool: 'mcp__pragma__get_manageable', id: NEED })
  await $.tool.call({ tool: 'mcp__pragma__get_manageable', id: TASK })
  await $.tool.call({ tool: 'mcp__pragma__create_link', from: NEED, to: TASK, type: 'has_response' })
  await $.tool.call({ tool: 'mcp__pragma__available_transitions', id: TASK })
}

test('a change under the tracked directory is refused once while nothing is pinned; a file elsewhere never', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: DIRECTORY, surface: 'terminal', isInteractive: true })

  const edit = { tool: 'Edit', file_path: `${DIRECTORY}/src/a.ts`, old_string: 'a', new_string: 'b' } as const
  const refused = await $.tool.call(edit)
  expect(refused.deny).toContain('no task pinned')
  const repeated = await $.tool.call(edit)
  expect(repeated.deny).toBeUndefined()

  const elsewhere = await $.tool.call({ tool: 'Write', file_path: `${HOME}/notes.md`, content: 'x' })
  expect(elsewhere.deny).toBeUndefined()
})

test('a transition to in_progress pins the task; a close is refused until the time is logged, then names the need', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: DIRECTORY, surface: 'terminal', isInteractive: true })

  await $.tool.call({ tool: 'mcp__pragma__create_manageable', organizationId: 'organization__o', item: { type: 'issue', projectId: 'project__p', title: 'Login fails' } })
  await $.tool.call({
    tool: 'mcp__pragma__create_manageable',
    organizationId: 'organization__o',
    item: { type: 'task', projectId: 'project__p', title: 'Fix the token check', assignedActorIds: ['actor__me'] },
  })
  await $.tool.call({ tool: 'mcp__pragma__create_link', from: NEED, to: TASK, type: 'has_response' })
  await $.tool.call({ tool: 'mcp__pragma__available_transitions', id: TASK })

  const pinned = await $.tool.call({ tool: 'mcp__pragma__transition_manageable', id: TASK, toStateId: 'ws_prog' })
  expect(pinned.deny).toBeUndefined()
  expect(pinned.context?.join('\n')).toContain('Pinned task «Fix the token check» under issue «Login fails» (Improvements)')

  // pinned: the directory's files may change
  const edit = await $.tool.call({ tool: 'Edit', file_path: `${DIRECTORY}/src/a.ts`, old_string: 'a', new_string: 'b' })
  expect(edit.deny).toBeUndefined()

  const close = { tool: 'mcp__pragma__transition_manageable', id: TASK, toStateId: 'ws_done' } as const
  const refused = await $.tool.call(close)
  expect(refused.deny).toContain('no time entry on «Fix the token check»')

  const logged = await $.tool.call({ tool: 'mcp__pragma__add_time_entry', activityId: TASK, duration: 12, remaining: 0, note: 'measured' })
  expect(logged.deny).toBeUndefined()
  expect(logged.context?.join('\n')).toContain('Logged 12m on «Fix the token check»')

  const closed = await $.tool.call(close)
  expect(closed.deny).toBeUndefined()
  expect(closed.context?.join('\n')).toContain('The issue it answers, «Login fails», may be complete')
})

test('a time entry on a task the person is not known to be assigned to is refused once', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: DIRECTORY, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__pragma__create_manageable', organizationId: 'organization__o', item: { type: 'task', projectId: 'project__p', title: 'Unassigned' } })

  const entry = { tool: 'mcp__pragma__add_time_entry', activityId: TASK, duration: 5, remaining: 0 } as const
  expect((await $.tool.call(entry)).deny).toContain('actor__me is not known to be assigned')
  expect((await $.tool.call(entry)).deny).toBeUndefined()
})

test('the protocol rides the system prompt, filled for the directory and the person', async ($, on) => {
  engine(on)
  on('prompt.compose', () => ({ sections: [] }))
  await $.session.start({ cwd: DIRECTORY, surface: 'terminal', isInteractive: true })

  const composed = await $.prompt.compose({ model: 'model', promptModel: 'model', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  const protocol = composed.sections.find(section => section.id === 'pragma:protocol')
  expect(protocol?.text).toContain('organization «Org» (`organization__o`)')
  expect(protocol?.text).toContain('actor id is `actor__me`')
  expect(protocol?.text).toContain('«Improvements» (project__p)')
})

test('a need found by search is pinned with its project\'s name, asked of Pragma once', async ($, on) => {
  const calls: string[] = []
  engine(on, { projects: [{ id: 'project__x', title: 'Client Portal' }], items: existingItems('project__x'), calls })
  await $.session.start({ cwd: DIRECTORY, surface: 'terminal', isInteractive: true })
  await findNeed($)

  const pinned = await $.tool.call({ tool: 'mcp__pragma__transition_manageable', id: TASK, toStateId: 'ws_prog' })
  expect(pinned.context?.join('\n')).toContain('Pinned task «Fix the token check» under issue «Login fails» (Client Portal)')
  expect(pinned.context?.join('\n')).toContain('([Client Portal](https://app.pragma.pm/projects/project__x))')
  expect(calls.filter(tool => tool === 'mcp__pragma__list_projects')).toHaveLength(1)
})

test('a default project is named from the registration, without asking Pragma', async ($, on) => {
  const calls: string[] = []
  engine(on, { items: existingItems('project__p'), calls })
  await $.session.start({ cwd: DIRECTORY, surface: 'terminal', isInteractive: true })
  await findNeed($)

  const pinned = await $.tool.call({ tool: 'mcp__pragma__transition_manageable', id: TASK, toStateId: 'ws_prog' })
  expect(pinned.context?.join('\n')).toContain('(Improvements)')
  expect(calls).not.toContain('mcp__pragma__list_projects')
})

test('a project Pragma does not list is asked once, then named by the agent\'s get_project', async ($, on) => {
  const calls: string[] = []
  engine(on, { projects: [], sheets: { project__x: 'Client Portal' }, items: existingItems('project__x'), calls })
  await $.session.start({ cwd: DIRECTORY, surface: 'terminal', isInteractive: true })
  await findNeed($)
  expect(calls.filter(tool => tool === 'mcp__pragma__list_projects')).toHaveLength(1)

  await $.tool.call({ tool: 'mcp__pragma__get_project', id: 'project__x' })
  const pinned = await $.tool.call({ tool: 'mcp__pragma__transition_manageable', id: TASK, toStateId: 'ws_prog' })
  expect(pinned.context?.join('\n')).toContain('(Client Portal)')
})

/** The person sends a prompt from the composer. */
async function typePrompt($: Engine, text: string): Promise<void> {
  await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
}

test('a lookup that failed is asked again at the next call or prompt, which names the project', async ($, on) => {
  const calls: string[] = []
  const lookups = (): number => calls.filter(tool => tool === 'mcp__pragma__list_projects').length
  // the server fails the lookup after each of findNeed's calls from the first get_manageable on: four
  const outages: ('error' | 'deny')[] = ['error', 'error', 'error', 'error']
  engine(on, { projects: [{ id: 'project__x', title: 'Client Portal' }], outages, items: existingItems('project__x'), calls })
  await $.session.start({ cwd: DIRECTORY, surface: 'terminal', isInteractive: true })
  await findNeed($)
  expect(lookups()).toBe(4)

  await typePrompt($, 'go on')
  expect(lookups()).toBe(5)
  const pinned = await $.tool.call({ tool: 'mcp__pragma__transition_manageable', id: TASK, toStateId: 'ws_prog' })
  expect(pinned.context?.join('\n')).toContain('(Client Portal)')
  expect(lookups()).toBe(5)
})

test('a refused lookup is not asked again, neither at the next call nor at the next prompt', async ($, on) => {
  const calls: string[] = []
  engine(on, { projects: [{ id: 'project__x', title: 'Client Portal' }], outages: ['deny'], items: existingItems('project__x'), calls })
  await $.session.start({ cwd: DIRECTORY, surface: 'terminal', isInteractive: true })
  await findNeed($)
  await typePrompt($, 'go on')
  expect(calls.filter(tool => tool === 'mcp__pragma__list_projects')).toHaveLength(1)
})

// ---------------------------------------------------------------- /pragma:refresh

const OTHER_TASK = 'manageable_task__t2'

/** The person types `/pragma:refresh`. */
function runRefresh($: Engine): ReturnType<Engine['command']['run']> {
  return $.command.run({ command: 'pragma:refresh', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
}

/** The issue workflow the session has not seen: its state's category is read from it. */
const ISSUE_WORKFLOW = { id: 'wf_issue', states: [{ id: 'ws_issue_open', category: 'in_progress', manageableStatus: 'active' }] }

test('a refresh reads the menu\'s items again: a task closed elsewhere, a need renamed, an item deleted', async ($, on) => {
  const calls: string[] = []
  const items = existingItems('project__p')
  items[OTHER_TASK] = { id: OTHER_TASK, manageableType: 'task', body: { title: 'Write the release note' }, scope: { projectIds: ['project__p'] }, assignees: {} }
  engine(on, { items, workflows: { wf_issue: ISSUE_WORKFLOW }, calls })
  await $.session.start({ cwd: DIRECTORY, surface: 'terminal', isInteractive: true })
  await findNeed($)
  await $.tool.call({ tool: 'mcp__pragma__get_manageable', id: OTHER_TASK })

  // meanwhile, in the webapp
  items[TASK] = { ...(items[TASK] as object), status: 'inactive', workflowStateId: 'ws_done', workflowId: 'wf_task' }
  items[NEED] = { ...(items[NEED] as object), body: { title: 'Login fails on Safari' }, status: 'active', workflowStateId: 'ws_issue_open', workflowId: 'wf_issue' }
  delete items[OTHER_TASK]

  const refreshed = await runRefresh($)
  expect(refreshed.text).toContain('Pragma menu refreshed: 3 items read again from Pragma.')
  expect(refreshed.text).toContain('«Fix the token check»: closed in Pragma')
  expect(refreshed.text).toContain('«Login fails» renamed «Login fails on Safari»')
  expect(refreshed.text).toContain('«Write the release note»: deleted in Pragma, left out of the menu')
  // the issue's state was unknown: its workflow told its category, open
  expect(calls).toContain('mcp__pragma__get_workflow')
  expect(refreshed.text).not.toContain('«Login fails on Safari»: closed')
  expect(refreshed.context).toBeUndefined()

  // read again with nothing changed
  const again = await runRefresh($)
  expect(again.text).toBe('Pragma menu refreshed: 2 items read again from Pragma. Nothing changed.')
})

test('a task closed in the session and reopened elsewhere reads open again', async ($, on) => {
  const items = existingItems('project__p')
  engine(on, { items })
  await $.session.start({ cwd: DIRECTORY, surface: 'terminal', isInteractive: true })
  await findNeed($)
  await $.tool.call({ tool: 'mcp__pragma__transition_manageable', id: TASK, toStateId: 'ws_prog' })
  await $.tool.call({ tool: 'mcp__pragma__add_time_entry', activityId: TASK, duration: 5, remaining: 0 })
  await $.tool.call({ tool: 'mcp__pragma__transition_manageable', id: TASK, toStateId: 'ws_done' })

  items[TASK] = { ...(items[TASK] as object), status: 'active', workflowStateId: 'ws_todo', workflowId: 'wf_task' }
  items[NEED] = { ...(items[NEED] as object), status: 'active', workflowStateId: 'ws_todo', workflowId: 'wf_issue' }
  const refreshed = await runRefresh($)
  expect(refreshed.text).toContain('«Fix the token check»: reopened in Pragma')
  expect(refreshed.text).not.toContain('«Login fails»')
})

test('a refresh unpins a task closed elsewhere and hands its unlogged minutes to the agent', async ($, on) => {
  const items = existingItems('project__p')
  const clock = engine(on, { items, now: Date.UTC(2026, 10, 3, 9) })
  await $.session.start({ cwd: DIRECTORY, surface: 'terminal', isInteractive: true })
  await typePrompt($, 'fix the login')
  await findNeed($)
  await $.tool.call({ tool: 'mcp__pragma__transition_manageable', id: TASK, toStateId: 'ws_prog' })
  await clock.advance(10 * 60_000)
  await $.tool.call({ tool: 'Edit', file_path: `${DIRECTORY}/src/a.ts`, old_string: 'a', new_string: 'b' })

  items[TASK] = { ...(items[TASK] as object), status: 'inactive', workflowStateId: 'ws_done', workflowId: 'wf_task' }
  const refreshed = await runRefresh($)
  expect(refreshed.text).toContain('«Fix the token check» was the pinned task: no longer pinned; its 10m unlogged go to the agent')
  expect(refreshed.context?.join('\n')).toContain('add_time_entry({ activityId: "manageable_task__t1", duration: 10, remaining: 0')

  // nothing pinned: a change is refused again
  const edit = await $.tool.call({ tool: 'Edit', file_path: `${DIRECTORY}/src/b.ts`, old_string: 'a', new_string: 'b' })
  expect(edit.deny).toContain('no task pinned')
})

test('outside a registered directory the refresh says so', async ($, on) => {
  engine(on, { cwd: `${HOME}/personal` })
  await $.session.start({ cwd: `${HOME}/personal`, surface: 'terminal', isInteractive: true })
  const refreshed = await runRefresh($)
  expect(refreshed.text).toContain('this directory is not tracked')
})
