# Goal design

Use when asked to create or improve a long-running goal prompt. Produce one concise, task-specific prompt, not a new tracker or an implementation plan unless requested. Designing a prompt does not authorize starting it, replacing a running goal or changing application policy.

Use the user's accepted requirements and current authorities. Reuse context already available; inspect only material gaps. Ask only when the answer changes scope, correctness or authorization. Distinguish requirements from suggestions, examples and historical evidence in referenced documents.

Include what the task needs:

- **Outcome and scope:** observable end state, accepted requirements and explicit exclusions. Translate broad terms such as "fully improve" into finite acceptance criteria without silently dropping requirements.
- **Milestones:** coherent, verifiable increments that preserve the full goal. Finishing a milestone is not a claim that the campaign is complete; continue to the next authorized milestone when appropriate.
- **Acceptance:** sufficient evidence and required gates for each outcome. Reuse valid evidence until relevant inputs change, contradictory evidence appears or a concrete coverage gap is found. Reference the owning validation rules instead of copying their commands.
- **Discovery:** include defects caused by the work and prerequisites necessary for acceptance. Record other findings in the existing tracker when authorized, without automatically expanding the milestone.
- **Convergence:** measure progress by acceptance advanced or a blocker resolved, not edits, logs or activity alone. If repeated attempts do not advance acceptance, reassess the method and identify the missing information before continuing. Do not invent arbitrary retry counts or mandatory progress reports.
- **Boundaries:** permitted actions, approval-dependent actions and external prerequisites. When no independent accepted work remains, report the established blocker and end the turn rather than sleeping or polling for it to change; the dispatcher resumes the goal once the blocker is cleared. Never claim unavailable qualification passed.

Keep the prompt proportional to the task. State a time or usage budget only when supplied by the user; a checkpoint is not permission to claim incomplete work complete. Keep one compact acceptance record in the existing tracker, linking shared evidence rather than duplicating receipts across issues.

Before returning, check that the prompt has an observable finish, does not promote every incidental command or artifact into a deliverable, and cannot turn optional discoveries into endless scope. Preserve required safety, data, recovery and validation constraints. Identify conflicts with app-generated continuation rules explicitly; do not claim a skill can override them.
