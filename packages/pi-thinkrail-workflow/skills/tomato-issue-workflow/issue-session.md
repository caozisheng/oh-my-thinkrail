# 01 — Enter and resume

Entry: an explicit Tomato Issue request names design or implementation and a provider-qualified Issue. Save the verified binding and current stage; route to `plan-and-targets.md` for unresolved scope, or to the requested lifecycle use case.

## Trigger and entry state

Start only from the explicit launch, never from a referenced Issue or label. Require provider, instance, project and Issue id. The host supplies bound repositories and the active workspace/session.

## Automatic steps

1. Attempt `issue_context` before Issue-dependent conclusions, Issue-specific requirements, and any remote operation. Missing summary capability does not block work.
2. If the context tool is missing or its read fails, do not infer Issue content or identity. Continue ordinary repository work requested by the user through the normal repository workflow; Issue capability failure blocks only actions that depend on that capability or verified Issue context. Do not infer Issue-specific requirements from unavailable context. Mark the Issue context as unavailable and distinguish local results from unverified Issue requirements; do not claim the Issue was read or updated.
3. When context is available, read the fresh Issue description, returned comments and references, then verify returned provider, instance, project and Issue id against the launch before relying on Issue content or taking Issue-scoped action. A mismatch blocks Issue-dependent work and all remote operations, but does not prohibit independent local research or checks.
4. Read each bound repository's instructions and relevant owning specs; do not combine or execute repository configuration.
5. On resume, reread host context and structured operation state relevant to the next action. A remote mutation or Issue update still requires the applicable host capability and its identity/authorization checks.

## Host capabilities

`issue_context` provides current bound context and repositories; `issue_record_summary` records the sanitized handoff. Host-bound repositories identify scope, not a shell sandbox. Do not impose an extra completeness-marker or comment-count gate.

## Completion, questions and recovery

A fully Issue-informed session has matching Issue identity, explicit stage and usable context. Missing identity or failed context read blocks Issue-dependent conclusions and remote operations, not independent local work. Ask only for a missing or conflicting requirement that changes the requested work. Never guess a repository, workspace, stage, target or permission.

## Handoff

Route to `plan-and-targets.md` when target/scope decisions remain; otherwise route to `design-and-implementation.md`, `validation.md`, or the requested delivery use case. On blocked/partial work, return to the caller with the chat handoff and best-effort publication status under `SKILL.md`'s ending.
