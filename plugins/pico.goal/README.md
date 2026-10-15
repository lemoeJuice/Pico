# Goal plugin

The Goal plugin stores one user-defined, durable objective per Thread. Goal text, constraints, completion criteria, edits, pauses, resumes, and clears are controlled by the user. The model can report checkpoints and blockers, but it cannot edit or clear the objective. Marking a Goal completed requires a verifiable execution or prior canonical record from the same Thread.

The Runtime registers the source plugin from its built-in plugin registry. This directory contains the independently served Web UI assets and does not need to be bundled into the Pico application.
