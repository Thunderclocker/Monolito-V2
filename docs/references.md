# `_references/`

Vendored reference material used to design and validate Monolito V2.

## What this directory is

This is a **local research corpus**, not a runtime dependency. Each
subdirectory is a frozen checkout of an open-source project that was
read, studied, and partially absorbed into Monolito V2. Nothing in
`_references/` is built, imported, or shipped.

The directory is listed in `.gitignore` so it does not pollute the
git history with upstream code. The contents here are working copies
that the development environment keeps on disk for offline
reference and for LLM agents that need to compare implementations
side-by-side.

## Layout

| Path                 | Upstream                                                | Used for                                              |
|----------------------|---------------------------------------------------------|-------------------------------------------------------|
| `claude-code/`       | Anthropic Claude Code                                   | IPC patterns, slash-command conventions, settings     |
| `free-code/`         | A fork of OpenClaude used as a starting point           | Base architecture, tool harness ideas                 |
| `gemini-cli/`        | Google Gemini CLI                                       | TUI conventions, command routing                      |
| `hermes-agent/`      | Prior Monolito-V2 lineage (`.hermes/` runtime)          | Multi-agent patterns, channel management              |
| `mempalace/`         | Memory Palace concept reference                         | Schema design, recall semantics                       |
| `openclaw/`          | OpenClaw agent framework                                | Agent profiles, OAuth flows                           |
| `symphony/`          | Elixir-based agent orchestrator (read-only)             | Multi-agent coordination patterns                     |

The `claude-code/` and `free-code/` directories also include
`Repomix.txt` exports — flattened text dumps of the upstream
repositories that are useful for LLM context windows.

## How to use it

If you are an agent working on Monolito V2 and want to compare an
upstream implementation:

1. Open the relevant subdirectory.
2. The original `README.md` and `CHANGELOG.md` of the upstream are
   intact and may be the fastest entry point.
3. If you need to read a flat text dump for an LLM context, look for
   `*Repomix.txt` in the subdirectory root.

## How to update it

```bash
cd _references/<project>
git fetch --all
git reset --hard origin/main   # discard any local notes
```

There is no automation. The contents are updated by hand when a new
pattern needs to be studied or when an upstream release changes
something we care about.

## When to remove a subdirectory

Remove a `_references/<project>/` directory when:

- The patterns it taught have been fully absorbed into Monolito V2
  AND
- The upstream has not changed in a way that would make a re-read
  worthwhile AND
- At least 6 months have passed since the last useful diff

Removing a subdirectory is a one-line commit:

```bash
git rm -r _references/some-project
git commit -m "chore: drop absorbed reference corpus (some-project)"
```

Do not "save" the directory "just in case". The cost of a fresh
clone is minutes; the cost of dead reference material in a working
repo is years.

## What this is NOT

- Not a git submodule. The subdirectories are plain checkouts.
- Not a vendored dependency. Nothing in `src/` imports from here.
- Not a build artifact. Do not run `npm install` in any of these.
- Not for distribution. The `.gitignore` rule covers this; if you
  bypass the ignore and commit the contents, that commit will be
  reverted.

## Note on licensing

Each upstream project retains its own license. Their `LICENSE.*`
files are inside the subdirectories. None of the upstream code is
copied into Monolito V2's `src/` — only patterns and design ideas
were absorbed. If you do copy code from one of these into
Monolito V2, the responsibility for license compatibility is on the
agent that did the copy.
