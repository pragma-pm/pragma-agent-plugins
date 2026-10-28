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

// ------------------------------------------------------------------ time tracking

/** A stretch of the session, in epoch seconds: one of the agent's turns, or one of the person's gaps. */
export type Span = { start: number; end: number; kind: 'turn' | 'gap' }

/** One turn: the moment of the person's that opened it, the agent's last moment in it. Epoch seconds. */
export type Turn = { start: number; last: number }

/** A pinned need or task: when it was pinned, and where it started counting. Epoch seconds. */
export type Pin = { id: string; pinnedAt: number; countedFrom: number }

/** A time entry the session logged, as Pragma answered it. */
export type TimeEntry = { id: string | null; activityId: string; duration: number; at: number; note: string | null }

/** What the session knows of an item it touched. Epoch seconds. */
export type TaskRecord = { seenAt?: number; pinnedAt?: number; countedFrom?: number; closedAt?: number; archivedAt?: number }

/** The repository's registration in `~/.claude/pragma/repositories.json`: its organization and default projects. */
export type Mapping = {
  /** The repository's root, the key of the registration. */
  repo: string
  organizationId: string | null
  organizationName: string | null
  /** By kind of work (`fix`, `improvement`, …): the project the work goes to when no initiative project fits. */
  defaultProjects: Record<string, { id: string; title: string }>
}

/** The person the agent acts for, from `~/.claude/pragma/identity.json`. */
export type Identity = { actorId: string | null; taskForShortWork: boolean }

/** Everything the time-tracking hooks know of one session. */
export type TrackingState = {
  sessionId: string
  /** Epoch seconds. */
  startedAt: number
  repo: string
  organizationId: string | null
  actorId: string | null
  need: Pin | null
  task: Pin | null
  /** Titles by item id, projects included. */
  titles: Record<string, string>
  /** Manageable types by item id. */
  types: Record<string, string>
  /** Project titles by project id. */
  projects: Record<string, string>
  /** The project an item belongs to. */
  projectOf: Record<string, string>
  /** The need a task answers, from the `has_response` links seen. */
  needOf: Record<string, string>
  lastNeedSeen: string | null
  /** Workflow state categories by state id, from the transitions seen. */
  stateCategories: Record<string, string>
  tasks: Record<string, TaskRecord>
  timeEntries: TimeEntry[]
  /** Actor ids assigned to an activity. */
  assigned: Record<string, string[]>
  /** The session's turns so far: its timeline. */
  turns: Turn[]
  /** Spans before this moment are settled: the user decided about them, nothing re-asks. */
  settledAt: number
  /** Hashes of the calls a gate refused once: the same call repeated goes through. */
  warnedCalls: string[]
  /** An overridden work gate holds for one turn. */
  workGateOpen: boolean
  /** Epoch seconds of the last write. */
  updatedAt: number
}

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
      /** The time-tracking hooks' knowledge of the session; null while the repository is not registered. */
      session: TrackingState | null
    }
  }
}
