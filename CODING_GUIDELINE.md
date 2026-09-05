# Coding guidelines

Read these guidelines before changing the repository.

Follow established local conventions where these guidelines leave room. Do not perpetuate a known problem merely for
consistency, or make unrelated changes merely for uniformity. Apply language-independent design principles rather than
language conventions that weaken types, encapsulation, ownership, or testability.

## Ownership and structure

- Prefer components with explicit ownership and narrow, cohesive responsibilities.
- Keep related behaviour together, both within files and in the folder structure. Make dependencies and resource lifetimes
  explicit so components can be tested and reasoned about independently.
- Default to class methods. Use module-level functions when an operation is self-contained and has no meaningful state,
  lifecycle, invariant, or ownership that would justify binding it to a class. Do not create a class solely to wrap an
  otherwise standalone function.
- Order methods for top-down reading: public API first, private orchestration next, utility methods last. Within those
  groups, keep related methods close and place callees below callers where practical.
- Use filenames and names that describe responsibilities. Comments should explain non-obvious reasons and constraints,
  not restate the code or describe speculative cases it cannot encounter.

## Simplification and architecture

- Consolidate implementations when they represent the same responsibility and algorithm. Keep genuinely different
  behaviour separate; neither duplication nor extraction should be judged primarily by line count.
- Prefer locality over extracting small helpers merely to shorten methods. Extract when there is a clear responsibility
  or genuine reuse, not just a block of code that could be given a name.
- Design toward the intended final architecture rather than preserving known-dead abstractions. Confirm that code is
  unused before removing it, and do not add speculative extension points or implement unrequested future requirements.
- Implement the requested slice completely, including its invariants and tests, without expanding unrelated scope.

## Types, invariants, and boundaries

- Model the state and relationships the component actually owns. Do not conceal an incorrect model with `any` or chains
  of type assertions. Where interoperability requires an assertion, keep it narrow and local to that boundary.
- Validate external inputs at their boundaries and enforce invariants in the component that owns them. Internal code
  should rely on established invariants rather than add defensive branches for impossible states. Do not remove checks
  that establish those invariants or protect a trust boundary.
- Keep failure paths deliberate and understandable. Do not silently turn failures into success or permissive defaults;
  intentional recovery or best-effort clean-up should have a clear reason.

## Refactoring and verification

- Keep behaviour-preserving refactoring separate from behavioural fixes. Flag discovered bugs rather than silently
  changing their semantics as part of a clean-up.
- Before refactoring, identify the observable behaviour and establish a test baseline. Add missing regression coverage
  before changing the implementation where practical, so it characterizes existing behaviour.
- Verify results and the relevant ordering, authorization, cancellation, and clean-up semantics—not just successful
  execution. Tests should assert the contract rather than incidental implementation details.
- Run validation appropriate to the changed code and its environment. Report failures, skips, and untested areas
  explicitly; a passing subset is not a passing full suite. Run sandbox integration tests on a prepared host, not inside
  pi.lot or another sandbox.
- Preserve unrelated working-tree and staging changes.

## Formatting and JS/TS conventions

- Use four-space indentation.
- Do not create barrel files or directory-level `index.ts`/`index.js` entry points. Import directly from the file that owns
  the implementation, even when that makes imports longer.
