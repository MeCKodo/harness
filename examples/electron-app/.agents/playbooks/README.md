# Desktop acceptance playbooks

- Renderer gate: assert a user-visible journey in the renderer.
- Desktop-process gate: launch the real Electron process and cross the preload/IPC seam.
- Keep both commands self-starting, self-cleaning, deterministic, and within the lifecycle budget.
