// The session's time, as the hooks count it. The session alternates the agent's turns (from one
// of the person's moments to the agent's last entry before the next one) and the person's gaps
// (reading the answer, writing the next prompt). Each is judged whole, in three tiers.

import type { Span, Turn } from '../../types'

/** Up to this long, the person was there: waiting, reading, writing. */
export const COUNTED_SPAN_MINUTES = 20
/** At least this long, the person was away: an unwatched turn, a break. */
export const DROPPED_SPAN_MINUTES = 35
// A span between the two is ambiguous: the agent asks the user whether to log it.

/** A moment of the session: the person's (a prompt, a slash command, an answer) or the agent's. */
export type Moment = { at: number; byPerson: boolean }

export type Working = { seconds: number; ambiguous: Span[] }

/** The timeline after one more moment: the person's opens a turn, the agent's extends the current one. */
export function withMoment(turns: readonly Turn[], moment: Moment): Turn[] {
  const current = turns[turns.length - 1]
  if (current === undefined || moment.byPerson) return [...turns, { start: moment.at, last: moment.at }]
  return [...turns.slice(0, -1), { start: current.start, last: Math.max(current.last, moment.at) }]
}

/**
 * The turns and gaps of a timeline closed by `closing`: the person's moment (a prompt being
 * submitted, the session ending, the figure shown while they read) or the agent's (a hook firing
 * in a turn).
 */
export function spansOf(turns: readonly Turn[], closing: Moment): Span[] {
  const timeline = withMoment(turns, closing)
  const spans: Span[] = []
  timeline.forEach((turn, index) => {
    spans.push({ start: turn.start, end: turn.last, kind: 'turn' })
    const next = timeline[index + 1]
    if (next !== undefined) spans.push({ start: turn.last, end: next.start, kind: 'gap' })
  })
  return spans
}

/**
 * The seconds counted after `since`, and the ambiguous spans. Each turn and each gap is judged
 * whole, then clipped to `since`: up to COUNTED_SPAN it counts; at least DROPPED_SPAN it is
 * dropped entirely; in between it is ambiguous, returned for the agent to ask about.
 */
export function working(turns: readonly Turn[], since: number, closing: Moment): Working {
  let seconds = 0
  const ambiguous: Span[] = []
  for (const span of spansOf(turns, closing)) {
    const start = Math.max(span.start, since)
    if (span.end <= start) continue
    const length = span.end - span.start
    if (length <= COUNTED_SPAN_MINUTES * 60) seconds += span.end - start
    else if (length < DROPPED_SPAN_MINUTES * 60) ambiguous.push({ start, end: span.end, kind: span.kind })
  }
  return { seconds, ambiguous }
}

export function spanMinutes(spans: readonly Span[]): number {
  return Math.round(spans.reduce((sum, span) => sum + span.end - span.start, 0) / 60)
}

export function describeSpans(spans: readonly Span[]): string {
  return spans.map(span => `${span.kind} ${hhmm(span.start)}→${hhmm(span.end)} (${Math.round((span.end - span.start) / 60)} min)`).join(', ')
}

/** Local wall-clock time of an epoch in seconds, `16:05`. */
export function hhmm(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** `12m`, `2h05m`: every figure carries its units. */
export function hm(minutes: number): string {
  const whole = Math.round(minutes)
  return whole >= 60 ? `${Math.floor(whole / 60)}h${String(whole % 60).padStart(2, '0')}m` : `${whole}m`
}

/** The day of an epoch in seconds, `2026-10-28`, local time. */
export function isoDay(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
