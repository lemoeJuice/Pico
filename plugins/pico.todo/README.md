# Todo plugin

Todo is a Thread-scoped plan and notebook shared by the user and Agent. It is independent of Goal and Project Memory: a Todo item does not schedule work or authorize a change of task. Goal handles durable objectives and continuation.

The list contains optional phases and tasks. A task can belong to one phase or be independent. Tasks have open, in-progress, blocked, or done status, and can carry a note, next action, and blocker. Phases have open or done status and an optional note. Phase and task order is editable. A phase with unfinished tasks cannot be completed; reopening an associated task also reopens its phase. Deleting a phase keeps its tasks as independent tasks.

The Agent has two tools: `todo_list` reads the latest revision and `todo_edit` applies an atomic batch of changes against that revision. For substantial multi-step work, the Agent should read and maintain a concise plan. Short work can skip Todo. Explicit reminders and deferred work can be independent tasks. The stable usage hint is inserted into the system prompt on each projection; Todo contents are retrieved on demand and treated as data, not instructions.

The panel and tools share the same state and revision checks. Legacy nested Todo entries are migrated on read without dropping valid items: a root with descendants becomes a phase, and its descendants become tasks. Paths through intermediate entries are preserved in notes. This conversion is persisted on the next edit. Previously detached relationships cannot be recovered.

Each Thread is limited to 50 unfinished items and 100 items total. Completed items can be viewed in the panel or requested with `todo_list(include_completed: true)` and can be deleted when no longer needed.
