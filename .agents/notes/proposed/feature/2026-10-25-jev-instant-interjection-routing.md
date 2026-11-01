# Agent Note: Jev interjection routing and DSH response interruption

Status: proposed

English | [中文](2026-10-25-jev-instant-interjection-routing.zh.md)

## Problem

A direct user message during an active task can add later work, supplement the current task, or invalidate the current approach. Jev previously routed corrections to the nearest step, but ordinary DSH steering did not end the current model response. The response could therefore continue after the user identified a wrong premise. Cancelling the whole turn changes the activity lifecycle and cannot express correction within that turn.

Classification needs the current task and execution facts. A separate model summary would add latency and could replace the user's words with an inaccurate interpretation. Recent output alone can also crowd the original task out of a limited context budget.

## Proposal

DSH owns interruption of one model response; Jev chooses the semantic route through the public API. Jev classifies active direct user input as `follow-up`, `steer`, `interrupt-steer`, or `unknown`. A valid immediate correction requests interruption, then enters the next step of the same turn through normal input admission. The normal path makes one classification request and no summary or planning request.

The route depends on the message's meaning in the current task, not its tone or a keyword. Invalidating the current direction, changing a key premise, or explicitly asking the agent to yield now can justify `interrupt-steer`. The classifier uses original user messages, recent recorded assistant text, necessary tool facts, and code-observed execution state. Reads and transmitted text remain bounded; missing material never becomes an invented task summary.

