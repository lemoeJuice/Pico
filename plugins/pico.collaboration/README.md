# pico.collaboration

Child Thread collaboration tools and its isolated Thread panel.

The plugin creates ordinary child Threads in the current Project, sends initial and follow-up messages through Runtime's normal message delivery, and lists child Thread state. It does not synchronously wait for a child or define a separate task/result lifecycle. Child work uses the parent Thread's current Executor binding.

The panel is a sandboxed plugin UI. It lists direct children and can queue a message, pause, or resume a child Thread. Paused Threads remain paused after receiving a message and require an explicit resume/Continue action.
