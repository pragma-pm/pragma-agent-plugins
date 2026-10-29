import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// The Pragma button in the band above the prompt, and the minutes at the end of the hint row
// under it, drawn through the engine.

const HOME = '/home/me'
const DIRECTORY = '/home/me/clients/acme'
const ELSEWHERE = '/home/me/personal'
const TASK = 'manageable_task__t1'
const BRAND = '#875ec6'
const HINT = { isDraft: false, isWorking: false, hint: '? for shortcuts' }
const BAND = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 19 }, view: {} }

const FILES: Record<string, string> = {
  [`${HOME}/.claude/pragma/identity.json`]: JSON.stringify({ actorId: 'actor__me' }),
  [`${HOME}/.claude/pragma/directories.json`]: JSON.stringify({
    [DIRECTORY]: { organizationId: 'organization__o', organizationName: 'Org', defaultProjects: { improvement: { id: 'project__p', title: 'Improvements' } } },
  }),
}

/** What Pragma answers a call, by tool. */
function pragmaAnswer(tool: string, fields: Record<string, unknown>): unknown {
  switch (tool) {
    case 'mcp__pragma__available_transitions':
      return { currentStateId: 'ws_todo', currentCategory: 'todo', transitions: [{ toStateId: 'ws_prog', toCategory: 'in_progress', allowed: true }] }
    case 'mcp__pragma__transition_manageable':
      return { id: fields['id'], newStateId: fields['toStateId'], transitioned: true }
    default:
      return { id: TASK, type: 'task', title: 'Fix the token check', created: true }
  }
}

function engine(on: On, cwd: string): void {
  mock.env(on, { HOME })
  mock.store(on)
  // a real moment: a pin counted from 0 reads as no pin
  mock.clock(on, { now: Date.UTC(2026, 9, 29, 9) })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: cwd }))
  on('session.repo', () => ({ value: null }))
  on('fs.read', (_, e) => {
    const text = FILES[e.path]
    if (text === undefined) throw new Error(`no such file: ${e.path}`)
    return { value: text }
  })
  on('fs.stat', (_, e) => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', (_, e) => {
    const fields: Record<string, unknown> = e
    const answer = pragmaAnswer(e.tool, fields)
    return { result: answer, text: JSON.stringify(answer) }
  })
  // the engine's own drawing of the hint row: its line, then the tail a hook added
  on('ui.render', { component: 'PromptHint' }, (_, e) => ({
    type: 'Text',
    children: [e.props.tail === undefined ? e.props.hint : `${e.props.hint} · ${e.props.tail}`],
  }))
  // the engine's own band: empty
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', children: [] }))
}

async function createTask($: Engine): Promise<void> {
  await $.tool.call({
    tool: 'mcp__pragma__create_manageable',
    organizationId: 'organization__o',
    item: { type: 'task', projectId: 'project__p', title: 'Fix the token check', assignedActorIds: ['actor__me'] },
  })
}

test('in a registered directory the button is there from the session start, uncolored until the session touches a Pragma item', async ($, on) => {
  engine(on, DIRECTORY)
  await $.session.start({ cwd: DIRECTORY, surface: 'terminal', isInteractive: true })

  const fresh = await $.ui.mount({ plugin: 'pragma', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const inactive = await fresh.find({ type: 'Text', text: /Pragma ▾/ })
  expect(inactive?.props['dimColor']).toBe(true)
  expect(inactive?.props['color']).toBeUndefined()

  await fresh.press({ key: 'pragma' })
  expect(await fresh.find({ text: /No Pragma item in this session yet/ })).toBeDefined()

  await createTask($)
  const touched = await $.ui.mount({ plugin: 'pragma', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await touched.find({ type: 'Text', text: /Pragma/ }))?.props['color']).toBe(BRAND)
  expect(await touched.find({ text: /No Pragma item in this session yet/ })).toBeUndefined()
})

test('the band yields to a survey', async ($, on) => {
  engine(on, DIRECTORY)
  await $.session.start({ cwd: DIRECTORY, surface: 'terminal', isInteractive: true })

  const band = await $.ui.mount({ plugin: 'pragma', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, hasSurvey: true } })
  expect(await band.find({ key: 'pragma' })).toBeUndefined()
})

test('the hint row stays the engine\'s, the pinned task\'s unlogged minutes at its end', async ($, on) => {
  engine(on, DIRECTORY)
  await $.session.start({ cwd: DIRECTORY, surface: 'terminal', isInteractive: true })

  const unpinned = await $.ui.mount({ plugin: 'pragma', surface: 'terminal', component: 'PromptHint', props: HINT })
  expect(await unpinned.find({ text: /^\? for shortcuts$/ })).toBeDefined()

  await createTask($)
  await $.tool.call({ tool: 'mcp__pragma__available_transitions', id: TASK })
  await $.tool.call({ tool: 'mcp__pragma__transition_manageable', id: TASK, toStateId: 'ws_prog' })
  const pinned = await $.ui.mount({ plugin: 'pragma', surface: 'terminal', component: 'PromptHint', props: HINT })
  expect(await pinned.find({ key: 'pragma' })).toBeUndefined()
  expect(await pinned.find({ text: /^\? for shortcuts · ◷ \d+m unlogged on the task$/ })).toBeDefined()
})

test('outside a registered directory the band and the hint row are the engine\'s own', async ($, on) => {
  engine(on, ELSEWHERE)
  await $.session.start({ cwd: ELSEWHERE, surface: 'terminal', isInteractive: true })

  const band = await $.ui.mount({ plugin: 'pragma', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ key: 'pragma' })).toBeUndefined()
  const row = await $.ui.mount({ plugin: 'pragma', surface: 'terminal', component: 'PromptHint', props: HINT })
  expect(await row.find({ text: /^\? for shortcuts$/ })).toBeDefined()
})
