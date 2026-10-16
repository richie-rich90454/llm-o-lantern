# llm-o-lantern - Implementation Plan and Delivery Record

Status: all seven milestones are implemented in this repository. The implementation is finished and verified by the automated test suite; the end-to-end experience additionally requires locally running services, a microphone, and a browser (see "Integration points requiring hardware").

Standard verification: `pnpm run typecheck`, `pnpm test`, `pnpm run build`, then `pnpm start` and a manual pass in the browser. "Status" below is per milestone; each is implemented unless stated otherwise.

## Milestone 01 - Plugin foundation

Built: `PluginRegistry` and `PluginManager` (selection, metadata validation, per-category required-method checks, dependency validation, Kahn topological sort with cycle reporting, initialization with rollback, reverse shutdown, category filter for browser plugins); `ApplicationConfiguration` (defaults <- JSON <- `.env` <- real environment, typed readers, aggregated errors, secret resolution, filtered public config); `ApplicationLogger` (levels, child contexts, injectable sink/clock, recursive secret redaction); `Application` (startup summary, shutdown); `ApplicationCompositionRoot` (single server graph assembly).

Acceptance criteria as delivered: startup fails with a precise error for unknown ids, duplicates, id/category mismatches, missing required methods, missing dependencies, and cycles; initialization follows dependency order and shutdown reverses it; a failed initialization rolls back earlier plugins; both sides load their plugin sets from the same configuration file.

Verify locally: `pnpm test` (plugin manager and configuration files), `pnpm run typecheck`, then start the server and check that `GET http://127.0.0.1:8787/api/health` lists the eight server plugins. Break the configuration on purpose and confirm startup names the problem.

Status: implemented.

## Milestone 02 - 3D character prototype

Built: `SceneController` (dark scene, fog, camera, flickering warm light, ground disc), `CharacterRenderer` (WebGL, clamped frame delta, resize observer, frame callbacks), `PumpkinModelPlugin` (procedural ribbed body, stem, extruded eyes, parametric mouth mesh, teeth, face and ground lights, single static `TUNING` table), plus `ModelCapabilities`, `FacialState`, and the wiring that drives display from the character state.

Acceptance criteria as delivered: a pumpkin renders with the configured `characterModel.*` colors; it blinks, sways, bobs, and shows state-dependent glow; the mouth deforms from the 8 viseme channels with a jaw-like lower lip; no external model assets are required.

Verify locally: `pnpm run dev`, open `http://localhost:5173`, click "Wake the pumpkin". To skip the microphone prompt, set `booth.autoListen` to `false` first; the pumpkin still idles. `pnpm test` covers the mixer and expression logic.

Status: implemented.

## Milestone 03 - TTS and lip-sync prototype

Built: `NeuralSpeechSynthesisPlugin` (Kokoro-FastAPI, Piper executable, generic OpenAI-compatible endpoint; delivery speed multipliers; WAV validation; Piper child-process cleanup); `SpeechTimingProcessor` (heuristic G2P, energy-based forced alignment, duration estimator, provider normalizer); `VisemeMapper`; `OpenFaceFxLipSyncPlugin` (coarticulation, minimum hold, silence lead-in/tail); `FacialAnimationController` (playback-clock cursor, binary-search seek, 150 ms release ramp); `AudioPlaybackController`.

Acceptance criteria as delivered: text -> WAV -> `SpeechTiming` -> `FacialAnimationTrack` produces an ordered, duration-bounded track for any synthesized audio; provider timing is used when present, otherwise energy alignment, with estimation as the last resort, and the source is reported in the response; the mouth follows the audio playback clock, so audio and face cannot drift within a turn.

Verify locally: start Kokoro (`docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest`), `pnpm run dev`, wake the pumpkin, submit a turn. Diagnostics (D) shows `energy-alignment` or `estimated` and the audio length. `pnpm test` covers timing, viseme, lip-sync, facial controller, and WAV logic.

