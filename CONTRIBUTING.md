# Contributing

Bug reports, focused fixes, and ideas are welcome. For a substantial change,
open an issue first so we can agree on the problem and scope.

## Work on a change

1. Fork the repository and branch from `dev`.
2. Follow the [development guide](docs/development.md) and [project rules](AGENTS.md).
3. Keep the change focused. Add regression coverage when behavior changes.
4. Run the checks for the code you changed and describe the results.
5. Open a pull request against `dev`. Maintainers promote reviewed work from
   `dev` to `master`.

Use [Conventional Commits](https://www.conventionalcommits.org/), for example
`fix(diff): preserve the final newline`. Keep code, comments, fixtures, and
development documentation in English. UI translations belong in the designated
locale JSON resources; localized README files are welcome.
Preserve the behavior of the underlying command-line tools and keep large
repositories responsive.

## Report a bug

Include the app version, operating system, steps to reproduce, and expected
behavior. Use a small invented repository when possible. Remove private paths,
hosts, repository names, credentials, and other sensitive data from logs and
screenshots. Never attach a live workspace dump.

Report security concerns through the [security policy](SECURITY.md).

## Work together

Be respectful, specific, and constructive. Discuss the change rather than the
person. Harassment and the publication of someone else's private information
are not welcome. Maintainers may remove content or restrict participation that
undermines a safe, productive discussion.

Contributions are licensed under the project's [MIT license](LICENSE).
