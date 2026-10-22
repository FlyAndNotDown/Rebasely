# AGENTS.md

## Commits

Every commit uses [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): subject
```

- Types: `feat`, `fix`, `perf`, `refactor`, `style`, `test`, `docs`, `build`, `ci`, `chore`.
- The subject is imperative, lowercase, and has no final period.
- Add a scope for one area, such as `history`, `diff`, `p4`, or `git`.
- One concern per commit. Put the reason in the body when the subject cannot hold it.

## Live workspaces

Inspecting a live Git or Perforce workspace while debugging is allowed. Pasting it into the repository is forbidden.

Source, tests, fixtures, comments, sample UI, and commit messages must not contain a real person, client, hostname, email, depot, stream, server, port, changelist number, or machine path. The About dialog author is the only identity that belongs in the tree.

Invent fixture values: `alice@dev-pc`, `//depot/main/file.txt`, `C:\work\client\file.txt`, changelist `42`.