Status: implemented. TTS providers return no timing metadata today; see "Risks and open decisions".

## Milestone 04 - Dialogue and personality

Built: `OllamaDialoguePlugin` (native `/api/chat`, JSON mode, keep-alive, timeout, actionable unreachable error); `RemoteDialoguePlugin` (14 presets, OpenAI and Anthropic wire styles, response-format retry, explicit acknowledgment); `ScriptedDialoguePlugin` (rules plus rotating lines); `HauntedPumpkinPersonalityPlugin` (instructions, emotion/delivery vocabulary, response limit, secret phrases); `DialogueResponseProcessor` (fence stripping, JSON intent extraction, sanitization, word-boundary clamp, validation); `ConversationSessionManager` + `SessionMemoryPlugin` (bounded history, reset, idle purge).

Acceptance criteria as delivered: the `{"text", "emotion", "delivery"}` contract is enforced end to end - prose, fenced JSON, and embedded JSON all resolve, and invalid emotions/deliveries fall back to defaults; replies are clamped to the smaller of the personality and configuration limits; with the provider down, the scripted fallback answers in character and the turn reports `dialogueFallback: true`; memory is per-session, bounded at 16 messages / 8000 characters, cleared by reset, and purged after 30 minutes.

Verify locally: `ollama pull llama3.2`, `ollama serve`, then `pnpm run dev` and hold a short conversation. Stop Ollama and repeat: replies come from the scripted fallback (diagnostics "Fallback: active"). Set `plugins.dialogue` to `dialogue.scripted` for deliberate offline operation. `pnpm test` covers the dialogue plugins, response processor, personality, memory, and session manager.

Status: implemented.

## Milestone 05 - Speech input

Built: `MicrophoneController` (permission handling, 20 s ring buffer, zero-gain capture graph); `VoiceActivityDetector` (adaptive noise floor, start threshold, silence end, minimum speech, maximum utterance); `SpeechInputCoordinator` (auto-listen and push-to-talk, preroll, 16 kHz resampling, WAV encoding, transcription, submission); browser push-to-talk controls; `POST /api/speech/transcribe`.

Acceptance criteria as delivered: speaking produces a turn without touching the keyboard in auto-listen mode; holding T (or the button) works in noisy conditions; utterances under 250 ms and empty transcriptions are discarded silently; transcription outages surface as operator-facing errors; microphone denial produces a specific, actionable message.

Verify locally: start the whisper.cpp server on port 8082, `pnpm run dev`, wake the pumpkin (grants microphone), and speak. Subtitles show the visitor text, then the reply. `pnpm test` covers VAD and the recognition plugin.

Status: implemented. Requires a microphone and a running local STT service to verify end to end.

## Milestone 06 - Expressive behavior

Built: `ExpressionController` (per-state presets, deterministic phase-locked idle motion, blinking, emotion reaction envelopes for all six emotions) and `CharacterAnimationMixer` (viseme × expression, clamped to model-safe ranges), wired to state transitions and turn emotion in the browser entry point.

Acceptance criteria as delivered: each state has a distinct look (idle breathing, alert listening, dimmed thinking, brightening preparation, energetic speaking, flared interruption, subdued recovering); emotion reactions play once per turn and decay to baseline; the expression layer never writes viseme weights, and identical seed + dt sequences produce identical output.

Verify locally: `pnpm run dev`, wake the pumpkin, and compare the state badge with the visible behavior; interrupt it while speaking to see the flared INTERRUPTED look. `pnpm test` covers the expression controller and mixer.

Status: implemented.

## Milestone 07 - Booth hardening

Built: health endpoint with per-plugin probes and 10 s caching; diagnostics endpoint (turn counts, fallback count, average per-stage latency, timing source distribution, recent errors, active sessions); booth UI (start overlay for audio unlock, state badge, subtitles, error banner with log, diagnostics panel, M/T/R/D controls, health polling every 15 s); stale-turn rejection on both ends; interrupt with abort and fade; degraded subtitle mode; one-action reset; static `dist/` serving with traversal guard and security headers; the full Vitest suite plus opt-in live-service smoke tests.

