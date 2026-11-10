# Agent instructions

Read [docs/CONSTRAINTS.md](docs/CONSTRAINTS.md) before changes. Follow
[docs/code-style.md](docs/code-style.md) for JavaScript and test conventions;
[docs/maintenance.md](docs/maintenance.md) defines data ownership and formats.

Use local work records in `.dev/<task>/`: `spec.md`, `plan.md`, `todo.md`, and
verification evidence. Keep review history and retired process records under
`.dev/audit/`. Product data directories contain current, consumed data.

Implement and verify independently reviewable slices, then commit each slice
with an English Conventional Commit subject and explicit staged paths. Report
existing failing checks accurately. Preserve pinned upstream asset bytes and
source attribution when reorganizing metadata. Do not push unless requested.
