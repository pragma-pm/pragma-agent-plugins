#!/usr/bin/env python3
"""Pragma time-tracking hooks for Claude Code (the `pragma` plugin, github.com/pragma-pm/pragma-agent-plugins).

One subcommand per hook event, plus the status-line segment:

  session-start  SessionStart      protocol + mapping + unlogged ledger -> context
  prompt         UserPromptSubmit  current pin -> context
  gate-work      PreToolUse        warn on a write to the repository's files while no task is pinned
  track          PostToolUse       follow the Pragma MCP calls: pin, titles, entries
  gate-close     PreToolUse        warn on a closing transition without a time entry
  gate-log       PreToolUse        warn on a time entry while the worker is not assigned

A gate warns by refusing a call once; the same call repeated goes through.
  stop           Stop              interim-entry nudge, ledger snapshot
  session-end    SessionEnd        ledger snapshot
  statusline     (status line)     "need > task . working (logged)"

Inert unless cwd or one of its parents is registered in ~/.claude/pragma/repositories.json
(per-user mapping: organization and default projects; permissions differ from one person
to another, so nothing is ever committed in a repository), or when PRAGMA_TIME_GATE=off. State: ~/.claude/pragma/sessions/<session_id>.json.
Ledger of unlogged time across sessions: ~/.claude/pragma/ledger.json.
"""
import hashlib
import json
import os
import re
import shlex
import sys
import time
from datetime import datetime
from pathlib import Path

HOME = Path.home()
PRAGMA_DIR = HOME / '.claude' / 'pragma'
PRAGMA_APP_URL = 'https://app.pragma.pm'
SESSIONS_DIR = PRAGMA_DIR / 'sessions'
LEDGER_PATH = PRAGMA_DIR / 'ledger.json'
IDENTITY_PATH = PRAGMA_DIR / 'identity.json'  # {"actorId": "actor__..."}: the person the agent acts for
REPOSITORIES_PATH = PRAGMA_DIR / 'repositories.json'
PROTOCOL_PATH = Path(__file__).with_name('PROTOCOL.md')

# The session alternates the agent's turns and the person's gaps; each is judged whole.
COUNTED_SPAN_MINUTES = 20  # up to this long, the person was there: waiting, reading, writing
DROPPED_SPAN_MINUTES = 35  # at least this long, the person was away: an unwatched turn, a break
# A span between the two is ambiguous: the agent asks the user whether to log it.
INTERIM_NUDGE_MINUTES = 30
CLOSE_SLACK_MINUTES = 5  # unlogged minutes a close lets through once the task carries an entry
LEDGER_THRESHOLD_MINUTES = 5
LEDGER_RETENTION_DAYS = 14
CLOSING_CATEGORIES = {'in_review', 'done'}
ACTIVITY_TYPES = {'task', 'meeting'}
NEED_TYPES = {'requirement', 'issue'}
TOOL_PREFIX = 'mcp__pragma__'

# A gate warns, it does not lock: the person is in charge, not the rule.
OVERRIDE_SENTENCE = ('A warning, not a lock: when the user wants it done anyway, or the rule does not fit '
                     'this call, say so to the user in one line and repeat the exact same call — a repeated '
                     'call goes through.')

# Work of a few minutes: on the need's previous task (the default), or a task of its own (the
# person's preference, `preferences.taskForShortWork` in identity.json, asked at setup).
SHORT_WORK_ON_PREVIOUS_TASK = ('**No task for work of a few minutes**: when the need already has a task, the work goes '
                               'on its previous one — still pinned, keep it; closed, pin it again (`revert_transition` '
                               'undoes the close within 15 minutes of it, whatever the workflow allows; later, '
                               '`transition_manageable` back to in_progress), log, close it again.')
SHORT_WORK_ON_OWN_TASK = ('**A task for every piece of work**, a few minutes included: the person prefers the time '
                          'split per piece over fewer tasks.')

# A shell command writes through a redirection, or through one of the programs below.
SHELL_OPERATORS = '();<>|&'
SHELL_LITERAL = ''  # stands for an operator character inside quotes: a word, not an operator
HEREDOC = re.compile(r"(?<!<)<<-?[ \t]*(['\"]?)(\w+)\1([^\n]*)\n.*?\n[ \t]*\2[ \t]*(?=\n|$)", re.S)
FD_NUMBER = re.compile(r'(?<![\w$])\d+(?=[<>])')  # the 2 of "2>": a descriptor, not a word
ASSIGNMENT = re.compile(r'[A-Za-z_]\w*=')
SHELL_WRAPPERS = {'sudo', 'command', 'env', 'time', 'nice', 'nohup', 'xargs', 'exec'}
GIT_WRITES = {'commit', 'apply', 'cherry-pick', 'merge', 'rebase', 'mv', 'rm'}
PNPM_WRITES = {'add', 'remove', 'install'}


# --------------------------------------------------------------------------- io
def read_input():
    try:
        return json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return {}


def emit(payload):
    print(json.dumps(payload))


def hook_context(event, text):
    emit({'hookSpecificOutput': {'hookEventName': event, 'additionalContext': text}})


def deny(reason):
    emit({'hookSpecificOutput': {
        'hookEventName': 'PreToolUse',
        'permissionDecision': 'deny',
        'permissionDecisionReason': reason,
    }})


def warned(state, hook_input, rule, reason):
    """Refuse a call the first time a rule catches it; the same call repeated goes through.
    True when the call was refused. The rule is part of the key: a retry that a fix turned into
    another rule's catch is warned again, not let through."""
    call = hashlib.sha256(json.dumps([rule, hook_input.get('tool_name'), hook_input.get('tool_input')],
                                     sort_keys=True, default=str).encode()).hexdigest()
    calls = state.get('warnedCalls') or []
    if call in calls:
        calls.remove(call)
        state['warnedCalls'] = calls
        save_state(state)
        return False
    state['warnedCalls'] = (calls + [call])[-20:]
    save_state(state)
    deny(f'{reason} {OVERRIDE_SENTENCE}')
    return True


def load_json(path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(data, indent=1))
    tmp.replace(path)


