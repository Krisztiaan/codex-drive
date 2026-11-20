# Lens: inventory

```text
Your lens: inventory. For every symbol the change adds, removes or changes the meaning of, start from mechanical.md and git grep, and list every reader, writer and caller, production and test: one table row per call site with file:line, what it uses at the head, what it should use under the brief, and a disposition (correct, wrong, or not verified). Check the brief's own lists of affected and unaffected callers row by row against your table. Every wrong row is a finding; a row the change depends on that you could not verify is a P2.
```
