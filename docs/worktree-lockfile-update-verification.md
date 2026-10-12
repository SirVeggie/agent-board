# Worktree lockfile update verification (#482)

Verified on Windows with Node v25.2.1 and npm 11.6.2 on 2026-10-12.
The reproduction used a disposable Git repository and a real Git worktree
inside the task workspace. It never ran npm against Scribe's shared dependencies.

## Reproduction

1. Commit a minimal dependency-free `package.json` and v3 `package-lock.json`
   in a fixture main checkout, then create a worktree with `git worktree add`.
2. Create `main/node_modules/.package-lock.json` (v3, empty `packages`) and
   a sentinel file, then junction the worktree's `node_modules` to that directory.
3. Restrict the fixture hidden lockfile: set its read-only attribute with
   `attrib +R`, deny the current account deletion with `icacls /deny account:(D)`,
   and deny delete-child on its containing directory with
   `icacls /deny account:(DC)`. This models a shared checkout that npm cannot write.
4. In the worktree, run
   `npm install --package-lock-only --ignore-scripts --offline --no-audit --no-fund`
   with a fixture-local npm cache.

The command failed with `EPERM`, syscall `unlink`, at
`worktree/node_modules/.package-lock.json`, which resolved through the junction
to the fixture main checkout. `--ignore-scripts` did not prevent the attempt.

## Corrected workflow

Verified the path was a junction, then ran `cmd /c rmdir node_modules` in the
fixture worktree. Changed its package version from `1.0.0` to `1.0.1` and reran
the same npm command with the fixture main checkout still restricted. It exited
successfully and updated the worktree's root lockfile to version `1.0.1`.

Compared the contents and modification times of the fixture main checkout's
`package.json`, `package-lock.json`, hidden lockfile, and dependency sentinel
before and after both runs. All were unchanged. Restrictions were removed only
for snapshot reads and cleanup. The junction was removed before recursively
cleaning the disposable fixture.

The generated instructions now require verifying and removing the shared link
before dependency changes, including lockfile-only updates. The focused
`src/agent/prompt.test.ts` suite passed all 19 tests, including checks for the
removal step, platform commands, and `--ignore-scripts`.