# ---------------------------------------------------------------------- mapping
def find_mapping(cwd):
    """The mapping of the nearest registered repository (a key of repositories.json that is cwd
    or one of its parents); None when none is registered."""
    if os.environ.get('PRAGMA_TIME_GATE', '').lower() == 'off':
        return None
    repositories = load_json(REPOSITORIES_PATH, {})
    if not isinstance(repositories, dict) or not repositories:
        return None
    directory = Path(cwd or os.getcwd()).resolve()
    for candidate in [directory, *directory.parents]:
        mapping = repositories.get(str(candidate))
        if isinstance(mapping, dict):
            mapping = dict(mapping)
            mapping['_path'] = str(REPOSITORIES_PATH)
            mapping['_repo'] = str(candidate)
            return mapping
    return None


# ------------------------------------------------------------------------ state
def state_path(session_id):
    return SESSIONS_DIR / f'{session_id or "unknown"}.json'


def load_state(hook_input, mapping):
    session_id = hook_input.get('session_id', 'unknown')
    state = load_json(state_path(session_id), None)
    if not isinstance(state, dict):
        state = {
            'sessionId': session_id,
            'startedAt': time.time(),
            'repo': mapping['_repo'],
            'organizationId': mapping.get('organizationId'),
            'need': None,
            'task': None,
            'titles': {},
            'types': {},
            'projects': {},
            'projectOf': {},
            'needOf': {},
            'lastNeedSeen': None,
            'stateCategories': {},
            'tasks': {},
            'timeEntries': [],
            'assigned': {},
            'working': {'minutes': 0, 'ambiguousMinutes': 0, 'ambiguousSpans': [],
                        'computedAt': time.time(), 'lastActivityAt': None},
        }
    state.setdefault('assigned', {})
    state['actorId'] = load_json(IDENTITY_PATH, {}).get('actorId') or state.get('actorId')
    state['transcriptPath'] = hook_input.get('transcript_path') or state.get('transcriptPath')
    # The engine's permission mode (auto, plan, ...): the pragma-pin mod measures its footer pill.
    if hook_input.get('permission_mode'):
        state['permissionMode'] = hook_input['permission_mode']
    return state


def save_state(state):
    save_json(state_path(state['sessionId']), state)


# ------------------------------------------------------------------- transcript
def parse_timestamp(value):
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except (AttributeError, ValueError):
        return None


def transcript_epochs(path, since=0.0, mentioning=None):
    """Timestamps of the conversation entries after `since`, optionally only
    those whose raw line mentions a manageable id."""
    epochs = []
    try:
        with open(path, encoding='utf-8', errors='replace') as handle:
            for line in handle:
                if '"timestamp"' not in line:
                    continue
                if mentioning and mentioning not in line:
                    continue
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if entry.get('type') not in ('user', 'assistant'):
                    continue
                epoch = parse_timestamp(entry.get('timestamp'))
                if epoch is not None and epoch >= since:
                    epochs.append(epoch)
    except OSError:
        pass
    epochs.sort()
    return epochs


def is_by_person(entry, questions):
    """A typed prompt, a slash command, or the answer to a question the agent asked."""
    if entry.get('isMeta'):
        return False
    origin = entry.get('origin')
    if isinstance(origin, dict) and origin.get('kind') == 'human':
        return True
    content = (entry.get('message') or {}).get('content')
    if isinstance(content, str):
        return content.startswith(('/', '<command-name>'))
    return any(isinstance(block, dict) and block.get('type') == 'tool_result'
               and block.get('tool_use_id') in questions for block in content or [])


def transcript_moments(path):
    """(epoch, by_person) of the conversation entries, sorted. The person's moments are their
    prompts (queued ones included), slash commands and answers to the agent's questions; every
    other entry is the agent's."""
    moments, questions = [], set()
    try:
        with open(path, encoding='utf-8', errors='replace') as handle:
            for line in handle:
                if '"timestamp"' not in line:
                    continue
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                epoch = parse_timestamp(entry.get('timestamp'))
                # A compaction summary carries the timestamp of the conversation it replaced.
                if epoch is None or entry.get('isCompactSummary'):
                    continue
                kind = entry.get('type')
                if kind == 'assistant':
                    content = (entry.get('message') or {}).get('content')
                    if isinstance(content, list):
                        questions.update(block.get('id') for block in content if isinstance(block, dict)
                                         and block.get('name') == 'AskUserQuestion')
                    moments.append((epoch, False))
                elif kind == 'user':
                    moments.append((epoch, is_by_person(entry, questions)))
                elif kind == 'attachment':
                    attachment = entry.get('attachment') or {}
                    if attachment.get('type') == 'queued_command' and is_by_person(attachment, questions):
                        moments.append((epoch, True))
    except OSError:
        pass
    return sorted_moments(moments)


def sorted_moments(moments):
    """By time; on a tie the person's moment first: a slash command's output belongs to it."""
    return sorted(moments, key=lambda moment: (moment[0], not moment[1]))


def turns_and_gaps(moments):
    """(start, end, kind) spans. A turn runs from one of the person's moments to the agent's
    last entry before the next one; the gap runs from there to that next moment."""
    spans, start, last = [], None, None
    for epoch, by_person in moments:
        if start is None:
            start = last = epoch
        elif by_person:
            spans += [(start, last, 'turn'), (last, epoch, 'gap')]
            start = last = epoch
        else:
            last = epoch
    if start is not None:
        spans.append((start, last, 'turn'))
    return spans


def working_seconds(moments, since, now, now_by_person):
    """Counted seconds after `since`, and the ambiguous spans. `now` closes the timeline as
    the person's moment (a prompt being submitted, the session ending) or as the agent's (a
    hook firing in a turn). Each turn and each gap is judged whole, then clipped to `since`:
    up to COUNTED_SPAN it counts; at least DROPPED_SPAN it is dropped entirely — the person
    did not watch a turn that long, a gap that long was a break; in between it is ambiguous
    and returned as (start, end, kind) for the agent to ask about."""
    counted, dropped = COUNTED_SPAN_MINUTES * 60, DROPPED_SPAN_MINUTES * 60
    total, ambiguous = 0.0, []
    for start, end, kind in turns_and_gaps(sorted_moments(moments + [(now, now_by_person)])):
        clipped_start = max(start, since)
        if end <= clipped_start:
            continue
        if end - start <= counted:
            total += end - clipped_start
        elif end - start < dropped:
            ambiguous.append((clipped_start, end, kind))
    return total, ambiguous


