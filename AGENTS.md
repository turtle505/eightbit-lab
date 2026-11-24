# Repository Guidelines

## Project Structure & Module Organization

`server/src/` contains the HTTP/WebSocket backend, agent management, persistence, permissions, and compute adapters. `web/src/` contains the Vite browser client, with UI components under `web/src/ui/` and canvas rendering under `web/src/game/`. Keep wire message types in `shared/protocol.ts` and translation helpers in `shared/i18n.ts`. Tests live in `server/test/`; committed defaults and examples live in `config/`. `data/` and `workspaces/` are generated runtime state.

## Build, Test, and Development Commands

Use Node.js 22.13 or newer (`.nvmrc`) and install dependencies with `npm ci`.

- `npm run dev`: watch the backend and serve the Vite client at `http://localhost:5173`.
- `npm run build`: build browser assets into `dist/`.
- `npm start`: serve the built client and backend on port 8787.
- `npm run typecheck`: check TypeScript across server, web, shared code, and scripts.
- `npm test`: run the Vitest suite once.

## Coding Style & Naming Conventions

Follow the existing TypeScript style: two-space indentation, single quotes, semicolons, and explicit `.ts` extensions for local imports. Use camelCase for variables and functions, PascalCase for types and classes, and descriptive lowercase filenames. Keep browser-facing text bilingual through `tr({ ko, en })`; keep agent-facing prompts in English. When changing a feature or documented behavior, update both `README.md` and `README.ko.md`. There is no separate formatter or lint script; use `npm run typecheck` for static checks.

## Testing Guidelines

Tests use Vitest and `describe`/`it` blocks in `server/test/units.test.ts`. Add focused cases for changed behavior, especially parsers, persistence, permissions, and protocol handling. Name cases by observable result (for example, `it('rejects a stale edit', ...)`). Run a subset with `npx vitest run -t "parsers"`; run `npm test` before proposing a change. No coverage threshold is configured.

## Commit & Pull Request Guidelines

Recent commits use short, imperative, sentence-case subjects such as `Add phone notifications and one-time scheduled tasks`; follow that pattern. In pull requests, explain the user-visible change, note relevant configuration or protocol changes, and list the checks you ran. Include screenshots for UI changes and link an issue when one exists.

## Configuration & Security

Keep personal paths, hosts, and secrets in ignored `config/*.local.yaml` files; use `config/servers.example.yaml` as the server template. Do not commit runtime files from `data/` or `workspaces/`. Preserve approval checks around remote commands and sanitize agent-authored Markdown before rendering it in the browser.
