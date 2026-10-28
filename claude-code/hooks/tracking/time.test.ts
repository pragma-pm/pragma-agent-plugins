import { expect, test } from 'claude-code/testing'

import { hm, spansOf, withMoment, working } from './time'

const minutes = (count: number): number => count * 60

test("the person's moment opens a turn, the agent's extends the current one", async () => {
  let turns = withMoment([], { at: 0, byPerson: true })
  turns = withMoment(turns, { at: minutes(5), byPerson: false })
  turns = withMoment(turns, { at: minutes(3), byPerson: false })
  expect(turns).toEqual([{ start: 0, last: minutes(5) }])
  turns = withMoment(turns, { at: minutes(8), byPerson: true })
  expect(spansOf(turns, { at: minutes(10), byPerson: false })).toEqual([
    { start: 0, end: minutes(5), kind: 'turn' },
    { start: minutes(5), end: minutes(8), kind: 'gap' },
    { start: minutes(8), end: minutes(10), kind: 'turn' },
  ])
})

test('each turn and each gap is judged whole: counted, ambiguous or dropped', async () => {
  // turn 0→10 counted; gap 10→35 (25 min) ambiguous; turn 35→80 (45 min) dropped; gap 80→85 and turn 85→90 counted
  const turns = [
    { start: 0, last: minutes(10) },
    { start: minutes(35), last: minutes(80) },
    { start: minutes(85), last: minutes(85) },
  ]
  const { seconds, ambiguous } = working(turns, 0, { at: minutes(90), byPerson: false })
  expect(seconds).toBe(minutes(10 + 5 + 5))
  expect(ambiguous).toEqual([{ start: minutes(10), end: minutes(35), kind: 'gap' }])
})

test('a span is judged on its whole length, then clipped to where the count starts', async () => {
  const turns = [
    { start: 0, last: minutes(10) },
    { start: minutes(35), last: minutes(40) },
  ]
  const { seconds, ambiguous } = working(turns, minutes(30), { at: minutes(40), byPerson: false })
  expect(seconds).toBe(minutes(5))
  expect(ambiguous).toEqual([{ start: minutes(30), end: minutes(35), kind: 'gap' }])
})

test("closing by the person judges the gap since the agent stopped; closing by the agent, the turn so far", async () => {
  const turns = [{ start: 0, last: minutes(10) }]
  // the person reads for 15 minutes: counted
  expect(working(turns, 0, { at: minutes(25), byPerson: true }).seconds).toBe(minutes(25))
  // away for 40 minutes: the gap is dropped, the turn stays
  expect(working(turns, 0, { at: minutes(50), byPerson: true }).seconds).toBe(minutes(10))
  // the agent still at it after 50 minutes: a turn nobody watched
  expect(working(turns, 0, { at: minutes(50), byPerson: false }).seconds).toBe(0)
})

test('every figure carries its units', async () => {
  expect(hm(12)).toBe('12m')
  expect(hm(125)).toBe('2h05m')
})