def span_minutes(spans):
    return round(sum(end - start for start, end, _ in spans) / 60)


def describe_spans(spans):
    return ', '.join(f'{kind} {hhmm(start)}→{hhmm(end)} ({round((end - start) / 60)} min)'
                     for start, end, kind in spans)


def session_moments(state):
    """The transcript's moments, plus the session openings: the person opened it, then wrote
    the first prompt."""
    openings = [(epoch, True) for epoch in state.get('openings', [])]
    return sorted_moments(transcript_moments(state.get('transcriptPath') or '') + openings)


def counted_from(pin):
    """Where a pinned need or task starts counting; pins older than countedFrom start at the pin."""
    return pin.get('countedFrom', pin.get('pinnedAt'))


def counting_start(state, now):
    """Where a task pinned now starts counting. A task still pinned owns the time until now.
    Otherwise the new task takes the current turn and the gap before it — the person writing
    the prompt, from the session opening for the first one — minus what a time entry or a
    closed task already accounts for. Unpinned turns before that (answering a question) stay
    unlogged."""
    if state.get('task'):
        return now
    spans = turns_and_gaps(sorted_moments(session_moments(state) + [(now, False)]))
    accounted = [entry['at'] for entry in state['timeEntries']]
    accounted += [task['closedAt'] for task in state['tasks'].values() if task.get('closedAt')]
    return max([spans[-2][0] if len(spans) > 1 else spans[-1][0]] + accounted)


def unlogged_since(state, activity_id):
    """(since, logged): the task's last time entry, else where its pin started counting."""
    entries = [entry['at'] for entry in state['timeEntries'] if entry['activityId'] == activity_id]
    pin_start = counted_from(state['tasks'].get(activity_id) or {})
    return max(entries + [pin_start or 0]) or None, bool(entries)


def refresh_working(state, now, now_by_person=False):
    """Recompute the working minutes since the need started counting (else since the
    session started) and store them for the status line."""
    since = counted_from(state.get('need') or {}) or state.get('startedAt', 0)
    moments = session_moments(state)
    seconds, ambiguous = working_seconds(moments, since, now, now_by_person)
    # A time entry settles the spans before it: the protocol asks the user before logging.
    settled_before = max([entry['at'] for entry in state['timeEntries']] + [state.get('settledAt', 0)])
    ambiguous = [span for span in ambiguous if span[1] > settled_before]
    state['working'] = {
        'minutes': round(seconds / 60),
        'ambiguousMinutes': span_minutes(ambiguous),
        'ambiguousSpans': ambiguous,
        'computedAt': now,
        'lastActivityAt': moments[-1][0] if moments else None,
        'task': task_working(state, now, now_by_person),
    }


def task_working(state, now, now_by_person):
    """The pinned task's own figure, stored for the Pragma row (the pragma-pin mod): the
    minutes the next time entry will carry, counted from the task's last time entry, else
    from where its pin started counting. None while no task is pinned."""
    task = state.get('task')
    if not task:
        return None
    since, logged = unlogged_since(state, task['id'])
    if since is None:
        return None
    # A deleted entry settles what came before it: the user decided, nothing re-asks.
    since = max(since, state.get('settledAt', 0))
    minutes, ambiguous = minutes_since(state, since, now, now_by_person)
    return {'id': task['id'], 'unloggedMinutes': minutes, 'ambiguousMinutes': span_minutes(ambiguous),
            'since': since, 'sinceLastEntry': logged}


def minutes_since(state, since, now, now_by_person=False):
    """(certain working minutes, ambiguous spans) since `since`."""
    seconds, ambiguous = working_seconds(session_moments(state), since, now, now_by_person)
    return round(seconds / 60), ambiguous


def ambiguity_sentence(spans):
    if not spans:
        return ''
    return (f' Ambiguous spans of {COUNTED_SPAN_MINUTES}–{DROPPED_SPAN_MINUTES} min, not counted — '
            f'a turn the person may not have watched, a gap that may have been a break: '
            f'{describe_spans(spans)} = {span_minutes(spans)} min. Ask the user, in one '
            f'question, whether to log them; then log once.')


def is_assigned(state, activity_id, actor_id):
    return actor_id in state['assigned'].get(activity_id, [])


def record_assignment(state, activity_id, actor_id):
    if activity_id and actor_id:
        workers = state['assigned'].setdefault(activity_id, [])
        if actor_id not in workers:
            workers.append(actor_id)


# ---------------------------------------------------------------------- helpers
def manageable_type(manageable_id):
    match = re.match(r'manageable_([a-z_]+)__', manageable_id or '')
    return match.group(1) if match else None


def tool_response_text(response):
    if isinstance(response, str):
        return response
    if isinstance(response, dict):
        if 'content' in response:
            return tool_response_text(response['content'])
        if 'text' in response:
            return str(response['text'])
        return json.dumps(response)
    if isinstance(response, list):
        return '\n'.join(tool_response_text(block) for block in response)
    return ''


def tool_response_json(response):
    try:
        return json.loads(tool_response_text(response))
    except ValueError:
        return None


def title_of(state, manageable_id, fallback=None):
    return state['titles'].get(manageable_id) or fallback or manageable_id or '?'


def short(text, width=32):
    text = str(text or '')
    return text if len(text) <= width else text[: width - 1] + '…'


def hhmm(epoch):
    return datetime.fromtimestamp(epoch).strftime('%H:%M')


def hm(minutes):
    minutes = int(minutes or 0)
    return f'{minutes // 60}h{minutes % 60:02d}' if minutes >= 60 else f'{minutes}m'


def logged_minutes(state, activity_id=None):
    return sum(
        entry['duration'] for entry in state['timeEntries']
        if activity_id is None or entry['activityId'] == activity_id
    )