Acceptance criteria as delivered: no failure leaves the character stuck (every error path ends in RECOVERING -> IDLE/LISTENING, reset works from any state); a stale turn id is rejected with 409 and ignored silently in the browser; killing TTS degrades to subtitles; killing the backend raises the banner and restarting recovers without a reload; `pnpm run build && pnpm start` serves UI and API from one port with no dev tooling.

Verify locally: `pnpm run build`, `pnpm start`, open `http://127.0.0.1:8787`, run a turn, press R and D, stop the backend mid-session and watch the banner. With all services up: `INTEGRATION=1 npx vitest run tests/integration` (PowerShell: `$env:INTEGRATION="1"; npx vitest run tests/integration`).

Status: implemented.

## Integration points requiring hardware or external services

| Integration point | Needed for | Without it |
| --- | --- | --- |
| OpenRouter (https://openrouter.ai/api/v1) | Shipped dialogue provider | Scripted fallback (`dialogueFallback: true`); the booth keeps working |
| Ollama (localhost:11434) | Local dialogue when `dialogue.ollama` is selected | Scripted fallback (if enabled) or a failed turn |
| Piper (`services/piper`, installed by `pnpm run setup`) | Speech output + lip-sync | Subtitles only (`degraded: true`) with a setup hint in the log |
| whisper.cpp (`services/whisper`, auto-started by the backend) | Speech input | Booth runs without voice input; logs name `pnpm run setup` |
| Kokoro-FastAPI (localhost:8880) | Alternative speech synthesis engine | n/a unless selected |
| Microphone + browser permission | Voice capture | Visual-only booth; push-to-talk also unusable |
| WebGL2-capable browser | The 3D character | The frontend does not start |

## Technical risks and open decisions

- TTS timing metadata quality: no shipped engine returns word or phoneme timestamps, so `timingSource` is `energy-alignment` or `estimated` in practice. The normalizer and response plumbing for provider timing already exist; the open decision is which engine to integrate first. Kokoro-FastAPI's captioned endpoints carry word timestamps and are the natural candidate, but switching endpoints changes streaming behavior and should be measured against the alignment path before adoption.
- Alignment accuracy on continuous speech: energy alignment distributes voiced time proportionally to intrinsic phoneme durations and can drift on long or unusually paced utterances. Existing mitigations: 280-character response cap, minimum-hold collapsing, coarticulation smoothing. The open question is whether drift is visible at booth distance in practice.
- Microphone conditions in a noisy booth: the single adaptive VAD threshold can false-trigger on ambient noise or cut off soft speakers. Push-to-talk is the documented fallback and `booth.voiceActivity.*` is tunable on site; a multi-band or ML-based VAD is deliberately out of scope until booth measurements justify it.
- Reasoning-model latency: replies stream sentence by sentence, and a stream activity watchdog aborts a provider that goes fully silent (4 s of no data) or only thinks past its patience window (12 s), answering with the fallback chain or the scripted line instead. OpenRouter free tiers are capped per account (50 requests/day shared across every `:free` model, 1000/day after a one-time $10 credit purchase), so the booth cools quota-limited providers down until the next UTC midnight and fails over through `dialogue.failover.chain` (extra instances from `dialogue.failover.instances`, e.g. a Groq key, register automatically). The open decision is which non-reasoning free model to adopt as the default once a dependable one exists.
- Model tuning knobs in `PumpkinModelPlugin.TUNING`: every geometry, material, and animation constant lives in one static table tuned by visual iteration. This keeps the character cheap to rebuild, but expressive range is limited to what the parametric mouth/eye rig can fake. Replacing the model behind the `character` plugin contract is the intended escape hatch.
- Deterministic idle motion uses a fixed seed (7) in the browser entry point; side-by-side booths would idle in sync. Changing the seed per booth is a one-line decision if needed.
