# The exchange contract

This file is NOT an agent template and is NOT installed into
# ~/.pi/agent/agents. It is the canonical shape of the messages that cross the
# manager/child boundary, read at runtime by getManagerPrompt() in config.ts and
# appended to the manager prompt when /blender is entered.
#
# Why a separate file rather than prose inside blender-manager.md: the brief
# skeleton and the stop conditions are the two things a reader checks by
# *shape* rather than by memory. Given their own file, they are one artifact to
# edit, one artifact to diff in review, and one artifact to point at when an
# exchange goes wrong.
#
# Why it holds the BRIEF and the STOP CONDITIONS but NOT the report shapes: the
# manager WRITES briefs, so the skeleton belongs in the manager's context. A
# child RETURNS a report, and the only thing guaranteed to be in a freshly
# spawned child's context is its own agent definition -- so each report block
# stays in the agent file that has to emit it. Copying them here would create a
# second copy that nothing reads and no test keeps honest.
#
# The installer skips this file for the same reason it skips blender-manager.md
# and for a stronger reason: `scripts/install-agents.mjs` installs every *.md it
# finds here, and an agent definition with no `name:` in its frontmatter is not
# a harmless artifact -- it is a spawnable prompt with no name.

## BRIEF

The manager fills this in and passes it as the child's task. Field by field:

- **Workspace** — the absolute workspace path. Every Blender tool call a child
  makes needs it, and a child cannot infer it.
- **Module** — the `modules/<name>/` directory the child owns.
- **Goal** — one line. Not a paragraph, and not a restatement of the user's
  request: the child sees the user request only if you put it in the brief.
- **Owns** — the EXACT object names this child may create or modify. A brief
  without this produces competing models, not a shared one.
- **Must not touch** — sibling object names, restated as a prohibition. The
  worker prompt repeats this because it is the rule a child breaks when it
  tries to be helpful.
- **Expect absent** — sibling names this child's part depends on that do not
  exist yet. Naming them is what stops a fan-out from deadlocking on its own
  assumptions.
- **Scene info categories** — the literal `categories` list to pass to
  `blender_scene_info`, e.g. `["objects"]` or `["objects", "materials"]`. Name
  it HERE, not "whatever the task needs": an omitted `categories` returns the
  entire scene payload on every call, and deciding once in the brief is cheaper
  than letting six children each discover it in their own transcript.
- **Reference** — the registered reference id and path, plus the describer's
  `Subject` / `Viewpoint` / `Suggested view`, when the task has one. Never
  describe a picture yourself; you cannot see it.
- **Execution** — who runs the script. `you run it` or `a script-runner owns
  execution, stop after authoring`. Getting this wrong is a concurrency
  failure, not a slow build.
- **View** — the camera or saved view to render from and judge against, and
  whether an aligner has already produced it. A child that picks its own
  framing cannot be compared to a previous iteration.
- **Accept when** — the criteria the critic will judge against. Writing them
  here is what stops a critic inventing requirements the brief never stated.
- **Report to** — `contact_supervisor` with `reason: "need_decision"`, for a
  decision the child is not authorized to make.

## STOP CONDITIONS

Both ends obey these, and they are here because they are shared: a child hits
one from its own file, and you apply one to your own loop.

- **Second byte-identical error -> escalate.** A fix that did not change the
  error did not change the cause. Three distinct errors may each get an
  attempt; the same error twice gets a `contact_supervisor` call with the text
  verbatim. This is the rule that bounds a failure run: a worker that repeats
  one traceback is re-paying for the whole context that produced it, every time,
  for the same answer.
- **Second identical verdict -> diagnose, do not iterate.** When two
  consecutive critics report the same failure, read them side by side: they are
  the cheapest diagnostic available and they say the last brief did not change
  the condition. A third identical brief produces a third identical render.
  Route it to `blender-diagnostician` for a measurement, or change the
  approach — do not run the loop again.
- **Subject missing -> stop.** A `[view]` or score verdict against a subject
  that was never built is meaningless. A worker whose part is not there, or a
  critic reporting `Subject match: reference-only`, ends the loop rather than
  iterating toward a better picture of nothing.
- **Iteration ceiling is real.** Five iterations per user instruction, three
  aligner attempts, three distinct worker self-fixes. Hitting a ceiling is
  information to report, not a budget to spend quietly.

## What the manager does not send

Rounding these out is as load-bearing as filling the fields in:

- **No findings you derived by looking.** You are blind. A render shows a critic
  THAT something is wrong; only `blender_geometry_probe` shows a worker HOW.
  Put the diagnostician's measured numbers in the brief, or send the symptom.
- **No module source, no logs, no raw JSON.** A child can read the file it owns.
  Pasting a script into a brief doubles the cost of the brief and gives the
  child a second, drifting copy of the truth.
- **No restated tool schemas.** Use the tool definitions directly; a prose
  paraphrase of a schema in a brief is wrong within a release and expensive in
  every token.
- **No re-asking a settled question.** If the user answered a fork, the brief
  states the answer. The child is not consulted about scope again.
