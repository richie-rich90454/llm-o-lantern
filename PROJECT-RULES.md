# llm-o-lantern - Project Rules

These are the rules the codebase is written to. They describe the existing code, not an aspiration; a change that breaks one of them should have a stated reason in review.

## Language and code style

- TypeScript, strict mode (`tsconfig.json` includes `strict`, `noImplicitOverride`, `noFallthroughCasesInSwitch`). No `any` unless a boundary genuinely unknown value is being narrowed immediately; prefer `unknown` plus a narrowing function (see the response validators).
- ES modules, `import type` for type-only imports, named exports. No default exports.
- No comments except where the "why" is non-obvious (a browser workaround, an algorithm choice, a safety margin). The code says what; comments explain why.
- File and class names describe a single responsibility (`SpeechTimingProcessor`, `ConversationSessionManager`). One class per file, matching the file name.
- No emojis, no marketing language in code, logs, or UI strings.
- Formatting follows the existing files: two-space indent, double quotes, trailing commas in multi-line literals, semicolons always.

## Class design

- Composition over inheritance. No TypeScript `interface` declarations for application contracts, no `abstract class`, and no application class extends another. Contracts are documented as `type` shapes (`DialoguePluginShape`, `AudioPlaybackPluginShape`, ...) and enforced at runtime by `PluginManager` validation, not by the compiler alone.
- Constructor injection. A class receives everything it needs through its constructor, usually as a single options/dependencies object when there are more than two. Nothing reaches into globals; `fetch`, `AudioContext`, the clock, and the logger are all injectable for tests (`fetchImpl`, `clock`, `sink`).
- Composition root exclusivity. Only `ApplicationCompositionRoot` (server) and `main.ts` (browser) construct the object graph. Application classes never construct their collaborators.
- `readonly` by default on fields and immutable data (`DialogueResponse`, `SpeechResult`, `SpeechTiming`, ...). Mutable state is declared and justified: `FacialState` is deliberately mutable and reused every frame.
- Discriminated unions over parallel flags. Behavioral variants are string literal unions with exhaustive handling and a guard function when values cross a boundary: `CharacterState`, `CharacterTransitionEvent`, `TimingSource`, `VoiceActivityFrameResult`, `ConversationRole`. Do not add a second boolean to model a third state; add the state.
- Table-driven behavior where the codebase already does it: state transitions live in `CharacterController.TRANSITIONS`, expression presets in `ExpressionController.PRESETS`, viseme mappings in `VisemeMapper`. Extend the table; do not scatter branches.
- Validate inputs at system boundaries only (HTTP bodies, provider payloads, configuration, WAV bytes, plugin metadata). Internal calls trust each other.
- Errors are `Error` instances with actionable messages ("Ollama is unreachable at <url>. Is ... running?"). Never swallow an error silently; `catch {}` is acceptable only for best-effort cleanup (kill, unlink, disconnect) and must do nothing else.

## Plugin conventions

- Every plugin is a plain class with `readonly id`, `readonly version`, `readonly category`, optional `dependencies`, optional `initialize`/`shutdown`/`isAvailable`/`getDisplayName`, and the required methods for its category (see `CATEGORY_REQUIRED_METHODS` in `src/core/PluginManager.ts`).
- `id` is dotted and stable (`dialogue.ollama`, `character.pumpkin`); it is the configuration value, the registry key, and the diagnostics identifier. The factory id, the plugin's declared id, and the configuration selection must all match or startup fails.
- Plugins depend only on `src/core`, `src/data`, and (for lip-sync) `src/animation`. A plugin must not import another plugin.
- Long-lived resources (child processes, buffers) are released in `shutdown`; `isAvailable` must be cheap and safe to call repeatedly with a timeout.
- Plugins never read `process.env` directly. Secrets arrive through the configuration (`apiKeyEnv` name) and the environment map handed to the constructor.

## Adding a new plugin

1. Implement the class under `src/plugins/<category>/` following the conventions above.
2. Register a factory in the composition root for the side it runs on: `ApplicationCompositionRoot.buildServerRegistry` for server categories or the registry in `src/frontend/main.ts` for browser categories.
3. Make sure its `category` is one of the nine known categories and it implements every required method for that category; startup validation will reject it otherwise.
4. Update the default selection in `llm-o-lantern.config.json` (or `plugins.additional`) only if the new plugin should be the default. Add a configuration section for its knobs in `ApplicationConfiguration` (typed reader, range-checked, with a sensible default) rather than reading raw values in the plugin.
5. Update `llm-o-lantern.config.json`, `.env.example` (if it introduces an environment variable), and the provider documentation in README.md when the plugin is user-selectable.
6. Add tests: at minimum a unit test for its core logic and, for dialogue providers, a wire-format test using a stubbed `fetch`.

## Testing requirements

- Vitest; tests live in `tests/unit/` and `tests/integration/` and are named after the unit under test. Shared fakes and WAV fixtures belong in `tests/fixtures/`.
- Every non-trivial behavior change adds or updates a test at the level that can actually observe it: pure functions and classes in unit tests, HTTP routes and the turn pipeline in integration tests with fake plugins over a real HTTP server.
- Time, randomness, `fetch`, and audio are never used raw in tests: inject clocks, seeds, `fetchImpl`, and the `makeToneWav` fixture.
- Live-service tests are opt-in and must skip without the environment flag (`INTEGRATION=1`), as in `tests/integration/externalServices.test.ts`.
- A red build is fixed before anything else; do not disable or delete failing tests to make a change pass.

## Performance rules

- The render loop is allocation-light. Reuse scratch objects (`FacialState`, `Float32Array`s, `THREE.Color`s); allocate per frame only when a measured need says otherwise. Never assign a shared scratch instance into a long-lived place without cloning (see the warmth color comment in `PumpkinModelPlugin`).
- Timeline lookups use the cursor + short forward scan and fall back to binary search on a jump; do not linear-scan the whole track per frame.
- History and buffers are always bounded: session memory (16 messages / 8000 characters), recent errors (20), the microphone ring buffer (20 s), the error log in the UI (10), and JSON/binary request bodies (256 KiB / 4 MiB).
- Derive explanations from measurements, not guesses: the diagnostics endpoint records per-stage latency and the browser records end-of-utterance-to-first-audible; performance changes should cite them.

## Workflow

1. `pnpm run typecheck` must pass.
2. `pnpm test` must pass.
3. `pnpm run build` must pass.
4. Manual verification for anything the tests cannot see (rendering, audio, microphone), with the local services up as needed.

No code is merged or committed unless it passes all four steps; the typecheck -> tests -> build order is the expected local loop. Commits happen only when explicitly requested.

## Documentation

- DESIGN.md is the architecture reference; when a change alters a contract, endpoint, default, or lifecycle step described there, update it in the same change.
- README.md is the operator manual; keep its commands and ports true.
- Do not create additional documentation files; extend the existing five.
