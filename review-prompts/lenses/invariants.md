# Lens: security, authorization and persistence invariants

```text
Your lens: security, authorization, data integrity and recovery invariants. List every gate the change can reach: authentication and permission checks, input/boundary validation, accounting or quantity rules, persisted-data writes, migrations, recovery gates and audit writes. For each, state what it must still refuse under the brief and AGENTS.md (fail closed), and verify from the code at the head, including its error path, that it does. A gate that now accepts what it must refuse is a P1. Before the read ledger, add a line VERIFIED GATES and one line per gate you verified safe, with file:line, so the absence of a finding is evidence.
```
