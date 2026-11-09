import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { isReadOnlyCommand, isSecret, mentionsSecret, searchReachesSecret, secretPathsOf } from './read-only.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'kothar-read-')))
const home = join(root, 'home')
const garage = join(home, 'Library', 'Application Support', 'Kothar')
const project = join(home, 'code', 'app')
mkdirSync(join(home, '.ssh'), { recursive: true })
mkdirSync(join(garage, 'accounts'), { recursive: true })
mkdirSync(project, { recursive: true })
const context = { cwd: project, home, secrets: secretPathsOf(home, garage) }
afterAll(() => rmSync(root, { recursive: true, force: true }))

const READ_ONLY = [
  'ls',
  'ls -la src',
  'ls ~',
  'ls *.ts',
  'cat package.json',
  'cat /etc/hosts',
  'head -n 20 src/a.ts',
  'tail -n 5 log.txt',
  'wc -l src/*.ts',
  'pwd',
  'which node',
  'echo hello world',
  "echo 'a; rm -rf ~'",
  'grep -n foo src/a.ts',
  'grep -rn TODO src',
  'rg foo',
  'rg -n "useState" packages/ui',
  'find . -name "*.ts" -type f',
  'tree -L 2',
  'du -sh .',
  'df -h',
  'stat package.json',
  'file README.md',
  'git status',
  'git status --short',
  'git log --oneline -20',
  'git diff HEAD~1',
  'git show HEAD:package.json',
  'git branch',
  'git branch -a -vv',
  'git branch --list "feat/*"',
  'git branch --show-current',
  'git rev-parse --abbrev-ref HEAD',
  'git ls-files',
  'git blame src/a.ts',
  'git remote -v',
  'git -C ../other status',
  'git --no-pager log -1',
  'git stash list',
  'git tag',
  'git config --get user.name',
  "sed -n '1,20p' src/a.ts",
  'cat src/a.ts | head -20',
  'ls | wc -l',
  'git log --oneline | grep fix | head',
  'cd src && ls',
  'ls src; ls test',
  'ls nope || echo missing',
  'ls nope 2>/dev/null',
  'ls 2>&1 | head',
  'cat .env.example',
  'sort names.txt | uniq -c',
  'date +%Y',
]

const ASKS = [
  // Writes, redirects and pipes into writers.
  'ls > x',
  'ls >> x',
  'ls &> x',
  'cat a | tee b',
  'echo hi > /etc/hosts',
  'cat < a',
  'touch x',
  'rm -rf build',
  'mkdir x',
  // find and git that change things.
  'find . -delete',
  'find . -name x -exec rm {} \\;',
  'find . -execdir sh -c x \\;',
  'find . -fprint out',
  'git branch -D x',
  'git branch -d x',
  'git branch -m a b',
  'git branch newbranch',
  'git tag v1',
  'git checkout main',
  'git commit -m x',
  'git push',
  'git -c core.pager=evil log',
  'git config user.name x',
  'git remote add x y',
  'git stash',
  'git reflog expire --all',
  'git diff --output=x',
  // Substitution and expansion.
  'echo $(rm -rf ~)',
  'echo `rm -rf ~`',
  'cat <(rm x)',
  'echo $HOME',
  'echo "$(id)"',
  'cat ${HOME}/x',
  // Chains with a writer.
  'ls && rm x',
  'ls; rm x',
  'ls || rm x',
  'ls & rm x',
  'ls &',
  // Commands that run other commands.
  'FOO=1 ls',
  'sudo ls',
  'xargs rm',
  'ls | xargs cat',
  'env ls',
  'sh -c ls',
  'bash -c "ls"',
  "awk '{system(\"rm x\")}'",
  "sed -i 's/a/b/' x",
  "sed 's/a/b/w out' x",
  "sed -n '1e rm x' a",
  'rg --pre ./evil foo',
  'sort -o out in',
  'uniq in out',
  'tree -o out',
  './script.sh',
  '/bin/ls',
  'node -e 1',
  'npm test',
  'unknownprogram',
  'ls "unterminated',
  'ls |',
  // Secrets.
  'cat ~/.ssh/id_rsa',
  'ls ~/.ssh',
  'cat ~/.aws/credentials',
  'rg foo .env',
  'cat .env',
  'cat config/.env.local',
  'cat ~/.netrc',
  'cd ~/.ssh && ls',
  'cd ~ && cat .ssh/id_rsa',
  'cat ~/.s*/id_rsa',
  'cat .e*',
  'grep -r password ~',
  'rg token ~',
  `cat "${garage}/accounts/claude-code.json"`,
  'cat ~/Library/Application\\ Support/Kothar/accounts/x.json',
  'git -C ~/.ssh log',
  'grep -r key ~/.gnupg',
]

describe('read-only commands', () => {
  it.each(READ_ONLY)('runs without asking: %s', (command) => {
    expect(isReadOnlyCommand(command, context)).toBe(true)
  })
  it.each(ASKS)('asks: %s', (command) => {
    expect(isReadOnlyCommand(command, context)).toBe(false)
  })
})

describe('secret paths', () => {
  it.each([
    [join(home, '.ssh', 'id_ed25519'), true],
    ['~/.aws/config', true],
    [join(home, '.config', 'gh', 'hosts.yml'), true],
    [join(home, 'Library', 'Keychains', 'login.keychain-db'), true],
    [join(garage, 'accounts', 'pi.json'), true],
    ['.env', true],
    ['.env.production', true],
    [join(project, 'keys', 'id_rsa'), true],
    ['.env.example', false],
    ['.envrc', false],
    ['src/env.ts', false],
    [join(garage, 'settings.json'), false],
    [join(home, '.config', 'other', 'x'), false],
  ])('%s is secret: %s', (path, secret) => {
    expect(isSecret(path, context)).toBe(secret)
  })

  it('asks before a search whose folder holds a secret, or whose filter could match one', () => {
    expect(searchReachesSecret(home, context)).toBe(true)
    expect(searchReachesSecret('/', context)).toBe(true)
    expect(searchReachesSecret(garage, context)).toBe(true)
    expect(searchReachesSecret(join(project, '.env*'), context)).toBe(true)
    expect(searchReachesSecret(join(project, '**', '.env'), context)).toBe(true)
    expect(searchReachesSecret(project, context)).toBe(false)
    expect(searchReachesSecret(join(project, '**', '*.ts'), context)).toBe(false)
    expect(searchReachesSecret(join(home, 'code'), context)).toBe(false)
  })

  it('spots a secret named in a command Kothar runs without parsing', () => {
    expect(mentionsSecret('python read.py ~/.ssh/id_rsa', context)).toBe(true)
    expect(mentionsSecret('node -e "fs.readFileSync(\'.env\')"', context)).toBe(true)
    expect(mentionsSecret(`cp ${garage}/accounts/x.json /tmp`, context)).toBe(true)
    expect(mentionsSecret('npm test', context)).toBe(false)
    expect(mentionsSecret('node -e "console.log(process.env.HOME)"', context)).toBe(false)
    expect(mentionsSecret('cp .env.example .env.sample', context)).toBe(false)
  })
})
