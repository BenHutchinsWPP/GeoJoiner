# Agent Guidelines (AGENTS.md)

Welcome, Agent. This project values simplicity, performance, and maintainability. To keep the codebase lean and fast, follow these rules derived from the **Ponytail** developer philosophy:

## Core Rules

1. **YAGNI (You Aren't Gonna Need It)**
   - Do not write code for speculative future needs. 
   - Implement only the features requested. If an optimization or abstraction is speculative, skip it and document why.

2. **Standard Library and Platform First**
   - Leverage standard Web APIs and TypeScript features before pulling in external dependencies.
   - Do not add runtime spatial libraries (like Turf.js or Geolib). The spatial index and point-in-polygon checks are hand-rolled for zero-dependency runtime execution.

3. **Fewest Files & Shortest Diffs**
   - Consolidate code instead of fragmenting it. Prefer single-file modules for cohesive systems (e.g., the spatial index lives entirely in `src/geo/spatialGrid.ts`).
   - Write the shortest working diff. Fewer lines mean fewer bugs.

4. **Delete Over Add**
   - Clean up dead code, unused exports, and stale files.
   - Boring, straightforward code is always better than clever, complex code.

5. **No Unrequested Abstractions**
   - Avoid creating interfaces with a single implementation, factories with a single product, or configs for values that never change.

6. **Self-Documenting Ceilings**
   - When making a deliberate simplification or shortcut (e.g., a simple scan instead of a tree), label it with a comment prefix `// ponytail: [desc], upgrade when [trigger]`.

7. **Test What Matters**
   - Trivial code requires no tests. Non-trivial logic (e.g., parsers, formats, indices) should have simple, automated unit tests. Do not create complex test fixtures unless explicitly requested.

## Hard rules

- **NEVER read, list, or grep `venv/`, `tmp/`,
  `node_modules/`.** Large binaries; nothing useful for code work.
  To inspect a dataset's schema/values, *run* the relevant script and print
  (`df.head()`, `ogrinfo -so`, `head` on a built `.csv`) — never open files in
  `data/`.
- **No AI authorship in commits.** Never add a `Co-Authored-By:` trailer naming
  an AI (Claude, Copilot, etc.), a "Generated with …" line, or any similar
  attribution to a commit message, PR title, or PR body. AI assistance is
  already disclosed once, at the project level, at the bottom of
  [`README.md`](README.md) — repeating it per commit is noise. Commits are
  authored by the human who owns the change. Write the message as a plain
  description of *what changed and why*.

