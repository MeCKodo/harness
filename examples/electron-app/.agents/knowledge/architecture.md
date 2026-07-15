# Desktop process boundaries

- `src/renderer/` runs in the browser renderer and must not import Electron main-process APIs directly.
- `electron/preload/` exposes the narrow bridge consumed by the renderer.
- `electron/main/` owns windows and privileged desktop behavior.
- `src/shared/` defines IPC names and payload contracts shared across the boundary.

Electron sandboxed preloads cannot directly require arbitrary project modules. Production apps normally bundle preload code; this minimal runnable fixture pins the duplicated channel literal with a unit assertion and a real-process E2E.

Renderer-only changes still run a real browser user flow. Main, preload, or shared IPC changes run the packaged-process-style Electron flow; shared IPC changes cross both gates.
