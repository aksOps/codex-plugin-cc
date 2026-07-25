# Fleet v0 Archive

This directory is a frozen reference snapshot of the original Fleet prototype.
It is not part of the active plugin and must not be imported, packaged, tested,
or executed by the root project.

## Provenance

- Source commit: `d1a000761677520cdd57efdd8773482d44486567`
- Source branch: `main`
- Snapshot date: 2026-07-25
- The archived `.gitignore` also includes four uncommitted user changes:
  `.claude/`, `.codegraph`, `GOAL.md`, and `EXECUTION_PLAN*.md`.

The source repository had no configured remote. Its commit history remains in
the untouched rollback checkout rather than being merged into the fork's
upstream history.

## Why It Was Archived

Fleet demonstrated deterministic routing, quota-aware degradation, bounded
failure ladders, worktree scheduling, and cross-provider execution. The review
also found release-blocking trust and lifecycle problems:

- caller-provided approval was treated as authoritative;
- command verification could invoke a host shell;
- expected verification results were not consistently enforced;
- hook failures could pass through;
- job recovery was not durable across fresh processes;
- plugin packaging depended on the source checkout; and
- no trusted reviewed-merge capability existed.

These findings make the snapshot unsuitable as a production runtime. Useful
behavior should return through new tests and deliberate implementation against
the fork contract, not by importing archived modules.

## Exclusions

The snapshot contains the tracked source tree and the working `.gitignore`.
Dependency installations, generated state, local Claude configuration,
CodeGraph data, OMO plans and evidence, and test artifacts were intentionally
excluded. Those local materials remain in the rollback checkout.