def shell_text(command):
    """The command as shlex can read it: heredoc bodies and comments left out, unquoted newlines
    turned into ';', operator characters inside quotes or escaped turned into a literal."""
    text = HEREDOC.sub(lambda match: match.group(3), command.replace('\\\n', ' '))
    out, quote, index = [], None, 0
    while index < len(text):
        char = text[index]
        if char == '\\' and quote != "'":
            escaped = text[index + 1:index + 2]
            out.append(SHELL_LITERAL if escaped and escaped in SHELL_OPERATORS else char + escaped)
            index += 2
            continue
        if quote:
            quote = None if char == quote else quote
            char = SHELL_LITERAL if quote and char in SHELL_OPERATORS else char
        elif char in '\'"':
            quote = char
        elif char == '#' and (not out or out[-1] in ' \t;&|('):
            end = text.find('\n', index)
            index = len(text) if end == -1 else end
            continue
        elif char == '\n':
            char = ';'
        out.append(char)
        index += 1
    return FD_NUMBER.sub('', ''.join(out))


def shell_segments(command):
    """Each simple command of a shell command line as (words, redirection targets); None when
    the command does not parse."""
    lexer = shlex.shlex(shell_text(command), posix=True, punctuation_chars=SHELL_OPERATORS)
    lexer.whitespace_split, lexer.commenters = True, ''
    try:
        tokens = iter(list(lexer))
    except ValueError:
        return None
    segments, words, targets = [], [], []
    for token in tokens:
        if not (token and all(char in SHELL_OPERATORS for char in token)):
            words.append(token)
        elif '>' in token:
            target = next(tokens, '')
            if not (token.endswith('&') and (target.isdigit() or target == '-')):  # 2>&1 duplicates
                targets.append(target)
        elif '<' in token:
            next(tokens, None)
        else:
            segments.append((words, targets))
            words, targets = [], []
    segments.append((words, targets))
    return segments


def shell_operands(arguments, valued=()):
    """The arguments that are neither options nor the values of the options in `valued`."""
    operands, skip = [], False
    for argument in arguments:
        if skip:
            skip = False
        elif argument in valued:
            skip = True
        elif argument == '-' or not argument.startswith('-'):
            operands.append(argument)
    return operands


def shell_option(arguments, *names):
    """The value of the first of the options `names` given, as "-t value" or "--name=value"."""
    for index, argument in enumerate(arguments):
        if argument in names and index + 1 < len(arguments):
            return arguments[index + 1]
        for name in names:
            if name.startswith('--') and argument.startswith(name + '='):
                return argument[len(name) + 1:]
    return None


def program_writes(program, arguments):
    """The words naming what a program writes, '.' for the directory it runs in."""
    name = os.path.basename(program)
    if name in ('rm', 'mv', 'tee'):
        return shell_operands(arguments) or ['.']
    if name in ('cp', 'install', 'rsync'):
        directory = shell_option(arguments, '-t', '--target-directory')
        return [directory] if directory else shell_operands(arguments)[-1:] or ['.']
    if name == 'sed' and any(re.match(r'-[^-]*i|--in-place', argument) for argument in arguments):
        scripted = any(argument in ('-e', '-f', '--expression', '--file') for argument in arguments)
        files = [operand for operand in shell_operands(arguments, ('-e', '-f', '--expression', '--file'))
                 if operand]  # the '' of BSD's "sed -i ''"
        return (files if scripted else files[1:]) or ['.']
    if name == 'patch':
        return [shell_option(arguments, '-d', '--directory') or '.']
    if name == 'git':
        operands = shell_operands(arguments, ('-C', '-c'))
        return [shell_option(arguments, '-C') or '.'] if operands[:1] and operands[0] in GIT_WRITES else []
    if name == 'pnpm':
        operands = shell_operands(arguments, ('-C', '--dir', '--filter', '-F'))
        return [shell_option(arguments, '-C', '--dir') or '.'] if operands[:1] and operands[0] in PNPM_WRITES else []
    return []


def expand_variables(word, variables):
    """The word with the variables it names replaced; an unknown one is left as written."""
    return re.sub(r'\$(\w+)|\$\{(\w+)\}',
                  lambda match: variables.get(match.group(1) or match.group(2)) or match.group(0), word)


def resolve_path(word, cwd, variables):
    """The absolute path a shell word names; None when a variable or the directory is unknown."""
    word = expand_variables(word, variables)
    if '$' in word or '`' in word or (cwd is None and not word.startswith(('/', '~'))):
        return None
    return (Path(cwd or '/') / os.path.expanduser(word)).resolve()


def shell_written_paths(command, cwd):
    """The paths a shell command writes, resolved against the directories it moves to; None for
    a path it cannot resolve, and for the whole command when it does not parse."""
    segments = shell_segments(command)
    if segments is None:
        return [None]
    variables, written = dict(os.environ), []
    for words, targets in segments:
        while words and (ASSIGNMENT.match(words[0]) or words[0] in SHELL_WRAPPERS):
            # "S=/tmp/x", "export S=/tmp/x", "env -i X=1 rm …", "xargs -0 rm …": set, or skip to the program.
            word = words.pop(0)
            if ASSIGNMENT.match(word):
                name, _, value = word.partition('=')
                variables[name] = expand_variables(value, variables)
            else:
                while words and words[0].startswith('-'):
                    words.pop(0)
        program, arguments = (words[0], words[1:]) if words else ('', [])
        if program == 'export':
            for argument in arguments:
                name, equals, value = argument.partition('=')
                if equals:
                    variables[name] = expand_variables(value, variables)
        written += [resolve_path(target, cwd, variables) for target in targets]
        written += [resolve_path(word, cwd, variables) for word in program_writes(program, arguments)]
        if program in ('cd', 'pushd'):
            cwd = resolve_path(arguments[0] if arguments else '~', cwd, variables)
    return written


def inside_repository(path, root):
    """True for a path of the repository, and for a path that could not be resolved."""
    return path is None or path == root or root in path.parents


def project_title(state, mapping, manageable_id):
    project_id = state['projectOf'].get(manageable_id, '')
    if not project_id:
        return ''
    defaults = {p.get('id'): p.get('title') for p in (mapping or {}).get('defaultProjects', {}).values()}
    return state['projects'].get(project_id) or defaults.get(project_id) or ''


def describe_pin(state, mapping=None):
    need, task = state.get('need'), state.get('task')
    if not need and not task:
        return None
    parts = []
    if task:
        parts.append(f'task «{title_of(state, task["id"])}»')
    if need:
        project = project_title(state, mapping, need['id'])
        parts.append(f'{manageable_type(need["id"])} «{title_of(state, need["id"])}»'
                     + (f' ({project})' if project else ''))
    return ' under '.join(parts) if task and need else parts[0]


