import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// The Pragma button in the hint row under the prompt, drawn through the engine.

const HOME = '/home/me'
const DIRECTORY = '/home/me/clients/acme'
const ELSEWHERE = '/home/me/personal'
const BRAND = '#875ec6'
const HINT = { isDraft: false, isWorking: false, hint: '? for shortcuts' }

const FILES: Record<string, string> = {
  [`${HOME}/.claude/pragma/identity.json`]: JSON.stringify({ actorId: 'actor__me' }),
  [`${HOME}/.claude/pragma/directories.json`]: JSON.stringify({
    [DIRECTORY]: { organizationId: 'organization__o', organizationName: 'Org', defaultProjects: { improvement: { id: 'project__p', title: 'Improvements' } } },
  }),
}

function engine(on: On, cwd: string): void {
  mock.env(on, { HOME })
  mock.store(on)
  mock.clock(on)
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
  on('tool.call', () => {
    const answer = { id: 'manageable_task__t1', type: 'task', title: 'Fix the token check', created: true }
    return { result: answer, text: JSON.stringify(answer) }
  })
}

test('in a registered directory the button is there from the session start, uncolored until the session touches a Pragma item', async ($, on) => {
  engine(on, DIRECTORY)
  await $.session.start({ cwd: DIRECTORY, surface: 'terminal', isInteractive: true })

  const fresh = await $.ui.mount({ plugin: 'pragma', surface: 'terminal', component: 'PromptHint', props: HINT })
  const inactive = await fresh.find({ type: 'Text', text: /Pragma ▾/ })
  expect(inactive?.props['dimColor']).toBe(true)
  expect(inactive?.props['color']).toBeUndefined()

  await fresh.press({ key: 'pragma' })
  expect(await fresh.find({ text: /No Pragma item in this session yet/ })).toBeDefined()

  await $.tool.call({
    tool: 'mcp__pragma__create_manageable',
    organizationId: 'organization__o',
    item: { type: 'task', projectId: 'project__p', title: 'Fix the token check', assignedActorIds: ['actor__me'] },
  })
  const touched = await $.ui.mount({ plugin: 'pragma', surface: 'terminal', component: 'PromptHint', props: HINT })
  expect((await touched.find({ type: 'Text', text: /Pragma/ }))?.props['color']).toBe(BRAND)
  expect(await touched.find({ text: /No Pragma item in this session yet/ })).toBeUndefined()
})

test('outside a registered directory the hint row is the engine\'s own', async ($, on) => {
  engine(on, ELSEWHERE)
  // the engine's own drawing of the row
  on('ui.render', { component: 'PromptHint' }, (_, e) => ({ type: 'Text', children: [e.props.hint] }))
  await $.session.start({ cwd: ELSEWHERE, surface: 'terminal', isInteractive: true })

  const row = await $.ui.mount({ plugin: 'pragma', surface: 'terminal', component: 'PromptHint', props: HINT })
  expect(await row.find({ key: 'pragma' })).toBeUndefined()
  expect(await row.find({ text: HINT.hint })).toBeDefined()
})
