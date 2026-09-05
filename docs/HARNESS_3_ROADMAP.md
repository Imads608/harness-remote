# Harness Remote product and architecture

This document describes the durable product model and engineering boundaries for Harness Remote as
they ship on `main`.

> **Status (2026-08-30):** Harness Remote 3.0.0 is released and `main` is the canonical 3.x
> development baseline. The `v3.0.0` tag is the immutable release point. The former
> `checkpoint/v3-session-first-working-2026-08-25` branch is retained as release-development
> history/reference, not as the branch for new feature work.
>
> Post-release work is tracked as focused follow-ups: architecture simplification (#330),
> repository branch hygiene (#290), and cross-machine native Session handoff (#347).

## 1. Product thesis

Harness Remote 3.0 is a **vendor-neutral, local-first control plane for native coding-agent Sessions**.

The promise is:

> **Your sessions. Any coding agent. Any device.**

Harness Remote does not try to become another coding agent or to replace the Session model already owned by Codex, GitHub Copilot CLI, Claude Code, OpenCode, OMP, PI and future harnesses.

## 2. User-facing model

The product model is built around native Sessions:

```text
Machine
  Project
    Native Session
    Native Session
    ...
```

A Project is a real working directory/repository.

A Native Session is the real Session owned by its harness.

Older Task, Run and Conversation terms may remain in internal compatibility code, but they are not
required user-facing abstractions.

## 3. Architecture boundary

### Harness Remote owns

- machine discovery and routing;
- Project/filesystem boundaries;
- harness discovery and capability metadata;
- per-harness model discovery;
- native Session discovery and presentation;
- remote observation and control;
- cross-agent continuation metadata;
- desktop, web and Android experience;
- release-level reconciliation and diagnostics.

### Native harnesses own

- Session transcript/history;
- native context and memory;
- reasoning and assistant output;
- tools;
- permissions/questions;
- model behavior;
- native writer ownership;
- resume and compaction semantics;
- native Session persistence.

Architecture rule:

> If the harness already owns a capability well, Harness Remote should orchestrate it rather than clone it.

## 4. Native Session UX

Expected flow:

```text
start a native Session anywhere
  -> open Harness Remote
  -> discover the same Session
  -> observe it
  -> continue it when native ownership permits
```

No attach/import step is required merely to read or resume a Session.

The main surfaces are:

```text
Home / Machine
  Active Sessions
  Recent Sessions
  Projects
  Machines

Project
  Sessions
  Changes

Session
  transcript
  Activity
  harness + model
  live status
  Stop
  Continue with another agent
```

## 5. Observe vs Continue

Read access and writer ownership are different capabilities.

Harness Remote represents native behavior honestly per harness:

- discover/list;
- lookup by native Session ID;
- observe transcript;
- create;
- resume/continue;
- writer takeover rules;
- Stop/cancel;
- rename/delete;
- model and variant discovery;
- live event support.

Observation must never silently steal native writer ownership.

## 6. Cross-agent continuation

Switching coding agent remains a core 3.0 capability, but it is built on native Sessions.

Example:

```text
OpenCode Session A
  -> Continue with Codex
Codex Session B
  -> Continue with Claude
Claude Session C
```

Each Session remains native.

Harness Remote may retain linkage such as:

- continuedFrom;
- continuedTo;
- Project;
- machine;
- timestamps;
- minimal handoff/recovery context.

No universal fake Session protocol is required.

## 7. Workspace model

Normal Sessions work in the selected Project's real directory.

Hidden daemon-managed worktrees are not the default. Worktree isolation may exist only as an explicit parallel-work option with visible path, branch and lifecycle.

## 8. Reliability rules

Release-critical behavior:

- prompt reaches the intended native Session exactly once;
- no duplicate/empty user turns;
- no duplicate assistant turns;
- streamed output converges to the complete final answer;
- reasoning/tools stay attached to the correct turn;
- Activity becomes live as soon as the harness starts working;
- finished turns return to Ready;
- Stop reaches the native harness;
- model selection is machine/harness/Session correct;
- navigation and paging preserve Session identity;
- old Sessions remain readable;
- reconnect does not overwrite a later valid completion;
- observation does not silently acquire writer ownership;
- listeners/subscriptions/cache state remain bounded;
- typing and scrolling remain responsive in long Sessions.

## 9. Supported harnesses

The current 3.0 line supports:

- OpenCode;
- Codex CLI;
- GitHub Copilot CLI;
- Claude Code;
- Oh My Pi (OMP);
- PI.

Capability differences are preserved rather than flattened into invented common behavior.

## 10. Current product surface

Harness Remote provides:

- native Session navigation and product model;
- native Session discovery/read/create/continue;
- multi-machine Session creation;
- stable Session list UX;
- transcript paging and scroll preservation;
- model lifecycle fixes;
- Claude lifecycle/status fixes;
- OMP ACP rebuild and legacy Session support;
- desktop/web regression coverage;
- Linux/macOS/Windows bridge coverage;
- Chromium product smokes;
- signed debug APK production in CI.

## 11. Ongoing release standard

Every release must validate the product against real installed harnesses and on mobile devices. At a
minimum, verify:

1. connect to an existing machine;
2. switch between machines if more than one is configured;
3. open existing Sessions from each available harness;
4. create a new Session with explicit machine, Project, harness and model;
5. run several consecutive turns;
6. verify live Activity and complete final responses;
7. background/foreground the app during a working turn;
8. verify keyboard/composer behavior;
9. load older history;
10. Stop a real turn;
11. switch away and back without losing Session/model state;
12. verify no obvious layout/navigation regression in portrait.

Fixes found by this validation must pass the complete automated suite again before release.

## 12. Product evolution

The following work improves the product without changing its core contract:

- remove obsolete internal Task/Run compatibility code where safe;
- simplify old naming and dead migrations;
- finish remote branch cleanup;
- prune obsolete historical test helpers;
- improve capability documentation;
- expand real-harness CI/smoke coverage where practical;
- add more coding agents only after existing adapters remain reliable.

## 13. Recovery and compatibility

Keep stable branches and known-good release tags available as recovery points. Compatibility code
may protect existing installations, but it must not determine the product experience or reintroduce
retired user-facing abstractions.

## 14. Success criterion

Harness Remote 3.0 succeeds when a user can open the app and immediately recognize the native coding-agent Sessions they already work with, observe or continue them remotely, start new real Sessions, and switch agents without losing Project or work continuity.

The release has failed if the user has to ask:

- Where is the Session I already started?
- Is this the real native Session or a Harness Remote copy?
- Why is the transcript duplicated or incomplete?
- Why did the reply appear only after navigation?
- Why did the selected model change by itself?
- Why did Stop not reach the harness?
- Why did the app lose my Session after switching machine or backgrounding?
