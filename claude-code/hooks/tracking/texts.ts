// What the hooks tell the agent, and the links it is asked to keep.

import type { Identity, Mapping, Span } from '../../types'
import { PROTOCOL } from './protocol'
import { COUNTED_SPAN_MINUTES, DROPPED_SPAN_MINUTES, describeSpans, spanMinutes } from './time'

export const APP_URL = 'https://app.pragma.pm'

/** A gate warns, it does not lock: the person is in charge, not the rule. */
export const OVERRIDE_SENTENCE =
  'A warning, not a lock: when the user wants it done anyway, or the rule does not fit this call, say so to the user in one line ' +
  'and repeat the exact same call — a repeated call goes through.'

// Tasks sized for traceability: a step of a few minutes inside larger work goes on the task it
// serves (the default), or gets a task of its own (the person's preference,
// `preferences.taskForShortWork` in identity.json, asked at setup). Work that is the session's
// whole purpose gets its task either way, however short.
const WHOLE_PURPOSE = 'Work that is the session\'s whole purpose gets its task and its time, however short: a two-minute fix is a task.'
const SHORT_WORK_ON_PREVIOUS_TASK =
  `**Tasks are for traceability, not an audit log.** ${WHOLE_PURPOSE} Within larger work, a step of a few minutes (a rename, a ` +
  'test adjusted, a typo met on the way) is no task of its own: it goes on the task it serves — the pinned one, else the need\'s ' +
  'task closed last. Split larger work where the pieces make sense apart: two hours is typically three or four tasks, never one ' +
  'per edit. A step that changes files on a closed task pins it again (`revert_transition` undoes the close within 15 minutes of ' +
  'it, whatever the workflow allows; later, `transition_manageable` back to in_progress), then log, close it again. Only to log ' +
  'time, never revert nor pin: the entry goes on the closed task as it is (see «Logging time»).'
const SHORT_WORK_ON_OWN_TASK =
  `**A task for every piece of work**, steps of a few minutes included: the person prefers the time split per piece over fewer tasks. ${WHOLE_PURPOSE}`

export function itemUrl(manageableId: string): string {
  return `${APP_URL}/items/${manageableId}`
}

export function projectUrl(projectId: string): string {
  return `${APP_URL}/projects/${projectId}`
}

export function markdownLink(text: string, url: string): string {
  return `[${text}](${url})`
}

/** The protocol for this directory and person. */
export function fillProtocol(mapping: Mapping, identity: Identity): string {
  const defaults = Object.entries(mapping.defaultProjects)
    .map(([kind, project]) => `  - ${kind}: «${project.title}» (${project.id})`)
    .join('\n')
  return PROTOCOL.replaceAll('{organizationId}', mapping.organizationId ?? '?')
    .replaceAll('{organizationName}', mapping.organizationName ?? '?')
    .replaceAll('{directory}', mapping.directory)
    .replaceAll('{actorId}', identity.actorId ?? 'unknown — run /pragma:setup, which finds it through get_me')
    .replaceAll('{defaultProjects}', defaults === '' ? '  (none declared: ask the user once which project, with the organization\'s projects as options)' : defaults)
    .replaceAll('{shortWorkRule}', identity.taskForShortWork ? SHORT_WORK_ON_OWN_TASK : SHORT_WORK_ON_PREVIOUS_TASK)
}

export function ambiguitySentence(spans: readonly Span[]): string {
  if (spans.length === 0) return ''
  return (
    ` Ambiguous spans of ${COUNTED_SPAN_MINUTES}–${DROPPED_SPAN_MINUTES} min, not counted — a turn the person may not have watched, ` +
    `a gap that may have been a break: ${describeSpans(spans)} = ${spanMinutes(spans)} min. Ask the user with AskUserQuestion, ` +
    'one question listing them, options «log them» and «drop them»; then log once.'
  )
}
