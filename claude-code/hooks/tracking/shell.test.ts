import { expect, test } from 'claude-code/testing'

import { insideDirectory, shellWrittenPaths } from './shell'

const environment = { HOME: '/home/me' }

test('a redirection and the programs known to write name their targets, resolved against the working directory', async () => {
  expect(shellWrittenPaths('echo hi > out.txt', '/work', environment)).toEqual(['/work/out.txt'])
  expect(shellWrittenPaths('cat a.txt | grep x 2>&1', '/work', environment)).toEqual([])
  expect(shellWrittenPaths('git status && rm -rf build', '/work', environment)).toEqual(['/work/build'])
  expect(shellWrittenPaths('git -C /elsewhere commit -m "done"', '/work', environment)).toEqual(['/elsewhere'])
  expect(shellWrittenPaths("sed -i '' 's/a/b/' src/x.ts", '/work', environment)).toEqual(['/work/src/x.ts'])
  expect(shellWrittenPaths('cd /tmp && mv a b', '/work', environment)).toEqual(['/tmp/a', '/tmp/b'])
  expect(shellWrittenPaths('T=/tmp/x; echo 1 > $T/f', '/work', environment)).toEqual(['/tmp/x/f'])
  expect(shellWrittenPaths('echo 1 > ~/notes.md', '/work', environment)).toEqual(['/home/me/notes.md'])
  expect(shellWrittenPaths('pnpm install && pnpm test', '/work', environment)).toEqual(['/work'])
})

test('an unknown variable, a substitution or an open quote leaves a path unresolved', async () => {
  expect(shellWrittenPaths('echo 1 > $UNKNOWN/f', '/work', environment)).toEqual([null])
  expect(shellWrittenPaths('echo 1 > $(pwd)/f', '/work', environment)).toEqual([null])
  expect(shellWrittenPaths("echo 'unclosed > x", '/work', environment)).toEqual([null])
})

test('a heredoc body and a comment are not commands', async () => {
  expect(shellWrittenPaths("cat <<'EOF' > /work/out\nrm -rf /\nEOF", '/work', environment)).toEqual(['/work/out'])
  expect(shellWrittenPaths('ls # > nothing', '/work', environment)).toEqual([])
})

test('a path under the directory, or one that could not be resolved, is inside it', async () => {
  expect(insideDirectory('/work/src/a.ts', '/work')).toBe(true)
  expect(insideDirectory('/work', '/work')).toBe(true)
  expect(insideDirectory('/workspace/a.ts', '/work')).toBe(false)
  expect(insideDirectory(null, '/work')).toBe(true)
})
