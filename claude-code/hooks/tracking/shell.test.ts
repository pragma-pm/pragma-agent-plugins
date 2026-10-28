import { expect, test } from 'claude-code/testing'

import { insideRepository, shellWrittenPaths } from './shell'

const environment = { HOME: '/home/me' }

test('a redirection and the programs known to write name their targets, resolved against the directory', async () => {
  expect(shellWrittenPaths('echo hi > out.txt', '/repo', environment)).toEqual(['/repo/out.txt'])
  expect(shellWrittenPaths('cat a.txt | grep x 2>&1', '/repo', environment)).toEqual([])
  expect(shellWrittenPaths('git status && rm -rf build', '/repo', environment)).toEqual(['/repo/build'])
  expect(shellWrittenPaths('git -C /elsewhere commit -m "done"', '/repo', environment)).toEqual(['/elsewhere'])
  expect(shellWrittenPaths("sed -i '' 's/a/b/' src/x.ts", '/repo', environment)).toEqual(['/repo/src/x.ts'])
  expect(shellWrittenPaths('cd /tmp && mv a b', '/repo', environment)).toEqual(['/tmp/a', '/tmp/b'])
  expect(shellWrittenPaths('T=/tmp/x; echo 1 > $T/f', '/repo', environment)).toEqual(['/tmp/x/f'])
  expect(shellWrittenPaths('echo 1 > ~/notes.md', '/repo', environment)).toEqual(['/home/me/notes.md'])
  expect(shellWrittenPaths('pnpm install && pnpm test', '/repo', environment)).toEqual(['/repo'])
})

test('an unknown variable, a substitution or an open quote leaves a path unresolved', async () => {
  expect(shellWrittenPaths('echo 1 > $UNKNOWN/f', '/repo', environment)).toEqual([null])
  expect(shellWrittenPaths('echo 1 > $(pwd)/f', '/repo', environment)).toEqual([null])
  expect(shellWrittenPaths("echo 'unclosed > x", '/repo', environment)).toEqual([null])
})

test('a heredoc body and a comment are not commands', async () => {
  expect(shellWrittenPaths("cat <<'EOF' > /repo/out\nrm -rf /\nEOF", '/repo', environment)).toEqual(['/repo/out'])
  expect(shellWrittenPaths('ls # > nothing', '/repo', environment)).toEqual([])
})

test('a path of the repository, or one that could not be resolved, is inside it', async () => {
  expect(insideRepository('/repo/src/a.ts', '/repo')).toBe(true)
  expect(insideRepository('/repo', '/repo')).toBe(true)
  expect(insideRepository('/repository/a.ts', '/repo')).toBe(false)
  expect(insideRepository(null, '/repo')).toBe(true)
})
