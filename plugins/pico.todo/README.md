# Todo plugin

Todo is a small, Thread-scoped note shared by the user and Agent. It is independent of Goal and Project Memory. It stores only an item title, open/done status, and an optional parent item. The Todo toolbar card and Agent tools use the same plugin state and API.

Only unfinished items are added to Agent context. Completed items remain visible in the card until deleted, but Todo does not keep a separate history or execution log. Add a Todo for outcomes that need to survive across operations; short work that can be finished immediately can skip Todo.

Each Thread is limited to 50 unfinished items and 100 total items to keep context and the toolbar card bounded.
