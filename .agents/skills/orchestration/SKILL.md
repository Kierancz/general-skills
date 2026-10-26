---
name: orchestration
description: 'Coordinate work using the current platform''s available subagents, separate sessions, and messaging tools. Choose Haiku for Claude and Luna for Codex by default, escalating only for complicated subtasks. Use for /orchestration, "orchestrate this", "delegate the work", "split this into subagents", or requests to coordinate several tasks. Do not use for a trivial task better handled directly or by a deterministic script.'
---

# Orchestration

Keep ownership of the overall goal, split useful work into bounded assignments,
and verify the combined result. Delegate routine work to the smaller model in
the current provider's family so the coordinating session spends its effort on
scope, dependencies, and integration.

## Choose the model for each subtask

| Coordinating runtime | Default delegated model | Complicated work |
| --- | --- | --- |
| Claude | Haiku (`model: "haiku"` when supported) | Sonnet for complex implementation; Opus for the hardest reasoning, architecture, or security decisions |
| Codex | Luna (`model: "gpt-6-luna"` when offered) | An available stronger Sol model for complex implementation; Astra or the strongest available reasoning model for the hardest decisions |

These defaults apply to native delegation of routine implementation from settled
requirements with explicit checks, bounded research, documentation, tests against
an existing specification, and mechanical edits. Where the repository's own
instructions set a different model policy, theirs wins. Bulk reading uses a
cheap scout route when one exists (below). Choose explicitly: do not let a child
inherit a stronger parent model merely because the model argument was omitted.
A large project or many files does not, by itself, make every subtask complicated.

Escalate a subtask when it requires unresolved architectural choices,
security-sensitive judgment, difficult debugging across interacting systems,
or reasoning about ambiguous requirements with expensive failure consequences.
Also escalate when a smaller-model attempt exposes a reasoning gap that remains
after clarifying the brief. Explain the concrete reason in one sentence before
dispatching a stronger model. Keep routine portions on Haiku or Luna even when
another portion needs a stronger model.

Use the model identifiers and selection mechanism actually available in the
runtime. In Codex, when `spawn_agent` permits model overrides only with
`fork_turns: "none"`, use that combination and supply the necessary context in
the assignment. In Claude, select Haiku through the native subagent or session
tool's model parameter, as supported. The same model defaults apply to separate
sessions. If the preferred model is unavailable or selection is unsupported,
report that limitation. For bulk reading, use a scout route such as a
`delegate` skill, when the repository has one, instead of a native child whose
inherited model cannot be controlled. For other tasks,
use the smallest suitable available model; do not claim a model was selected
when it was not.

Set the reasoning effort with the model, in every child. Where the tool takes
an effort parameter, pass it; where it does not, as with `create_session`, put
it in the opening line of the initial prompt. Low for mechanical work, the
default for implementation, high for anything that decides, matching the tiers
above. A child left to its default spends a frontier session's effort on a
rename, or a rename's on a design call.

## Choose the coordination method

Inspect the current platform's tools and their schemas before dispatching work.
Choose the supported method that fits the assignment; use judgment rather than
requiring one mechanism for every task. A skill guides tool use but does not
provide missing capabilities or override runtime rules on creating user-visible
chats. Where creation requires an explicit user request, honor that requirement.

- **Bulk research and scouting:** when the repository provides a scout route
  to a cheaper model (for example a `delegate` skill), use it for fan-out
  search, long-log digestion, or web and GitHub research. Read its procedure
  before launching. If it skips or none exists, choose an available fallback
  under the model and role limits here; do not silently send bulk reading to
  an inherited frontier model.
- **Subagents:** prefer these for bounded research, review, or a short task that
  fits the current session's lifecycle. Check whether they share the checkout
  and services before assigning edits.
- **Separate sessions:** when Claude exposes session creation and messaging,
  prefer separate sessions for independent work items, long-running assignments,
  or parallel implementation that needs separate containers. Use Codex's native
  session or chat tools too when available and authorized. Confirm actual file
  and service isolation; a different chat or branch alone does not establish it.
- **Direct work:** use this for a single tiny item or deterministic scripts.
  Choose the implementing role before dispatching implementation and limit it
  to one work item. Once this session is the coordinator, send implementation
  and repairs to a child writer. If delegation is unavailable, report that
  blocker and prepare handoffs instead of switching roles.

