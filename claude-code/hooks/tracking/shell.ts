// What a shell command writes: the paths of its redirections and of the programs known to write
// (rm, mv, cp, sed -i, git commit, …), resolved against the directories it moves to. The work
// gate reads them to tell a change to the tracked directory from a personal file elsewhere.

const SHELL_OPERATORS = '();<>|&'
const HEREDOC = /(?<!<)<<-?[ \t]*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g
/** The 2 of `2>`: a descriptor, not a word. */
const FD_NUMBER = /(?<![\w$])\d+(?=[<>])/g
const ASSIGNMENT = /^[A-Za-z_]\w*=/
const VARIABLE = /\$(\w+)|\$\{(\w+)\}/g
const SHELL_WRAPPERS: ReadonlySet<string> = new Set(['sudo', 'command', 'env', 'time', 'nice', 'nohup', 'xargs', 'exec'])
const GIT_WRITES: ReadonlySet<string> = new Set(['commit', 'apply', 'cherry-pick', 'merge', 'rebase', 'mv', 'rm'])
const PNPM_WRITES: ReadonlySet<string> = new Set(['add', 'remove', 'install'])

type Token = { text: string; isOperator: boolean }

/** One simple command of a command line: its words, and the targets of its output redirections. */
export type Segment = { words: string[]; targets: string[] }

/** The command's text as the tokenizer reads it: heredoc bodies left out, continuations joined. */
function shellText(command: string): string {
  return command
    .replace(/\\\n/g, ' ')
    .replace(HEREDOC, (_match: string, _quote: string, _word: string, rest: string) => rest)
    .replace(FD_NUMBER, '')
}

/**
 * The words (quotes removed, their content literal) and the operator runs of a command line;
 * null when a quote is left open. A newline is a `;`; a `#` at a word's start opens a comment.
 */
export function tokenize(command: string): Token[] | null {
  const text = shellText(command)
  const tokens: Token[] = []
  let word = ''
  let inWord = false
  let quote: '"' | "'" | null = null
  const flush = (): void => {
    if (inWord) tokens.push({ text: word, isOperator: false })
    word = ''
    inWord = false
  }
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? ''
    if (quote !== null) {
      if (char === quote) quote = null
      else if (char === '\\' && quote === '"' && index + 1 < text.length) word += text[++index]
      else word += char
      continue
    }
    if (char === '\\') {
      if (index + 1 < text.length) {
        word += text[++index]
        inWord = true
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      inWord = true
      continue
    }
    if (char === '#' && !inWord) {
      const end = text.indexOf('\n', index)
      index = end === -1 ? text.length : end - 1
      continue
    }
    if (char === ' ' || char === '\t' || char === '\r') {
      flush()
      continue
    }
    if (char === '\n' || SHELL_OPERATORS.includes(char)) {
      flush()
      let run = ''
      while (index < text.length && (text[index] === '\n' || SHELL_OPERATORS.includes(text[index] ?? ''))) {
        run += text[index] === '\n' ? ';' : text[index]
        index++
      }
      index--
      tokens.push({ text: run, isOperator: true })
      continue
    }
    word += char
    inWord = true
  }
  if (quote !== null) return null
  flush()
  return tokens
}

/** Each simple command of a command line; null when the command does not parse. */
export function shellSegments(command: string): Segment[] | null {
  const tokens = tokenize(command)
  if (tokens === null) return null
  const segments: Segment[] = []
  let words: string[] = []
  let targets: string[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (token === undefined) break
    if (!token.isOperator) {
      words.push(token.text)
    } else if (token.text.includes('>')) {
      const target = tokens[++index]?.text ?? ''
      // `2>&1` duplicates a descriptor, it writes no file
      if (!(token.text.endsWith('&') && (/^\d+$/.test(target) || target === '-'))) targets.push(target)
    } else if (token.text.includes('<')) {
      index++
    } else {
      segments.push({ words, targets })
      words = []
      targets = []
    }
  }
  segments.push({ words, targets })
  return segments
}

/** The arguments that are neither options nor the values of the options in `valued`. */
export function shellOperands(args: readonly string[], valued: readonly string[] = []): string[] {
  const operands: string[] = []
  let skip = false
  for (const argument of args) {
    if (skip) skip = false
    else if (valued.includes(argument)) skip = true
    else if (argument === '-' || !argument.startsWith('-')) operands.push(argument)
  }
  return operands
}

/** The value of the first of the options `names` given, as `-t value` or `--name=value`. */
export function shellOption(args: readonly string[], ...names: string[]): string | null {
  for (const [index, argument] of args.entries()) {
    if (names.includes(argument) && index + 1 < args.length) return args[index + 1] ?? null
    for (const name of names) if (name.startsWith('--') && argument.startsWith(`${name}=`)) return argument.slice(name.length + 1)
  }
  return null
}

