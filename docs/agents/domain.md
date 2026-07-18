# Domain Docs

Engineering skills should consume this repository’s domain documentation as follows.

## Before exploring, read these

- `CONTEXT.md` at the repository root.
- `docs/adr/` for ADRs relevant to the area being changed.

If these files do not exist, proceed silently. The domain-modeling skill creates them when domain terms or architectural decisions are resolved.

## File structure

This is a single-context repository:

```text
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-example-decision.md
│   └── 0002-example-decision.md
└── src/
```

## Use the glossary’s vocabulary

When output names a domain concept, use the term defined in `CONTEXT.md`. If the concept is not documented, note the gap for domain modeling.

## Flag ADR conflicts

If output contradicts an existing ADR, surface the conflict explicitly rather than silently overriding it.
