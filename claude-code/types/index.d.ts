export type ObjectKind = 'project' | 'requirement' | 'issue' | 'task' | 'other'

/** A time entry the hooks recorded this session. */
export type SessionEntry = { id: string | null; duration: number; at: number }

export type PragmaObject = {
  kind: ObjectKind
  id: string
  title: string
  url: string
  /** The pinned need or task of the session. */
  isPinned: boolean
  /** A task the session closed. */
  isClosed: boolean
  /** When the session pinned it, for a task; null otherwise. */
  pinnedAt: number | null
  /** The need a task answers, from the hooks' `needOf`; null otherwise. */
  needId: string | null
  /** This session's entries: a task's own, or those of a need's tasks. */
  entries: SessionEntry[]
  /** Minutes of `entries`. */
  loggedMinutes: number
}

/** An adjustment being composed on a task's logged minutes: the delta, in minutes. */
export type Editing = { taskId: string; delta: number }

/**
 * A menu action under way: `running` while the press's own Pragma calls go through,
 * `queued` (or absent, from an older version) once it rides a user-role row to the model's next turn.
 */
export type Pending = { kind: 'adjust' | 'delete'; label: string; state?: 'running' | 'queued' }

declare module 'claude-code' {
  interface PluginState {
    pragma: {
      menuOpen: boolean
      editing: Editing | null
      /** The task whose deletion is being confirmed. */
      deleting: string | null
      /** Queued actions by task id, until the model's call for them lands. */
      pending: Record<string, Pending>
      /** Tasks deleted through the menu, hidden since the hooks' state still names them. */
      hidden: string[]
      /** Objects the menu shows; grows by ten per `show more` press, back to ten on `show fewer`. */
      rowLimit: number
    }
  }
}
