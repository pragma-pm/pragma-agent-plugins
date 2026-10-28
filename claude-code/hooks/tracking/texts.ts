// What the hooks tell the agent, and the links it is asked to keep.

import type { Identity, Mapping, Span } from '../../types'
import { PROTOCOL } from './protocol'
import { COUNTED_SPAN_MINUTES, DROPPED_SPAN_MINUTES, describeSpans, spanMinutes } from './time'

export const APP_URL = 'https://app.pragma.pm'

/** A gate warns, it does not lock: the person is in charge, not the rule. */
export const OVERRIDE_SENTENCE =
  'A warning, not a lock: when the user wants it done anyway, or the rule does not fit this call, say so to the user in one line ' +
  'and repeat the exact same call — a repeated call goes through.'

// Work of a few minutes: on the need's previous task (the default), or a task of its own (the
// person's preference, `preferences.taskForShortWork` in identity.json, asked at setup).
const SHORT_WORK_ON_PREVIOUS_TASK =
  '**No task for work of a few minutes**: when the need already has a task, the work goes on its previous one — still pinned, ' +
  'keep it; closed, pin it again (`revert_transition` undoes the close within 15 minutes of it, whatever the workflow allows; ' +
  'later, `transition_manageable` back to in_progress), log, close it again.'
const SHORT_WORK_ON_OWN_TASK =
  '**A task for every piece of work**, a few minutes included: the person prefers the time split per piece over fewer tasks.'

export function itemUrl(manageableId: string): string {
  return `${APP_URL}/items/${manageableId}`
}

export function projectUrl(projectId: string): string {
  return `${APP_URL}/projects/${projectId}`
}

export function markdownLink(text: string, url: string): string {
  return `[${text}](${url})`
}

/** The protocol for this repository and person. */
export function fillProtocol(mapping: Mapping, identity: Identity): string {
  const defaults = Object.entries(mapping.defaultProjects)
    .map(([kind, project]) => `  - ${kind}: «${project.title}» (${project.id})`)
    .join('\n')
  return PROTOCOL.replaceAll('{organizationId}', mapping.organizationId ?? '?')
    .replaceAll('{organizationName}', mapping.organizationName ?? '?')
    .replaceAll('{repo}', mapping.repo.split('/').pop() ?? mapping.repo)
    .replaceAll('{actorId}', identity.actorId ?? 'unknown — run /pragma:setup, which finds it through get_me')
    .replaceAll('{defaultProjects}', defaults === '' ? '  (none declared)' : defaults)
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
