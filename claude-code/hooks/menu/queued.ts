// The menu's queued actions: a press the engine refused to run itself rides a user-role row to
// the model's next turn. Until the model's call for it lands, the row stays tagged in the menu
// and the system prompt names it. The tracking hooks settle them, one hook per event being the
// engine's rule.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptComposeSection } from 'claude-code'

import type { Pending } from '../../types'

const noPending: Record<string, Pending> = {}
const noHidden: string[] = []
/** Queued actions by task id, until the model's call for them lands. */
export const pending = atom({ plugin: 'pragma', key: 'pending' } as const, noPending)
/** Tasks deleted through the menu, hidden since the session's state still names them. */
export const hidden = atom({ plugin: 'pragma', key: 'hidden' } as const, noHidden)

export function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record
  return rest
}

/** A queued action lands when the model makes its call: the tag on the row goes. */
export async function settleQueuedAction($: EngineInterface, tool: string, fields: Record<string, unknown>): Promise<void> {
  const activityId = fields['activityId']
  const id = fields['id']
  if ((tool === 'mcp__pragma__update_time_entry' || tool === 'mcp__pragma__delete_time_entry') && typeof activityId === 'string') {
    await update($, pending, queued => withoutKey(queued, activityId))
  }
  if ((tool === 'mcp__pragma__delete_manageable' || tool === 'mcp__pragma__archive_manageable') && typeof id === 'string') {
    await update($, pending, queued => withoutKey(queued, id))
    await update($, hidden, ids => (ids.includes(id) ? ids : [...ids, id]))
  }
}

/**
 * A queued action rides a user-role row that reaches the model glued to the next prompt,
 * where it is easy to skip: while any is pending, the system prompt names them as well.
 */
export async function pendingSections($: EngineInterface): Promise<PromptComposeSection[]> {
  const queued = Object.entries(await read($, pending)).filter(([, action]) => action.state !== 'running')
  if (queued.length === 0) return []
  const list = queued.map(([taskId, action]) => `- ${action.label} (task ${taskId}, ${action.kind})`).join('\n')
  return [
    {
      id: 'pragma:pending',
      scope: 'session',
      text:
        '# Pragma menu actions pending\n' +
        'The user pressed these in the Pragma menu. Each arrived as a user-role row beginning "Pragma menu action", ' +
        "possibly appended to the user's own message. Carry each out first in this turn, with the exact Pragma calls its row " +
        'gives, then one line to the user per action. The row is the instruction; this section only lists what is still pending:\n' +
        list,
    },
  ]
}
