export default {
  id: 'pico.example-notes',
  name: 'Thread notes example',
  version: '0.1.0',
  activate({ tools, commands, ui, state, canonical }) {
    tools.register(
      {
        name: 'save_thread_note',
        description: 'Save a short durable note in this plugin’s private state for the current Thread.',
        parameters: {
          type: 'object',
          properties: { note: { type: 'string' } },
          required: ['note'],
          additionalProperties: false,
        },
      },
      async (args, context) => {
        if (!context.thread) throw new Error('Thread context is not available');
        const note = typeof args.note === 'string' ? args.note.trim() : '';
        if (!note) throw new Error('A note is required');
        const notesByThread = state.get('notesByThread', {});
        const notes = [...(notesByThread[context.thread.id] ?? []), { note, createdAt: new Date().toISOString() }];
        state.set('notesByThread', { ...notesByThread, [context.thread.id]: notes });
        canonical.append(context.thread.id, { action: 'note-saved', note });
        return { saved: true, noteCount: notes.length };
      },
    );

    commands.register({
      name: 'notes',
      description: 'Show notes saved by the example plugin in this Thread.',
      execute(_args, context) {
        if (!context.thread) return { text: 'Choose a Thread first.' };
        const notes = state.get('notesByThread', {})[context.thread.id] ?? [];
        return {
          text: notes.length
            ? notes.map((item, index) => `${index + 1}. ${item.note}`).join('\n')
            : 'No notes saved for this Thread yet.',
        };
      },
    });

    ui.contribute({
      slot: 'thread.toolbar',
      id: 'notes',
      label: 'Notes',
      description: 'Open notes saved by the example plugin.',
      command: '/notes',
    });
  },
};