The local implementation and deterministic verification are complete. DSH remains unmerged in [draft PR #1 on the fork](https://github.com/luobosibing2/deepseek-harness/pull/1); the official repository currently disables pull requests. Jev's [companion PR #54](https://github.com/luobosibing2/dsh-jev-plugin/pull/54) includes a verified `main` integration baseline. On 2026-11-01 the author authorized independent subagent verification and the commits, pushes, and PR creation needed to submit the work, including this complete planning record. Real-model calls, package publication, and target-branch merges remain outside that authorization.

### Scope and ownership

The change covers DSH's public response interruption, same-turn continuation, and stream records, plus Jev's three routes, deterministic context extraction, application of valid judgments, and receipts. Jev uses public extension points and does not read or modify DSH's private loop state.

The first version interrupts model generation and waits before retrying a failed model request. Started tools, maintenance work, and native cancellation of the whole active turn retain their existing rules. The feature preserves the existing switch, input identity, editing and removal, manual Retry/Cancel, and recovery behavior. It promises no unmeasured latency or classification accuracy.

## Added requirements

- **REQ-JIR-01 — Response interruption:** DSH provides a public capability distinct from whole-turn cancellation. A valid immediate correction can interrupt generation or a model-retry wait even before the model returns any stream chunk. Interruption must not wait for another chunk. Its signal does not cancel a started tool. Outside an eligible response or retry wait, the request makes no extra model call, cancels no turn, and does not wake an idle agent.
  - Acceptance: while the old response remains stalled, applying a valid correction aborts its model-request signal; the current turn signal and any started tool signal remain un-aborted.
- **REQ-JIR-02 — Same-turn continuation:** DSH durably settles the interrupted response and ends its step before normal admission receives the correction in the same turn. It must not report whole-turn user cancellation, bypass admission rejection, or retry the old context as if the correction were a model failure.
  - Acceptance: accepted input appears verbatim in the next request in the same turn, with no false cancellation, idle transition, or new turn between requests. Rejected admission makes no new request and retains its existing rejection semantics.
- **REQ-JIR-03 — Interrupted content:** Retain nonempty text and reasoning already produced under DSH's interrupted-content rules, and exclude unexecuted tool calls from that response. Record an interrupted assistant message when content exists, otherwise an assistant attempt. Settle each response once. The next request consumes normal history derivation and adapter projection; the feature does not recover invisible model computation.
  - Acceptance: retain and mark partial text as interrupted; do not execute streamed tool calls or leave historical calls without results. An empty response leaves only an attempt. If durable settlement fails, do not issue a new request that depends on that history.
- **REQ-JIR-04 — Fast classification path:** Code reads, selects, and clips existing data without a summary, planning, or semantic-preparation model call. A stable message and task produce one Jev classification request that only selects a route, without explanation or rewriting. Do not reclassify per token, stream chunk, or timer, or add full Session-log scans, repository searches, or file-content reads to the interjection path.
  - Acceptance: observe one classification request and zero auxiliary model requests for stable input; later chunks do not increase that count. Manual retries, message edits, and genuinely expired results may trigger reclassification only when associated with their actual cause.
- **REQ-JIR-05 — Apply and recheck:** After successful classification, Jev immediately attempts a valid interruption without waiting for the next pre-step. Recheck message identity, content version, owning activity, and current task first. An old judgment cannot affect a task that starts after its original activity ends. If the response finished or tool execution began, deliver the still-valid correction at the nearest normal step without claiming that the model was interrupted.
  - Acceptance: a classification that completes while the response is stalled immediately requests interruption. Removing or editing the message, or natively stopping the activity before classification finishes, prevents its old result from interrupting or restarting work.
- **REQ-JIR-06 — Observable records and integration:** Distinguish route selection, interruption request, actual response settlement, and admission of the original user message. A route judgment does not mean the model received the correction or a tool stopped. Model-visible content remains reconstructable from DSH Session records; Jev judgments and execution receipts use its existing records. Admit the original input once.
  - Acceptance: Session and Jev records identify the actions that occurred, without false interruption success outside eligible stages. Web transcripts and both SDKs show same-turn continuation without declaring the whole activity finished early.

## Modified requirements

- **REQ-JIR-07 — Three semantic routes:**
  - Before: enabled routing classified active direct user messages as `correction`, `queue`, or `unknown`; `correction` entered the nearest step without cancelling the active model request.
  - Proposed behavior: classify only direct user messages for an active root agent with routing enabled, including messages originally submitted through queue or steer. `follow-up` means later work after the current task; `steer` supplements the current task without evidence to end the present step; `interrupt-steer` means the current direction or key premise is invalid, or the user explicitly requests an immediate yield. Insufficient context gives `unknown`. Tone, one negative word, and quoted material cannot independently select a route. When later work and an immediate correction coexist, the correction takes priority; deliver the complete original message once without splitting it into tasks.
  - Acceptance: during analysis of the wrong repository, “Please pause; you have the wrong repository” selects `interrupt-steer`; “Quickly add tests after this is done” selects `follow-up`; a final-presentation requirement that does not invalidate current analysis selects `steer`. The same wording can select different routes in different task contexts.
- **REQ-JIR-08 — Deterministic classification context:**
  - Before: the request mainly contained new text, attachment types, tail-first historical text, an optional Goal, and rules. History could displace the original turn request and did not explicitly identify the live execution stage.
  - Proposed behavior: include the new message verbatim, the turn's direct user requirements and admitted amendments, an optional active Goal, recent available assistant text, necessary tool facts, and a code-observed stage. Values come directly from messages, Session-derived data, existing projections, or runtime events, preserving source identity and order. Do not summarize the task, infer hidden thinking, or add per-token reconstruction of assistant text. Tool facts contain only recent relevant names, necessary arguments, and execution state, not full tool logs; arguments are facts, not user instructions. At minimum distinguish model response, model-retry wait, tool execution, and other stages. Mark unavailable state as missing rather than inventing it.
  - Acceptance: trace request facts to original user words and existing records. The task and execution stage remain usable before main-model output. Long output cannot displace task requirements when the budget can hold them; missing attachments or prerequisites do not become fabricated material.

## Removed requirements

None. Existing follow-up, steer, inject, and whole-turn cancellation remain available. Jev's two actionable classifications expand to three routes; historical records retain their meaning and remain readable without reclassifying old input.

## Preserved behavior

- Routing stays off by default under the existing switch. Disabled routing retains DSH's original submission behavior.
- Idle new tasks, Goal messages, plugin notifications, and subagent messages remain outside automatic three-way classification.
- Preserve message identity, original text, attachments, and source. Editing invalidates the old classification; removal cancels only that input. Messages sharing a delivery target retain arrival order; `steer` and `interrupt-steer` share the nearest-step target. Classification completion order does not reorder input, and equal text does not merge distinct messages.
- Native stop or disposal still cancels the activity. Response interruption must not clear unrelated queued input, cancel Jev's lifecycle, or grant new tool permissions.
- Keep manual Retry/Cancel, disabled-period handling, and recovery: cancelling classification does not deliver the input; retry after disabling requires re-enabling first; an already-issued successful judgment applies only while message and activity remain valid; recovery does not automatically reclassify or deliver unfinished historical input.
- Existing owners retain permissions, tool admission, sandboxing, request-failure handling, and Goal management. Immediate correction changes when a response ends and when input is received.

## Inputs, defaults, ordering, and priority

New text retains the existing `messageChars` limit, default 24,000 characters. Empty or over-limit text must not be truncated into a different classifiable message. Attachments contribute only available type and content-availability facts; the feature adds no attachment read or vision-model request.

Classification context retains `contextChars`, default 12,000 characters. Task, Goal, assistant text, and tool text share that budget; new-message text has its separate `messageChars` limit. Fixed rules, identifiers, and state fields do not count toward the context-text budget. These are character limits, not token measurements. Preserve the configuration's positive-integer range and add no new set of deployment controls.

Prioritize current user requirements: select the latest admitted amendments and turn-start requirement first, then other user requirements in the turn, active Goal, recent assistant text, and necessary tool facts. Present selected material in its original order within each category and mark clipping and missing data. Do not replace text that cannot fit with a summary. Return `unknown` when omitted information can change the route. If the turn begins with a reference-dependent message such as “continue,” include available prior context within the same budget without inventing the missing task.

Later direct user amendments help identify the effective requirements; quoted or paraphrased external text is not new user authorization. Native stop, input removal, and activity completion take precedence over old asynchronous judgments. Response completion alone does not mean the task changed and must not unconditionally trigger another classification request.

Prepare one classification input when the message arrives. The normal path does not refresh it for each stream chunk. Manual retry or a genuinely expired judgment uses then-current facts. After classification, Jev still checks runtime state to determine whether an interruption request can apply.

## Failures and fallback

- `unknown`, missing necessary text, unexplained attachments, and classification transport or protocol errors retain manual Retry/Cancel. Do not silently select any actionable route or switch models.
- A DSH host without the required public capability fails explicitly. Do not simulate support with cancel plus restart. Supported-version declarations must reflect the DSH versions actually verified.
- Treat response interruption separately from real model failure. A valid immediate correction does not retry the old request; real failures without interruption retain existing recovery. Concurrent native cancellation wins.
- Failed durable recording stops dependent requests and reports failure; unreconstructable content must not reach the model. A failed auxiliary receipt must not resend input or repeat interruption.
- If no model response or retry wait accepts the interruption, a still-valid correction enters the nearest available step. Do not cancel started tools or promise synchronous cancellation of provider computation or billing.

## End-to-end delivery

Direct user input enters the existing inbox with its identity and editing support. Jev assembles bounded facts and classifies it. `follow-up` waits for a later turn; `steer` waits for the nearest step of the current turn; a valid `interrupt-steer` calls DSH's public response control and then uses the same normal admission path for the original input.

DSH owns response settlement and history; Jev does not write replacement main-model output or invent tool results. Response interruption cannot bypass admission, insert the user message twice, or invoke whole-turn completion supervision. Normal loop preparation and configured adapters still own model execution.

Reuse available original tasks, state, and recorded text. Additional Session-derived state follows the repository projection mechanism: no deprecated synchronous full-history reader and no full-log scan on the interjection path when a cache is missing. Bounded runtime state is released with its agent lifecycle.

## Public API and consumers

The implemented public API is `Agent.interruptResponse(): boolean`. `true` means this interruption request was accepted for an eligible response or retry wait; it does not mean the model already received the user message. The capability distinguishes response interruption from whole-turn cancellation, and records expose whether a response actually settled because of interruption. This records the selected API rather than preserving an earlier illustrative signature as a separate requirement.

Jev retains discrete route selection, adding immediate-correction semantics without requiring explanation on the normal path. Its existing judgment protocol owns the transport fields; an example JSON representation is not a new public API. Jev remains independently published and depends on DSH's public capability. Update all affected declaration consumers together.

Reuse existing interrupted assistant-message and attempt records without a Session-format bump solely for routing preference. Any actual persistent-type change still requires the repository's released-data review and acknowledgement; ignoring unknown events is not a compatibility substitute. Historical Jev routing records retain their meaning.

Update affected feature descriptions, API documents, and transcripts. Loop changes update the architecture and TypeScript/Python SDK expected output; new model- or user-visible behavior needs a keyless Session snapshot. Visible routing text uses the existing localization mechanism. This proposal adds no button, settings page, or shortcut.

DSH's [steer, cancel, and response control](../../../../packages/core/agent-loop/src/agent.ts#L183), [interrupted-content assembly](../../../../packages/llm/llm/src/assembler.ts#L169), [DeepSeek request cancellation](../../../../packages/llm/llm-deepseek/src/adapter.ts#L142), [turn projection](../../../../packages/core/agent/src/projection.ts#L21), and [response events](../../../../packages/core/agent/src/runtime-types.ts#L391) provide the execution and recorded-fact owners. Jev's [routing](https://github.com/luobosibing2/dsh-jev-plugin/blob/codex/jev-instant-interjection-routing/packages/jev/src/interjection.ts) and [context projection](https://github.com/luobosibing2/dsh-jev-plugin/blob/codex/jev-instant-interjection-routing/packages/jev/src/interjection-context.ts) are companion-branch references, not a DSH release dependency or a claim that either feature branch has merged.

## Related decisions

The scoped active-note review found no existing owner to replace or partially supersede. [Follow-up enqueue and owned run boundaries](../../implemented/architecture/2026-07-30-followup-enqueue-and-owned-runs.md) still separates message admission from an owned activity result. [Separate context injection from turn execution](../../implemented/architecture/2026-07-24-separate-context-injection-from-turn-execution.md) still owns independent messages and input admission. Response interruption changes neither decision. [Semantic phases for composer-chain election](../architecture/2026-08-08-semantic-composer-chain-phases.md) governs UI composer selection and remains independent. Keep these notes active; none is archived or rewritten by this proposal.

## Alternatives considered

**Add routes but keep ordinary steer.** This distinguishes intent but still waits for the active response to end, so it does not solve the delay after an immediate correction.

**Cancel and restart the turn.** This reuses an existing API but creates activity cancellation and a new turn, changing input retention, supervision, and SDK lifecycle. It cannot preserve same-turn correction.

**Summarize the task and execution state with another model first.** This can shorten classification text but adds a model wait and summary error. Original messages and existing events provide the first version's required facts.

**Copy Codex's WebSocket interruption protocol.** Separating response preemption from turn cancellation is useful, but that transport protocol cannot be assumed for DeepSeek HTTP/SSE or every adapter. Reuse DSH's cancellation support instead.

**Cancel started tools too.** This adds tool cancellation, external side-effect handling, and background-process management beyond response interruption.

## Acceptance criteria

The requirements above and cases below define completion. In particular, interruption works without a new chunk, correction continues within the same turn, text settles once, unexecuted tools stay unexecuted, and the normal path makes no auxiliary model call. Whole-turn cancellation, admission rejection, unknown classifications, and recovery retain their existing meaning. Deterministic execution evidence and real classification quality are separate results.

| Scenario | Given | When | Required result | Requirements |
|---|---|---|---|---|
| Response without output | The model request stays stalled | Valid immediate classification finishes | Abort the old request without waiting for a chunk; admit the correction and continue the same turn | REQ-JIR-01, REQ-JIR-02, REQ-JIR-05 |
| Correction during text | Partial text exists before response completion | Route is `interrupt-steer` | Settle the old text once, mark interruption, and use normal history in the next request | REQ-JIR-02, REQ-JIR-03 |
| Tool arguments still streaming | The response contains an unexecuted tool call | Interrupt the response | Do not execute it or leave a historical call without a result | REQ-JIR-03 |
| Retry wait | A failed model request is waiting to retry | A valid immediate correction arrives | End the wait without resending old context; admit input in the same turn | REQ-JIR-01, REQ-JIR-02 |
| Tool already started | A tool is executing | Route is `interrupt-steer` | Keep the tool running; deliver at the nearest step without claiming the tool stopped | REQ-JIR-01, REQ-JIR-05, REQ-JIR-06 |
| Later task | The user says “After this is done, quickly add an explanation” | Jev classifies | Select `follow-up`; urgency alone does not interrupt | REQ-JIR-07 |
| Current supplement | Current analysis remains valid; user asks to include compatibility limits in the final answer | Jev classifies | Select `steer`; continue the response and admit the addition at the nearest step | REQ-JIR-07 |
| Polite premise correction | The agent analyzes the wrong repository; user says “Please pause; the repository is wrong” | Classification is valid | Select `interrupt-steer` and immediately request interruption | REQ-JIR-05, REQ-JIR-07 |
| Same words, different task | One task is about to edit code; another already only discusses a plan | The user says “Do not edit code yet; discuss the plan” | Interrupt the first task's invalid direction; treat the second as a current constraint when no immediate response is requested | REQ-JIR-07, REQ-JIR-08 |
| Correction plus later work | The user says “Wrong directory; inspect Jev, then add an explanation” | Jev classifies | Prioritize the correction; deliver the whole original message once without splitting tasks | REQ-JIR-06, REQ-JIR-07 |
| Direct context facts | Original requirements, assistant text, and tool records exist | An interjection triggers classification | Include traceable original text and code-observed state without a summary or full tool logs | REQ-JIR-04, REQ-JIR-08 |
| Long output and budget | Requirements fit, but recent output is long | Assemble classification input | Keep task requirements first, stay within `contextChars`, and mark clipping | REQ-JIR-08 |
| Missing material | The message depends on an unread attachment or unavailable earlier context | Existing facts cannot determine a route | Return `unknown` and keep Retry/Cancel without fabrication or a silent fallback | REQ-JIR-07, REQ-JIR-08 |
| Stable call count | One message and task remain unchanged | Main-model chunks continue | Classify once, make zero auxiliary model calls, and do not reclassify per chunk | REQ-JIR-04 |
| Edit or remove input | Classification is pending | The user edits or removes the message | Old results cannot interrupt; classify edited text anew, or cancel only the removed input | REQ-JIR-05 |
| Response naturally progresses | The response finishes or starts tools during classification | A valid result returns | Do not claim the old response was interrupted; use the current activity's nearest-step delivery | REQ-JIR-05, REQ-JIR-06 |
| Native stop | Activity and possibly classification are active | The user invokes native stop | Cancel normally; a late judgment cannot restart work | REQ-JIR-01, REQ-JIR-05 |
| Admission rejection | The response was interrupted | Existing pre-step rejects correction input | Make no bypass request or false delivery receipt | REQ-JIR-02, REQ-JIR-06 |
| Durable settlement fails | The old response needs recording | Session rejects the record | Report failure and issue no request that depends on unrecorded content | REQ-JIR-03 |
| Disabled or recovered routing | Routing is off, or recovery finds unfinished classification | Input arrives or Host recovers | Preserve disabled routing and recovery rules without replaying unfinished judgments | REQ-JIR-06, REQ-JIR-07 |
| Consumer observation | Immediate correction occurs within one turn | Inspect transcript and SDK run results | Show interruption and later input without early activity completion or duplicate user messages | REQ-JIR-02, REQ-JIR-06 |

Deterministic model streams and classification results verify the execution mechanism. The semantic examples are also inputs for a separate real-judgment evaluation; scripted results do not establish Jev accuracy. Real-model calls require separate authorization. If run, measure local assembly, classification request, and response handoff separately without inventing a millisecond guarantee.

## Verification

DSH's focused regression passed 194 tests in eight files covering response interruption, cancellation, retries, request freezing, the loop, and the real compaction consumer. The ten interruption cases passed independently after test-format corrections. Native build and all runtime-artifact build stages passed; two new test type errors found by the aggregate build were fixed, and the subsequent two `build:check` aggregates and final Host typecheck passed.

The SDK keyless recorded-session scenario was refreshed and replayed, and the Session corpus ownership check passed. Python SDK verification used the built profile. Web's two transcript checks reused the same Session and passed refresh and replay, showing one completed turn, two steps, one correction admission, and the retained text. These tests exercised the native agent implementation rather than replacing its response-control methods.

The final DSH `doc-sync` passed all 43 checks. The preceding documentation corrections covered the Chinese anchor and generated event graph; bilingual pairing, 550 primary type declarations and paired derivatives, the upgrade guide, and documentation budgets passed. Focused lint passed after fixing seven new test-format findings; existing unrelated warnings were left intact. Both worktrees passed `git diff --check`.

Before Jev incorporated `main`, its full regression passed 401 tests in 32 files after a successful build and runtime generation. Context-projection tests covered original-task priority, the shared character budget, exclusion of reasoning and full tool logs, checkpoint-suffix recovery, and invalidation after a budget change. Fixtures for the newer DSH development baseline mounted its public services and executors without weakening business assertions. At the verified integrated `main` baseline, the full regression passed 467 tests in 32 files and 89 runtime JavaScript/declaration files matched the local build. The earlier counts describe the earlier build.

Jev subsequently integrated the current `main` Windows-fixture correction. That merge changed only five fixture files and the report's trailing newline, with no product or runtime change. Its focused regression passed seven tests in two files. These seven results supplement the preceding full regression rather than forming a new full-suite count.

The final cross-repository experiment passed all three routes using the built DSH `sdk` profile, regenerated Jev runtime, a scripted main model, and a loopback HTTP classifier. `interrupt-steer` cancelled a first response with no chunks and continued the same turn; `steer` did not cancel and stayed in the same turn; `follow-up` did not cancel and entered a later turn. Each route made one classification HTTP request and two main-model fixture requests, admitting the original correction once. The experiment checked Session notifications and original-input admission; it did not directly read Jev's persisted ledger receipts. The implementation separately records interruption request, response settlement, and admission. A temporary-copy negative control that disabled the actual interruption call failed as expected. No real-model inference occurred, so these results do not measure accuracy or real-interface latency.

The earlier pre-`main` Jev package verification ran `pnpm pack`: all 87 runtime JavaScript/declaration files matched that local build byte for byte, with 97 packaged files and no planning, tests, or environment files. Its SHA-256 was `1451d48d25c812f821dab12fb7569209a400c3ac2d8f450c974b4090ec8d17e2`. This digest identifies that earlier package, not the later 89-file runtime. The package was neither installed into the author's profile nor published.

After the compatibility runner correction, its focused regression passed 37 tests in three files. The default published `0.2.1-rc.5` package passed installation, Host, and real Web smoke checks with eleven features enabled and interjection routing disabled; routing remained explicitly excluded with `verified: false`. The checks made 87 loopback HTTP requests, zero real-model calls, and reported no agent errors. This verifies only that one published version and does not repeat or expand the historical-version matrix. It does not establish response-interruption support in that published package.

After the Windows-fixture integration, a new matrix and Web run reused that official CLI and formal package tarball and passed again with 87 loopback HTTP requests, zero real-model calls, no agent errors, and no human-interaction request. This closes compatibility verification for the integrated branch without treating the disabled routing feature as published-package coverage.

The development-baseline upgrade also exposed PTC approval signal association: DSH combines cancellation signals, so the request signal no longer has the dispatch signal's object identity. The scoped upstream correction retains agent, call ID, tool, reason, and single-claim matching. Only `run_code` accepts its corresponding combined signal, and judgment and handoff observe dispatch, request, and consumer cancellation. All 28 approval tests passed, including native-tool rejection for signal mismatch and cancellation on a PTC sandbox-mode change. The change grants no new approvable operations.

Independent subagent verification on 2026-11-01 passed DSH's ten interruption unit tests, one TypeScript SDK snapshot, one Python SDK snapshot, and two Web transcript checks. The Python test passed under Python 3.12.3 after an offline uv environment setup lacked its selected Python 3.14 Pillow wheel; the initial setup failure is not counted as a passing test. The independent Jev verification reproduced the pre-`main` 401-test and 87-file results; the subsequent final-branch 467-test, 89-file, and three-route results above supersede those branch-level totals without changing their historical scope.

## Non-goals

- Do not cancel started tools, undo side effects, or manage external background processes.
- Do not require Codex's `response.interrupt` WebSocket protocol from every DSH provider, add connection reuse, or promise server-side cancellation.
- Do not add a model summarizer, auxiliary planning agent, per-token classification, full-history index, or repository search.
- Do not add an independent natural-language whole-task-stop execution channel. Native stop remains available, and the original withdrawal or stop request still reaches the main model. Response interruption itself does not authorize continuation of the old task.
- Do not refactor unrelated Jev features, expand automatic approval, Goal management, or subagent message scope, change personal configuration, install a profile, publish a package, or merge a target branch as part of this proposal.

## Risks

Semantic classification can interrupt incorrectly or lack the context required to decide. Bounded input and `unknown` expose missing facts but cannot prove correct classification. Real-model classification quality and production latency remain unverified; no measured accuracy or latency guarantee supports this proposal.

Provider computation may not stop synchronously, and started tools remain active. Response control changes subsequent inference and admission; it cannot undo actions that already happened or recover invisible model computation.

Jev is independent. A supported DSH version must contain the public response-control capability and be verified with it. Private-state access and cancel-plus-restart cannot hide a missing dependency. There are no open product decisions: the chosen ownership, three semantic routes, same-turn continuation, response/retry scope, original-fact context, and one-request normal path are settled; target-branch merge and release remain separate actions.
