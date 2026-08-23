# Codex Canvas for Figma

Codex Canvas brings Codex into Figma and gives each conversation direct access to the open document through the Figma Plugin API. An optional workspace lets Codex inspect and modify a software project alongside the canvas.

The plugin panel connects to a local or SSH-forwarded bridge. The bridge runs a project-private Codex App Server and coordinates authenticated conversations, Figma tools, and workspace access.

## What it can do

- Read the current selection and layer hierarchy
- Create, edit, move, reparent, clone, and delete Figma nodes
- Work with Auto Layout, text, fonts, fills, strokes, effects, components, instances, styles, variables, images, and the viewport
- Render a node as PNG for visual verification
- Keep coherent Figma edits in the document's Undo history
- Stream conversations and resume previous conversations for the active workspace
- Select a Codex model and supported reasoning effort
- Read and modify one configured local workspace

Keep Codex Canvas open while a turn is running because Figma suspends the plugin when its panel closes.

## Workspace model

Codex Canvas has one active workspace at a time. A workspace can have multiple conversations, and each conversation remains associated with the directory where it was created.

- Figma-only mode provides canvas access with read-only filesystem access
- Workspace mode uses the selected absolute directory as the Codex working directory and writable runtime root
- Each workspace has its own conversation list
- Changing or clearing the workspace resets the active conversation and loads the matching history

Open **Settings**, enter an existing absolute directory, and save. The bridge stores the selection in `.runtime/workspace.json` and conversation associations in `.runtime/threads.json`. The workspace can also be supplied when the bridge starts:

```bash
CODEX_CANVAS_WORKSPACE=/absolute/path/to/project npm start
```

Workspace mode lets Codex edit files and run project tools inside the selected directory. Choose a dedicated project directory for this workflow.

## Development setup

Requirements:

- Figma desktop app
- Node.js 20 or newer

Install dependencies and validate the project. `npm ci` installs the pinned project-local Codex runtime under `node_modules`.

```bash
npm ci
npm run check
```

Start the bridge and keep the terminal open. `npm start` builds the plugin and bridge before launching:

```bash
npm start
```

On Windows, `start-codex-canvas.cmd` provides the same flow in a dedicated terminal window.

Then, in the Figma desktop app:

1. Open a design file with edit access
2. Go to **Plugins -> Development -> Import plugin from manifest...**
3. Select this project's `manifest.json`
4. Run **Plugins -> Development -> Codex Canvas**
5. Paste the connection token printed by `npm start`
6. Open **Settings -> ChatGPT account**, choose **Connect ChatGPT**, then open the verification page and enter its device code

`figma.clientStorage` persists the connection token between runs. The plugin connects to `ws://localhost:3845`, where the loopback bridge authenticates connections with the random token stored in `.runtime/token`.

Codex Canvas uses a dedicated Codex home at `%LOCALAPPDATA%\codex-canvas\codex-home` on Windows and `${XDG_STATE_HOME:-~/.local/state}/codex-canvas/codex-home` on Linux. The bridge resolves its platform-specific executable from `node_modules`. Set `CODEX_BIN` to override it during development.

## Running the bridge in an SSH VM

Figma and the development plugin stay on the host, while the bridge, private Codex runtime, and workspace run in the Linux VM. Copy or clone a clean source checkout into the VM, then run:

```bash
cd ~/codex-canvas-for-figma
npm ci
npm start
```

Open a second terminal on the Windows host and forward the Figma socket to the VM:

```powershell
ssh.exe -4 -N -T `
  -o ExitOnForwardFailure=yes `
  -o ServerAliveInterval=30 `
  -L 3845:127.0.0.1:3845 `
  localhost
```

Reserve host port `3845` for the SSH tunnel. Figma continues to use the host copy of `manifest.json` and `dist/plugin`, together with the connection token printed by the VM bridge. Settings accepts absolute paths inside the VM, such as `/home/airdas/projects/my-app`.

## Architecture

```text
Figma plugin panel
        | token-authenticated WebSocket on localhost
        v
Local or SSH-forwarded bridge
        |---- project-local Codex App Server over stdio
        |             |---- private per-user Codex home
        |             +---- optional writable workspace
        |
        +---- client-executed Figma tools
                          |
                          v
                   Figma Plugin API
```

The bridge owns the active workspace and App Server thread. The plugin UI owns the saved token, model choice, and reasoning effort. Conversation discovery follows the active working directory and selects the most recently updated conversation when no thread is active.

A bridge process has one active Figma controller. A newer window connection becomes the active controller.

## Security boundaries

The `execute` tool runs an async JavaScript body against the Figma Plugin API, supporting flexible document operations.

- The bridge binds to loopback
- A random token authenticates every WebSocket connection
- The Codex runtime stays project-local under `node_modules`
- Codex account data stays in a private per-user home outside the project and workspaces
- The native Windows bridge selects Codex's `unelevated` sandbox
- The plugin manifest allows the local development socket
- Figma scripts execute inside the plugin sandbox
- Filesystem writes stay within the configured workspace root
- Failed Figma scripts restore the preceding Undo checkpoint when possible

The eval-free `execute_ops` tool provides a fallback for restricted JavaScript environments. It supports Plugin API methods, property updates, node resolution, and object references across a batch.

### Data and privacy

The authenticated Codex service processes chat prompts and Figma context requested during a task, including node metadata, tool results, and rendered previews. Data handling follows the settings and policies of the connected ChatGPT account.

## Project structure

- `src/plugin/code.ts` runs in the Figma plugin sandbox and executes Figma tools
- `src/plugin/ui.html`, `ui.css`, and `ui.ts` define the panel and build into one self-contained HTML file
- `src/bridge/index.ts` composes and starts the bridge services
- `src/bridge/config/` owns runtime paths, the connection token, the private Codex home, and persisted workspace state
- `src/bridge/codex/` resolves the project-local runtime and manages accounts, models, and conversations through App Server
- `src/bridge/figma/` defines the local Figma tool contract and agent instructions
- `src/bridge/server/` owns the authenticated WebSocket transport and coordinates bridge state

## License

[MIT](LICENSE)