# ----------------------------------------------------------------------- ledger
def ledger_upsert(state, now, now_by_person):
    ledger = [row for row in load_json(LEDGER_PATH, []) if isinstance(row, dict)
              and now - row.get('updatedAt', 0) < LEDGER_RETENTION_DAYS * 86400
              and row.get('sessionId') != state['sessionId']]
    refresh_working(state, now, now_by_person)
    need, task = state.get('need'), state.get('task')
    working = state['working']['minutes']
    logged = logged_minutes(state)
    if need or task:
        ledger.append({
            'sessionId': state['sessionId'],
            'repo': state['repo'],
            'needId': need and need['id'], 'needTitle': need and title_of(state, need['id']),
            'taskId': task and task['id'], 'taskTitle': task and title_of(state, task['id']),
            'workingMinutes': working, 'loggedMinutes': logged,
            'unloggedMinutes': max(0, working - logged),
            'date': datetime.fromtimestamp(now).strftime('%Y-%m-%d'),
            'updatedAt': now,
        })
    save_json(LEDGER_PATH, ledger)


def ledger_reminders(state):
    rows = [row for row in load_json(LEDGER_PATH, []) if isinstance(row, dict)
            and row.get('repo') == state['repo'] and row.get('sessionId') != state['sessionId']
            and row.get('unloggedMinutes', 0) >= LEDGER_THRESHOLD_MINUTES]
    return [
        f'- {row["date"]}: ~{hm(row["unloggedMinutes"])} unlogged on '
        f'«{row.get("taskTitle") or "?"}» ({row.get("taskId") or "no task id"})'
        f' under «{row.get("needTitle") or "?"}» — log it (dateOfWork {row["date"]}) or say why not.'
        for row in rows
    ]


# ------------------------------------------------------------------ subcommands
def cmd_session_start(hook_input, mapping):
    state = load_state(hook_input, mapping)
    # Opening, resuming or clearing a session is the person's moment: the first prompt is
    # written from there. A compaction is not (a typed /compact is in the transcript).
    if hook_input.get('source') != 'compact':
        state.setdefault('openings', []).append(time.time())
    save_state(state)
    defaults = mapping.get('defaultProjects', {})
    default_lines = '\n'.join(
        f'  - {kind}: «{project.get("title", "?")}» ({project.get("id", "?")})'
        for kind, project in defaults.items()
    ) or '  (none declared)'
    protocol = PROTOCOL_PATH.read_text() if PROTOCOL_PATH.is_file() else ''
    protocol = (protocol
                .replace('{organizationId}', str(mapping.get('organizationId', '?')))
                .replace('{organizationName}', str(mapping.get('organizationName', '?')))
                .replace('{repo}', Path(state['repo']).name)
                .replace('{actorId}', str(state.get('actorId') or 'unknown — ask the user for their actor id and store it in ~/.claude/pragma/identity.json'))
                .replace('{defaultProjects}', default_lines)
                .replace('{shortWorkRule}', SHORT_WORK_ON_OWN_TASK
                         if load_json(IDENTITY_PATH, {}).get('preferences', {}).get('taskForShortWork')
                         else SHORT_WORK_ON_PREVIOUS_TASK))
    pin = describe_pin(state, mapping)
    extra = [f'\nCurrent pin (resumed session): {pin}.'] if pin else []
    reminders = ledger_reminders(state)
    if reminders:
        extra.append('\nUnlogged time from previous sessions in this repository:\n' + '\n'.join(reminders))
    hook_context('SessionStart', protocol + ''.join(extra))


def task_unlogged_sentence(state, now):
    """The pinned task's own figure, the one to log: the need's total spans its earlier tasks."""
    task = state.get('task')
    if not task:
        return ''
    since, logged = unlogged_since(state, task['id'])
    if since is None:
        return ''
    minutes, ambiguous = minutes_since(state, since, now, now_by_person=True)
    return (f' Task: {hm(minutes)} unlogged since {"its last time entry" if logged else "it started counting"} '
            f'({hhmm(since)})' + (f', +{hm(span_minutes(ambiguous))} ambiguous' if ambiguous else '') + '.')


def cmd_prompt(hook_input, mapping):
    state = load_state(hook_input, mapping)
    now = time.time()
    refresh_working(state, now, now_by_person=True)  # the prompt being submitted ends the gap
    state.pop('workGateOpen', None)  # an override of the work gate holds for one turn
    save_state(state)
    pin = describe_pin(state, mapping)
    if pin:
        ambiguous = state['working'].get('ambiguousMinutes', 0)
        text = (f'Pragma pin: {pin}.{task_unlogged_sentence(state, now)} Need, since it was first pinned: '
                f'{hm(state["working"]["minutes"])} working'
                + (f' (+{hm(ambiguous)} in ambiguous turns or gaps: ask before logging them)' if ambiguous else '')
                + f', {hm(logged_minutes(state))} logged this session. '
                'Different work than the pin? Log the current task, then re-pin.')
    else:
        text = ('Pragma: no task pinned. Work that changes files needs a pin first '
                '(need → task → transition to in_progress, see the session protocol); '
                'answering a question needs none.')
    hook_context('UserPromptSubmit', text)


def cmd_gate_work(hook_input, mapping):
    """Only the repository's files are gated: a personal file elsewhere (a status line, a scratch
    file) is nobody's task."""
    state = load_state(hook_input, mapping)
    if state.get('task') or state.get('workGateOpen'):
        return
    tool_input = hook_input.get('tool_input') or {}
    cwd = Path(hook_input.get('cwd') or os.getcwd())
    if hook_input.get('tool_name') == 'Bash':
        written = shell_written_paths(str(tool_input.get('command', '')), cwd)
    else:
        target = str(tool_input.get('file_path') or tool_input.get('notebook_path') or '')
        written = [resolve_path(target, cwd, {})]
    root = Path(mapping['_repo']).resolve()
    if not any(inside_repository(path, root) for path in written):
        return
    if warned(state, hook_input, 'unpinned',
              'Pragma: no task pinned for this session, and this call changes files of the repository. '
              'Pin first: find or create the need (requirement, or issue for a fix) with `search` across the '
              'organization; find or create the task under it (`create_manageable` type task, then '
              '`create_link` need --has_response--> task); `available_transitions` on the task, then '
              '`transition_manageable` it to the in_progress state. Then tell the user in one line: '
              '"Pinned: [<task>](https://app.pragma.pm/items/<taskId>) — [<need>](https://app.pragma.pm/items/<needId>) '
              '(<project>)". Full protocol in the session-start context. Overriding opens this gate until '
              'the next prompt.'):
        return
    state['workGateOpen'] = True  # overridden: the person wants the work done unpinned, this turn
    save_state(state)


