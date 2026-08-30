# This is must-read on general guidelines for how coding is done here

## General things

All the guidelines below are important. BUT. following the practices seen in the codebase may override them, consistency is also extremely important.

- 4 space indent
- Do not create barrel `UiDecisionFlowManager.ts` files. Use filenames that describe their responsibility.
- Keep related behaviour together. Prefer locality over extracting small helpers merely to reduce method length.
- Default to class methods. Use module-level functions only when an operation is fully self-contained and has no  meaningful state, lifecycle, invariant, or ownership that would justify binding it to a class.
- Any class or file should have a general structure as such:
  - API (public methods) should be at the top
  - The middle should contain the private-but-orchestrating methods
  - The bottom should contain the utility methods
  - The ordering in the individual groups should be based on locality to usage, but the used method should always be below the users
- Design toward the intended final architecture rather than preserving known-dead abstractions.
- Implement the requested slice completely, including its invariants and tests.
- Prefer components with explicit ownership and narrow responsibilities.
- Follow language-independent software-design principles. Do not imitate JavaScript conventions when they weaken
  types, encapsulation, explicit ownership, or testability.

### JS/TS specific

- avoid index.(ts|js), accept slightly bigger imports directly from the source

## The bigger picture

- Design for:
  - testability & debuggability, these should be self-explanatory
  - compartmentalising, also sometimes called single-purpose, encapsulation or otherwise having the capacity to 'black-box' parts of the implementations and have things modularized for easy refactor or replacement
  - locality, things that work together, stay together, group by folder structures at the outer layers and inside files things that interact should naturally be closer to each other

## Final words

While these guidelines likely will get you far, there are always unexplored situations, for those you must just use best practice