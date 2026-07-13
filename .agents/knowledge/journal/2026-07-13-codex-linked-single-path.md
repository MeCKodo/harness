# Codex linked worktrees use one Harness lifecycle path

Date: 2026-07-13

## Decision

Ordinary Codex repositories use project `.codex/hooks.json`. A Git linked worktree using the fallback uses only the allowlisted user dispatcher. During fallback installation Harness removes its own exact project SessionStart/Stop commands while preserving every foreign project Hook group and command.

Hook status treats a linked worktree that contains both the user dispatcher registration and a project Harness command as `DEGRADED` until installation is rerun.

## Why

Real Codex 0.144.1 release probes showed surface-dependent behavior: Orca-linked sessions required the user dispatcher, while a plain linked worktree loaded both the project Hook and user dispatcher. The latter executed SessionStart twice and Stop twice, duplicating checks and creating concurrent state writes.

A runtime lock would hide the duplicate configuration and add stale-lock recovery. Removing the redundant managed project commands gives each repository shape one deterministic path and leaves third-party project Hooks untouched.