def remember_project(state, data):
    if isinstance(data, dict) and data.get('id', '').startswith('project__') and data.get('title'):
        state['projects'][data['id']] = data['title']
    if isinstance(data, list):
        for item in data:
            remember_project(state, item)


def track_transition(state, mapping, tool_input, now):
    manageable_id = tool_input.get('id', '')
    category = state['stateCategories'].get(tool_input.get('toStateId', ''))
    if category == 'in_progress' and manageable_type(manageable_id) in ACTIVITY_TYPES:
        previous = state.get('task') or {}
        start = counted_from(previous) if previous.get('id') == manageable_id else counting_start(state, now)
        state['task'] = {'id': manageable_id, 'pinnedAt': now, 'countedFrom': start}
        state['tasks'].setdefault(manageable_id, {}).update(pinnedAt=now, countedFrom=start)
        need_id = state['needOf'].get(manageable_id) or state.get('lastNeedSeen')
        if need_id and (state.get('need') or {}).get('id') != need_id:
            state['need'] = {'id': need_id, 'pinnedAt': now, 'countedFrom': start}
        project_id = state['projectOf'].get(need_id, '') if need_id else ''
        project = project_title(state, mapping, need_id) if need_id else ''
        need_link = (markdown_link(title_of(state, need_id), item_url(need_id)) if need_id
                     else 'no need linked yet')
        project_part = (f' ({markdown_link(project, project_url(project_id))})'
                        if project and project_id else '')
        return (f'Pinned {describe_pin(state, mapping)}. Tell the user in one line, markdown links '
                f'kept (the footer turns them into badges): '
                f'"Pinned: {markdown_link(title_of(state, manageable_id), item_url(manageable_id))} — '
                f'{need_link}{project_part}".')
    if category in CLOSING_CATEGORIES and manageable_type(manageable_id) in ACTIVITY_TYPES:
        state['tasks'].setdefault(manageable_id, {})['closedAt'] = now
        if (state.get('task') or {}).get('id') == manageable_id:
            state['task'] = None
        return need_follow_up(state, manageable_id)
    if category in CLOSING_CATEGORIES and manageable_type(manageable_id) in NEED_TYPES:
        state['tasks'].setdefault(manageable_id, {})['closedAt'] = now
        if (state.get('need') or {}).get('id') == manageable_id and not state.get('task'):
            state['need'] = None
    return None


def need_follow_up(state, task_id):
    """A task closed: the need it answers may be complete. The agent offers, the user decides."""
    need_id = state['needOf'].get(task_id)
    if not need_id or state['tasks'].get(need_id, {}).get('closedAt'):
        return None
    others = [other for other, need in state['needOf'].items()
              if need == need_id and other != task_id and not state['tasks'].get(other, {}).get('archivedAt')]
    still_open = [title_of(state, other) for other in others if not state['tasks'].get(other, {}).get('closedAt')]
    if still_open:
        seen = (f'{len(still_open)} other task{"s" if len(still_open) > 1 else ""} of it seen this session still open: '
                + ', '.join(f'«{title}»' for title in still_open))
    elif others:
        seen = 'every other task of it seen this session is closed'
    else:
        seen = 'no other task of it seen this session'
    kind = manageable_type(need_id) or 'need'
    article = 'an' if kind[0] in 'aeiou' else 'a'
    return (f'Task «{title_of(state, task_id)}» closed. The {kind} it answers, «{title_of(state, need_id)}», may be '
            f'complete ({seen}; its tasks outside this session: `graph_get_neighbors` on it). Offer to move it: '
            f'`available_transitions` on the {kind}, then ask the user with the AskUserQuestion tool, never in plain '
            f'text: one option per allowed transition (Done, In review, …) plus «Leave it as is». Apply the answer '
            f'with `transition_manageable`; the user decides, you never close {article} {kind} on your own.')


