# Global Memory

Global Memory stores user preferences and durable cross-project knowledge. The Runtime plugin entry is built separately as `plugins/pico.global-memory.mjs`; this directory contains package-owned UI assets.

Items keep source Thread/message references and supersession links. Automatic memory entry creation is agent-decided through `memory_save` or `memory_replace`; users can inspect, edit, pin, and remove entries from the Global Memory page in Settings. Project Memory remains a separate control in the Thread toolbar.
