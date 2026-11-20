# Lens: state transitions and ordering

```text
Your lens: state transitions and ordering. For each state, flag, lifecycle stage, lock, lease, reservation or timer that the change creates, reads or relies on, enumerate every transition into and out of it: each writer, reset, expiry, restart, error and cancellation path, including code the change does not touch but now relies on. Give the orders in which writers and readers can interleave. At each step, say what each changed predicate and caller reports, and whether that matches the brief's invariant. Check each deadline, threshold and count at, just before and just after its limit.
```
