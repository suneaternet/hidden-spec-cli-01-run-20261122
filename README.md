# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/suneaternet/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/suneaternet/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

**mend** — one patch tool for every AI edit format. Entry for the
[make.fun bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

`mend` reads a patch (a unified diff, SEARCH/REPLACE blocks, the v4a
`*** Begin Patch` format, or JSON edits) and applies it to the working
tree, reporting what changed in a single, stable voice.

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is a path, or `-` / nothing for stdin.
- `--format=unified|search-replace|v4a|json` forces one format; without it
  the format is detected from the patch itself.
- `--check` reports what would change without writing anything.
- `--strict` matches only exact lines (no whitespace-tolerant tiers).

## Exit codes

- `0` — applied (or `--check`, nothing written)
- `1` — some edit failed (nothing written); one `error: <code> <path>`
  line per failed edit, then `failed: <k> of <n> edits`
- `2` — the patch could not be used at all (`error: usage`,
  `error: no-patch`, `error: format`, or `error: parse <N>`)

## Formats

- **Unified diff** — `diff --git` / `---` / `+++` sections with `@@`
  hunks; creates, deletes, renames, CRLF and no-trailing-newline handling.
- **SEARCH/REPLACE** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`
  blocks, one edit per block; an empty old block creates the file.
- **v4a** — `*** Begin Patch` / `*** End Patch` with `*** Add File:`,
  `*** Delete File:`, and `*** Update File:` sections, `@@` anchors,
  `*** Move to:`, and `*** End of File`.
- **JSON** — one JSON array of edit objects, or JSON Lines; commands
  `create`, `str_replace`, `insert`.

Matching is whitespace-tolerant in three tiers (exact, trailing
whitespace ignored, both ends ignored) unless `--strict` is given.
Edits apply in patch order; a failed edit changes nothing, later edits
still run, and when any edit fails no file is written.

## Development

The practice set from the kit lives next to the source; run it with:

```sh
node check.ts ../program/generator/practice.json
```

Requires Node 22+. No dependencies, no network at runtime.

## License

MIT — see [LICENSE](LICENSE).

---

<sub>Entered on [make.fun](https://make.fun/?ref=q0fbnzcq&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