def cmd_track(hook_input, mapping):
    state = load_state(hook_input, mapping)
    now = time.time()
    name = hook_input.get('tool_name', '').removeprefix(TOOL_PREFIX)
    tool_input = hook_input.get('tool_input') or {}
    data = tool_response_json(hook_input.get('tool_response'))
    context = None

    if name in ('available_transitions', 'get_workflow') and isinstance(data, dict):
        for transition in data.get('transitions', []) or []:
            if transition.get('toStateId') and transition.get('toCategory'):
                state['stateCategories'][transition['toStateId']] = transition['toCategory']
        for workflow_state in data.get('states', []) or []:
            if workflow_state.get('id') and workflow_state.get('category'):
                state['stateCategories'][workflow_state['id']] = workflow_state['category']
        if data.get('currentStateId') and data.get('currentCategory'):
            state['stateCategories'][data['currentStateId']] = data['currentCategory']

    elif name == 'create_manageable' and isinstance(data, dict) and data.get('id'):
        state['titles'][data['id']] = data.get('title') or data['id']
        kind = data.get('type') or manageable_type(data['id'])
        state['types'][data['id']] = kind
        project_id = (tool_input.get('item') or {}).get('projectId')
        if project_id:
            state['projectOf'][data['id']] = project_id
        for actor_id in (tool_input.get('item') or {}).get('assignedActorIds') or []:
            record_assignment(state, data['id'], actor_id)
        if kind in NEED_TYPES:
            state['lastNeedSeen'] = data['id']

    elif name == 'get_manageable' and isinstance(data, dict):
        manageable_id = tool_input.get('id') or data.get('id', '')
        title = data.get('title') or (data.get('body') or {}).get('title')
        if title:
            state['titles'][manageable_id] = title
        scope = data.get('scope') or {}
        project_id = data.get('projectId') or scope.get('projectId') or (scope.get('projectIds') or [None])[0]
        if project_id:
            state['projectOf'][manageable_id] = project_id
        if manageable_type(manageable_id) in NEED_TYPES:
            state['lastNeedSeen'] = manageable_id
        # An assignment request still pending is not an assignment.
        for actor_id, assignment in (data.get('assignees') or {}).items():
            if not (isinstance(assignment, dict) and assignment.get('isRequest') and not assignment.get('accepted')):
                record_assignment(state, manageable_id, actor_id)

    elif name == 'assign_activity' and isinstance(data, dict) and data.get('assigned'):
        if data.get('isRequest') is False:
            record_assignment(state, data.get('activityId') or tool_input.get('activityId'),
                              data.get('workerId') or tool_input.get('workerId'))

    elif name == 'create_link':
        source, target = tool_input.get('from', ''), tool_input.get('to', '')
        if (tool_input.get('type') == 'has_response' and manageable_type(source) in NEED_TYPES
                and manageable_type(target) in ACTIVITY_TYPES):
            state['needOf'][target] = source
            state['lastNeedSeen'] = source

    elif name in ('list_projects', 'get_project', 'create_project'):
        remember_project(state, data)

    elif name in ('archive_manageable', 'delete_manageable') and isinstance(data, dict):
        # The task leaves the session's views (the pragma-pin menu); a pinned one is unpinned.
        gone_id = data.get('id') or tool_input.get('id')
        if gone_id:
            state['tasks'].setdefault(gone_id, {})['archivedAt'] = now
            if (state.get('task') or {}).get('id') == gone_id:
                state['task'] = None
    elif name == 'transition_manageable' and isinstance(data, dict) and data.get('transitioned'):
        context = track_transition(state, mapping, tool_input, now)
        refresh_working(state, now)

    elif name == 'revert_transition' and isinstance(data, dict) and data.get('reverted'):
        # Undoing a close within the 15-minute window re-pins the task, like a transition would.
        context = track_transition(state, mapping, {'id': data.get('id') or tool_input.get('id', ''),
                                                    'toStateId': data.get('newStateId')}, now)
        refresh_working(state, now)

    elif name == 'add_time_entry' and isinstance(data, dict) and data.get('created'):
        activity_id = data.get('activityId') or tool_input.get('activityId')
        duration = int(data.get('duration') or tool_input.get('duration') or 0)
        state['timeEntries'].append({'id': data.get('id'), 'activityId': activity_id, 'duration': duration,
                                     'at': now, 'note': tool_input.get('note')})
        refresh_working(state, now)
        source = tool_input.get('note') or 'measured'
        context = (f'Logged {hm(duration)} on «{title_of(state, activity_id)}». Tell the user in one '
                   f'line, nothing more, markdown link kept: "Logged {hm(duration)} on '
                   f'{markdown_link(title_of(state, activity_id), item_url(activity_id))} ({source})".')

    elif name == 'update_time_entry' and isinstance(data, dict) and data.get('updated'):
        # A corrected entry replaces the session's record of it: the entry id is the key when
        # known, else the latest entry on that activity.
        activity_id = data.get('activityId') or tool_input.get('activityId')
        entry_id = data.get('id') or tool_input.get('timeEntryId')
        entries = state['timeEntries']
        target = next((e for e in reversed(entries) if e.get('id') == entry_id), None) \
            or next((e for e in reversed(entries) if e.get('activityId') == activity_id), None)
        if target is None:
            target = {'activityId': activity_id, 'at': now}
            entries.append(target)
        target['id'] = entry_id
        if 'duration' in data or 'duration' in tool_input:
            target['duration'] = int(data.get('duration', tool_input.get('duration')) or 0)
        if tool_input.get('note') is not None:
            target['note'] = tool_input['note']
        refresh_working(state, now)
        context = (f'Corrected the entry on «{title_of(state, activity_id)}» to {hm(target.get("duration", 0))}. '
                   f'Tell the user in one line, nothing more.')

    elif name == 'delete_time_entry' and isinstance(data, dict) and data.get('deleted'):
        # A dropped entry leaves the session's record. The spans it covered stay settled:
        # the user decided about them, so nothing asks about them again.
        activity_id = data.get('activityId') or tool_input.get('activityId')
        entry_id = data.get('id') or tool_input.get('timeEntryId')
        entries = state['timeEntries']
        target = next((e for e in reversed(entries) if e.get('id') == entry_id), None)
        if target is not None:
            entries.remove(target)
            state['settledAt'] = max(state.get('settledAt', 0), target.get('at', 0))
        refresh_working(state, now)
        dropped = hm(target.get('duration', 0)) if target else 'an entry'
        context = (f'Deleted {dropped} on «{title_of(state, activity_id)}». '
                   f'Tell the user in one line, nothing more.')

    save_state(state)
    if context:
        hook_context('PostToolUse', context)


def cmd_gate_close(hook_input, mapping):
    state = load_state(hook_input, mapping)
    tool_input = hook_input.get('tool_input') or {}
    manageable_id = tool_input.get('id', '')
    if manageable_type(manageable_id) not in ACTIVITY_TYPES:
        return
    category = state['stateCategories'].get(tool_input.get('toStateId', ''))
    if category is None:
        warned(state, hook_input, 'unknown-state',
               'Pragma time gate: the target state is unknown to this session. Call '
               '`available_transitions` on this item first (it reveals the state categories), then retry.')
        return
    if category not in CLOSING_CATEGORIES:
        return
    now = time.time()
    since, logged = unlogged_since(state, manageable_id)
    if since is None:
        touches = transcript_epochs(state.get('transcriptPath') or '', 0, mentioning=manageable_id)
        since = touches[0] if touches else state.get('startedAt', now)
    minutes, ambiguous = minutes_since(state, since, now)
    # An interim entry does not cover the work after it.
    if logged and minutes < CLOSE_SLACK_MINUTES and not ambiguous:
        return
    title = title_of(state, manageable_id)
    unlogged = (f'{minutes} min on «{title}» since its last time entry' if logged
                else f'no time entry on «{title}» this session')
    warned(state, hook_input, 'unlogged',
           f'Pragma time gate: {unlogged}, and this transition closes it. '
           f'Transcript: {hhmm(since)}→{hhmm(now)}, {minutes} min working wall clock (turns and the '
           f'gaps between them judged whole: up to {COUNTED_SPAN_MINUTES} min counted, '
           f'{DROPPED_SPAN_MINUTES} min or more dropped entirely).'
           f'{ambiguity_sentence(ambiguous)} Log it, then retry the transition: '
           f'add_time_entry({{ activityId: "{manageable_id}", duration: {minutes}, remaining: 0, '
           f'note: "derived from session transcript" }}). Several tasks in that span? Split by commit '
           f'timestamps or your judgment and say so in the note. Nothing to log (the user said so)? '
           f'duration 0 with a note saying why. Then one line to the user: what you logged, on what.')