/** The words naming what a program writes, `.` for the directory it runs in. */
export function programWrites(program: string, args: readonly string[]): string[] {
  const name = program.split('/').pop() ?? ''
  if (name === 'rm' || name === 'mv' || name === 'tee') return orHere(shellOperands(args))
  if (name === 'cp' || name === 'install' || name === 'rsync') {
    const directory = shellOption(args, '-t', '--target-directory')
    return directory !== null ? [directory] : orHere(shellOperands(args).slice(-1))
  }
  if (name === 'sed' && args.some(argument => /^-[^-]*i|^--in-place/.test(argument))) {
    const scriptOptions = ['-e', '-f', '--expression', '--file']
    const scripted = args.some(argument => scriptOptions.includes(argument))
    // the '' of BSD's `sed -i ''` is no file
    const files = shellOperands(args, scriptOptions).filter(operand => operand !== '')
    return orHere(scripted ? files : files.slice(1))
  }
  if (name === 'patch') return [shellOption(args, '-d', '--directory') ?? '.']
  if (name === 'git') {
    const operands = shellOperands(args, ['-C', '-c'])
    return operands[0] !== undefined && GIT_WRITES.has(operands[0]) ? [shellOption(args, '-C') ?? '.'] : []
  }
  if (name === 'pnpm') {
    const operands = shellOperands(args, ['-C', '--dir', '--filter', '-F'])
    return operands[0] !== undefined && PNPM_WRITES.has(operands[0]) ? [shellOption(args, '-C', '--dir') ?? '.'] : []
  }
  return []
}

function orHere(words: string[]): string[] {
  return words.length > 0 ? words : ['.']
}

/** The word with the variables it names replaced; an unknown one is left as written. */
export function expandVariables(word: string, variables: Readonly<Record<string, string>>): string {
  return word.replace(VARIABLE, (match: string, plain: string | undefined, braced: string | undefined) => variables[plain ?? braced ?? ''] ?? match)
}

/** `/a/b/../c` → `/a/c`: an absolute path without `.` and `..` segments. */
export function normalizePath(path: string): string {
  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return `/${segments.join('/')}`
}

/** The absolute path a shell word names; null when a variable or the directory is unknown. */
export function resolvePath(word: string, cwd: string | null, variables: Readonly<Record<string, string>>): string | null {
  const expanded = expandVariables(word, variables)
  if (expanded.includes('$') || expanded.includes('`')) return null
  if (cwd === null && !expanded.startsWith('/') && !expanded.startsWith('~')) return null
  const home = variables['HOME'] ?? ''
  const path = expanded === '~' ? home : expanded.startsWith('~/') ? `${home}${expanded.slice(1)}` : expanded
  return normalizePath(path.startsWith('/') ? path : `${cwd ?? '/'}/${path}`)
}

/**
 * The paths a shell command writes, resolved against the directories it moves to; null for a
 * path it cannot resolve, and for the whole command when it does not parse.
 */
export function shellWrittenPaths(command: string, cwd: string | null, environment: Readonly<Record<string, string>>): (string | null)[] {
  const segments = shellSegments(command)
  if (segments === null) return [null]
  const variables: Record<string, string> = { ...environment }
  const written: (string | null)[] = []
  let directory = cwd
  for (const segment of segments) {
    const words = [...segment.words]
    // `S=/tmp/x`, `export S=/tmp/x`, `env -i X=1 rm …`, `xargs -0 rm …`: set, or skip to the program.
    while (words.length > 0 && (ASSIGNMENT.test(words[0] ?? '') || SHELL_WRAPPERS.has(words[0] ?? ''))) {
      const word = words.shift() ?? ''
      if (ASSIGNMENT.test(word)) assign(variables, word)
      else while (words.length > 0 && (words[0] ?? '').startsWith('-')) words.shift()
    }
    const [program = '', ...args] = words
    if (program === 'export') for (const argument of args) if (argument.includes('=')) assign(variables, argument)
    written.push(...segment.targets.map(target => resolvePath(target, directory, variables)))
    written.push(...programWrites(program, args).map(word => resolvePath(word, directory, variables)))
    if (program === 'cd' || program === 'pushd') directory = resolvePath(args[0] ?? '~', directory, variables)
  }
  return written
}

function assign(variables: Record<string, string>, word: string): void {
  const equals = word.indexOf('=')
  variables[word.slice(0, equals)] = expandVariables(word.slice(equals + 1), variables)
}

/** True for a path under the directory (itself included), and for a path that could not be resolved. */
export function insideDirectory(path: string | null, root: string): boolean {
  return path === null || path === root || path.startsWith(`${root}/`)
}