For Claude remote `create_session`, follow any launch checklist the repository
documents while applying this skill's model defaults. Every launch is two
calls, and the second is not optional:

1. `create_session` with `source_url` from the repository's origin and
   `source_revision` for the intended base branch or commit; do not assume the
   environment carries the checkout.
2. `get_session` on the returned id, **before** launching the next child or
   reporting the launch: confirm `session_context.sources` holds that repository
   and revision. A child whose sources you did not read back is unverified.

On other platforms, use the schema's equivalent source fields and checkout
verification when available.

For a separate session, retain its returned identifier and send the brief through
the native creation or messaging tool. Use supported status, read, wait, and
message tools to coordinate: send relevant dependency results, scope corrections,
answers to blockers, and follow-up assignments to the same session. Read its
current state before redirecting work and avoid redundant messages or duplicate
sessions. Prefer completion notifications or bounded waits over frequent polling.
If creation works but ongoing messaging does not, put the full assignment and
reporting requirements in the initial prompt and use the supported return path;
do not promise two-way communication.

## Coordinate the work

1. Read the applicable repository instructions and define the requested outcome
   and how to verify it. Choose and retain the session's role. Run deterministic
   scripts for work they already cover. Choose direct implementation for a single
   tiny item before dispatching; a coordinator delegates all implementation.
2. Split the remaining work by deliverable and dependency. Give each subtask a
   clear owner, file scope, and completion check. Classify its complexity and
   select its model and coordination method before dispatch.
3. Give each child a self-contained brief: goal, relevant file paths, resolved
   decisions, allowed edits, dependencies, verification commands, and expected
   report, including where to return results and how to raise blockers. Prefer
   paths over pasted files. A child started without inherited context needs the
   user constraints and repository location explicitly.
   A separate session's brief names this session's id and tells the child to
   report back with `send_message` to it: the PR URL and checks when it
   finishes, or the stopping finding and the exact question for the user
   when it stops. A child's finished transcript notifies nobody, so this line
   is in every brief, not only the ones expected to block.
   An isolated implementation child also needs an owned outcome branch and exact
   base revision. If commit and push are authorized by the original request,
   require it to push that branch and report the commit SHA, base, changed paths,
   and checks. Otherwise require an applicable patch, including new files,
   against the named base. A prose report alone does not return filesystem edits.
4. Parallelize independent read-only tasks where permitted. Follow repository
   rules for writers and shared services. By default, use one writer at a time
   per checkout; while that child works, the parent does not edit the tree.
   Parallel implementation requires separate containers and disjoint
   product-code and decision scopes. Apply any collision exceptions the
   repository's instructions list (append-only ledgers, generated catalogs);
   they never permit concurrent writers in one checkout. Do not recursively spawn more agents
   unless the brief authorizes it.
5. Inspect each child's result and actual changes. Run the relevant checks
   yourself before accepting a delegated edit; a child's claim that tests passed
   is not verification. Reconcile dependencies and coordinate integration of
   the returned branches or patches. Have a child writer apply patches and
   resolve implementation conflicts; the coordinator does not edit repairs.
6. For a failed assignment, use the evidence to narrow or clarify the brief,
   send repairs to the same child or another designated writer, or escalate for
   a demonstrated complexity issue. Do not repeat the same failed assignment
   unchanged or weaken its checks.
7. Continue until the requested outcome is complete or a concrete blocker needs
   user input. Report the result, verification, any model escalation or fallback,
   and remaining blockers. Delegation does not expand authorization to publish,
   merge, deploy, or contact people.

## Routing examples

- Claude: update documentation for an already specified behavior → Haiku.
- Codex: add tests and a straightforward fix with clear acceptance criteria → Luna.
- Claude: implement two independent features requiring their own running stacks →
  separate sessions with verified container isolation; message each session with
  its scope and coordinate the results. Choose the model per feature's complexity.
- Either runtime: investigate an intermittent race across several services →
  stronger model for diagnosis; keep independent log summaries on Haiku or Luna.
- Either runtime: choose a new authorization boundary → stronger reasoning model;
  the coordinator reviews the decision before implementation proceeds.