def cmd_gate_log(hook_input, mapping):
    state = load_state(hook_input, mapping)
    tool_input = hook_input.get('tool_input') or {}
    activity_id = tool_input.get('activityId', '')
    worker = tool_input.get('workerId') or state.get('actorId')
    if not worker or is_assigned(state, activity_id, worker):
        return
    warned(state, hook_input, 'unassigned',
           f'Pragma: {worker} is not known to be assigned to «{title_of(state, activity_id)}», and time is '
           f'logged on assigned tasks only. Assign first — assign_activity({{ activityId: "{activity_id}", '
           f'workerId: "{worker}", isRequest: false }}) — or, when the assignment already exists, '
           f'get_manageable the task so it is visible to this session. Then retry add_time_entry.')


def cmd_stop(hook_input, mapping):
    state = load_state(hook_input, mapping)
    now = time.time()
    ledger_upsert(state, now, now_by_person=False)
    save_state(state)
    task = state.get('task')
    if hook_input.get('stop_hook_active') or not task:
        return
    since, _ = unlogged_since(state, task['id'])
    unlogged, ambiguous = minutes_since(state, since or counted_from(task), now)
    if unlogged >= INTERIM_NUDGE_MINUTES:
        hook_context('Stop', f'Pragma: {hm(unlogged)} on «{title_of(state, task["id"])}» since the last '
                             f'time entry.{ambiguity_sentence(ambiguous)} Log an interim entry now — '
                             f'add_time_entry({{ activityId: "{task["id"]}", duration: {unlogged}, '
                             f'remaining: <minutes left or 0>, note: "interim, derived from session '
                             f'transcript" }}) — then one line to the user saying what you logged.')


def cmd_session_end(hook_input, mapping):
    state = load_state(hook_input, mapping)
    ledger_upsert(state, time.time(), now_by_person=True)  # the person ends the session
    save_state(state)


def item_url(manageable_id):
    return f'{PRAGMA_APP_URL}/items/{manageable_id}'


def project_url(project_id):
    return f'{PRAGMA_APP_URL}/projects/{project_id}'


def markdown_link(text, url):
    return f'[{text}]({url})'


def hyperlink(url, text):
    """OSC 8 terminal hyperlink. Claude Code strips it when the terminal lacks support."""
    return f'\033]8;;{url}\a{text}\033]8;;\a'


def cmd_statusline(hook_input, mapping):
    """Two lines: the plain segment (for width), then the same text with hyperlinks."""
    state = load_json(state_path(hook_input.get('session_id', 'unknown')), None)
    if not isinstance(state, dict):
        return
    need, task = state.get('need'), state.get('task')
    if not need and not task:
        print('◷ unpinned')
        return
    now = time.time()
    working = state.get('working') or {}
    minutes = working.get('minutes', 0)
    computed_at = working.get('computedAt', now)
    last_activity = latest_transcript_timestamp(hook_input.get('transcript_path')) or working.get('lastActivityAt')
    if last_activity:
        minutes += max(0.0, last_activity - computed_at) / 60
        if now - last_activity <= COUNTED_SPAN_MINUTES * 60:
            minutes += (now - last_activity) / 60
    minutes = round(minutes)
    ambiguous = working.get('ambiguousMinutes', 0)
    logged = logged_minutes(state)
    need_label = short(title_of(state, need['id'])) if need else 'no need'
    project_id = state['projectOf'].get(need['id'], '') if need else ''
    project = project_title(state, mapping, need['id']) if need else ''
    task_label = short(title_of(state, task['id']), 28) if task else 'no task'
    tail = (f' · {hm(minutes)}' + (f' +{hm(ambiguous)}?' if ambiguous else '')
            + (f' ({hm(logged)} logged)' if logged else ''))

    def line(link):
        need_part = link(item_url(need['id']), need_label) if need else need_label
        project_part = f' [{link(project_url(project_id), short(project, 20))}]' if project and project_id else ''
        task_part = link(item_url(task['id']), task_label) if task else task_label
        return f'◷ {need_part}{project_part} › {task_part}{tail}'

    print(line(lambda url, text: text))
    print(line(hyperlink))


def latest_transcript_timestamp(path):
    if not path:
        return None
    try:
        with open(path, 'rb') as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - 65536))
            tail = handle.read().decode('utf-8', errors='replace')
    except OSError:
        return None
    stamps = re.findall(r'"timestamp":"([0-9T:.\-]+Z)"', tail)
    return parse_timestamp(stamps[-1]) if stamps else None


COMMANDS = {
    'session-start': cmd_session_start,
    'prompt': cmd_prompt,
    'gate-work': cmd_gate_work,
    'track': cmd_track,
    'gate-close': cmd_gate_close,
    'gate-log': cmd_gate_log,
    'stop': cmd_stop,
    'session-end': cmd_session_end,
    'statusline': cmd_statusline,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(f'usage: pragma_hooks.py <{"|".join(COMMANDS)}>', file=sys.stderr)
        sys.exit(1)
    hook_input = read_input()
    mapping = find_mapping(hook_input.get('cwd'))
    if mapping is None:
        return
    try:
        COMMANDS[sys.argv[1]](hook_input, mapping)
    except Exception as error:  # a broken hook must never block the user
        print(f'pragma_hooks {sys.argv[1]}: {error!r}', file=sys.stderr)


if __name__ == '__main__':
    main()
