# llm-o-lantern - Technical Design

This document describes the architecture as implemented. Every class, method, endpoint, and default named here exists in the repository.

## 1. Overview

llm-o-lantern is a TypeScript/Node.js application with a browser frontend (Three.js + Web Audio) and an HTTP backend on one origin. The backend serves the built frontend and a JSON API; the browser captures speech, submits turns, plays audio, and renders the character. `src/data`, `src/core`, `src/animation`, and `src/application` compile into both bundles; `src/server` holds HTTP transport and `src/frontend` the browser composition root and UI.

Principles: composition instead of inheritance (no TypeScript interfaces, abstract classes, or application-level `extends`; contracts are `type` shapes enforced at runtime by the plugin manager); configuration over code; local-first speech services; no persistence. The shipped configuration uses OpenRouter dialogue with explicit consent; switching `plugins.dialogue` to `dialogue.ollama` or `dialogue.scripted` makes the deployment fully offline.

## 2. Core responsibilities

- `Application` - lifecycle only: load configuration, create the logger, ask the composition root to assemble the graph, start/stop the HTTP server, log a startup summary (warning when remote dialogue is enabled).
- `ApplicationConfiguration` - loads JSON file, then `.env`, then real environment; validates every field with typed readers, cross-validates, and throws one aggregated error listing all problems; exposes `value`, `resolveSecret(name)`, and filtered `getPublicBoothConfig()`.
- `ApplicationLogger` - levels (`debug < info < warn < error`), child contexts (`parent:child`), injectable sink/clock, recursive redaction of credential-shaped keys.
- `PluginRegistry` / `PluginManager` - registration, selection, validation, dependency ordering, lifecycle, lookups (section 3).
- `ApplicationCompositionRoot` - the only server-side graph assembly: plugin factories, session manager, response processor, timing processor, routes, HTTP server, idle-session purge timer.

## 3. Plugin system

### 3.1 Categories and required methods

| Category | Side | Required methods (validated at startup) |
| --- | --- | --- |
| `dialogue` | server | `generateResponse` |
| `personality` | server | `buildInstructions`, `getAllowedEmotions`, `getAllowedDeliveries`, `getResponseCharacterLimit`, `getGreetingLine`, `matchesSecretPhrase` |
| `speech-recognition` | server | `transcribe` |
| `speech-synthesis` | server | `synthesize` |
| `lip-sync` | server | `generateTrack` |
| `memory` | server | `addMessage`, `getRecentMessages`, `clearSession`, `clearAll` |
| `character` | browser | `createModel`, `getCapabilities`, `applyFacialState`, `dispose` |
| `microphone` | browser | `start`, `stop`, `isCapturing` |
| `audio-playback` | browser | `prepare`, `play`, `stop`, `isPlaying`, `getPlaybackSeconds`, `dispose` |

### 3.2 Plugin convention

A plugin is an ordinary class with `readonly id` (dotted, stable, equal to the registry id and configuration value), `readonly version`, `readonly category`, optional `readonly dependencies: string[]`, and optional `initialize`, `shutdown`, `isAvailable` (probed by `/api/health`), `getDisplayName`. `CATEGORY_REQUIRED_METHODS` in `src/core/PluginManager.ts` is authoritative.

### 3.3 Lifecycle

1. Registration and selection - `registry.add(id, factory)` with factories receiving a scoped logger; the nine `plugins.*` primary slots plus `plugins.additional` are collected. The browser loads only its three categories via a category filter; `additional` plugins are server-side only.
2. Metadata validation - id non-empty and matching the selection; version non-empty; category known and matching the slot; `dependencies` an array of non-empty strings; every required method for the category present.
3. Dependency validation - each declared dependency must be selected.
4. Topological ordering (Kahn); a cycle fails startup and names its members.
5. Initialization in dependency order; on failure, already initialized plugins are shut down in reverse (best effort) and startup aborts.
6. Runtime lookups (`getByCategory` for primaries, `getPlugin(id)` for additional plugins such as the scripted fallback), then shutdown in reverse initialization order with per-plugin errors logged.

Server plugins: `dialogue.ollama`, `dialogue.remote`, `dialogue.scripted`, `personality.haunted-pumpkin`, `speech-recognition.local`, `speech-synthesis.neural`, `lipsync.openfacefx`, `memory.session`. Browser plugins: `character.pumpkin`, `microphone.browser`, `audio.playback-webaudio`.

### 3.4 Shipped plugins

- Dialogue: `OllamaDialoguePlugin` (native `/api/chat`, JSON mode, keep-alive, timeout); `RemoteDialoguePlugin` (14 presets, OpenAI or Anthropic wire formats; the shipped default is the OpenRouter preset on `nvidia/nemotron-3.5-super-vl:free`, selected through the `LLMOL_DIALOGUE_MODEL` environment variable; requires `acknowledgeRemoteProcessing: true` and a backend-environment key, and degrades to unavailable with a warning when the key is missing); the OpenAI-style path tolerates reasoning models (string content, multimodal content parts, or a `reasoning`-only message) instead of failing on shape; `ScriptedDialoguePlugin` (rules plus rotating lines, always available).
- Personality: `HauntedPumpkinPersonalityPlugin` - six emotions (`neutral, amused, suspicious, dramatic, delighted, grumpy`), six deliveries (`normal, deadpan, dramatic, whisper, fast, slow`), a 280-character limit, seven secret phrases (toggleable), and the JSON contract instructions.
- Speech recognition and synthesis: `LocalSpeechRecognitionPlugin` - whisper.cpp server (`POST {baseUrl}/inference`, multipart) or OpenAI-compatible (`POST {baseUrl}/audio/transcriptions`); `NeuralSpeechSynthesisPlugin` - a Piper executable (shipped default; `--model`, `--output_file`, stdin text), Kokoro-FastAPI, or OpenAI-compatible `/v1/audio/speech`; delivery maps to speed multipliers; all engines currently return `timing: null`.
- Lip-sync: `OpenFaceFxLipSyncPlugin`; memory: `SessionMemoryPlugin` (bounded per-session messages, reset and idle purge); character: `PumpkinModelPlugin` (procedural Three.js pumpkin, one static `TUNING` table, per-frame mouth).
- Audio: `MicrophoneController` (getUserMedia, ScriptProcessor frames, 20 s ring buffer), `AudioPlaybackController` (playback clock, fade stop), `VoiceActivityDetector` (RMS gate, adaptive floor).

## 4. Data formats

| Type | Fields that matter | Invariants |
| --- | --- | --- |
| `ConversationMessage` | `role: "visitor" \| "character"`, `text` | immutable |
| `DialogueRequest` | sessionId, turnId, text, history, instructions, allowedEmotions, allowedDeliveries, maxResponseCharacters | built only by the turn route |
| `DialogueResponse` | text, emotion, delivery, providerId | providers convert their wire format into this |
| `SpeechResult` | audioWav (WAV >= 44 bytes), sampleRate, durationSeconds, voiceId, timing \| null | positive rate/duration, non-empty voice |
| `TranscriptionResult` | text, confidence \| null | confidence in [0, 1] |
| `SpeechTiming` | durationSeconds, source, ordered `PhonemeMark[]` | marks ordered and inside duration; source in `provider-phonemes, provider-words, energy-alignment, estimated` |
| `FacialAnimationTrack` | durationSeconds, 8 channels, ordered `FacialKeyframe[]` | 8 weights per keyframe; JSON round-trip via `toJson`/`fromJson` |
| `FacialState` | 8 viseme weights + eye/glow/head channels | one reused mutable instance per frame |
| `CharacterState` | 7-state union | transitions only through `CharacterController` |
| `WavData` | sampleRate, channels, samples | decoder: 8/16/24/32-bit PCM and 32-bit float, mono/stereo |

## 5. Conversation turn flow (`POST /api/conversation/turn`)

1. Validate body: `sessionId` (8-64 chars, `[A-Za-z0-9_-]`), integer `turnId >= 1`, non-empty `text` of at most 800 characters; `beginTurn` rejects a `turnId` not newer than the latest for the session with 409 `stale-turn`.
2. An `AbortController` armed for request close is combined with `turnTimeoutMs` (45 s) via `AbortSignal.any`.
3. If `personality.matchesSecretPhrase(text)` matches, it answers directly; otherwise the personality builds instructions, the route assembles a `DialogueRequest` (history from session memory), and calls the dialogue plugin.
4. On dialogue failure with `dialogue.scripted.fallbackEnabled` and the scripted plugin loaded, the request is retried against it and the turn reports `dialogueFallback: true`; otherwise the turn fails. The same fallback runs when the provider's output is rejected by the processor (see step 5), so the visitor always hears an in-character line.
5. `DialogueResponseProcessor` strips code fences, parses the JSON intent (whole body or embedded `{...}`), salvages `"text"` from truncated JSON, falls back to prose, sanitizes control characters, clamps text to `min(personality limit, maxResponseCharacters)` at a word boundary, and validates emotion/delivery (defaults `neutral` / `normal`). Text that looks like the model's internal reasoning (for example "The user is asking...") is rejected outright — chain-of-thought must never be spoken, whether it arrives in `content`, in `reasoning`, or mid-stream.
6. Speech synthesis runs with the processed emotion/delivery; a failure sets `degraded: true` and the turn still returns text for subtitles.
7. Timing: provider timing if present, else `alignTextToAudio` (energy alignment) with `estimateFromTextOnly` as the catch-all; the source is reported as `timingSource`; the lip-sync plugin turns it into a `FacialAnimationTrack`.
8. If a newer turn superseded this one during preparation, the response is 409 `stale-turn` and nothing is recorded; otherwise visitor and character messages are recorded in memory, and the response carries base64 WAV, track JSON, flags, per-stage latencies, and provider ids.

### Streamed turn flow (`POST /api/conversation/turn-stream`, NDJSON)

The browser uses this variant for every spoken turn. The route emits one `chunk` event per spoken sentence (text, base64 WAV, facial track), then a final `done` event with emotion/delivery/providers/latencies; `error` and `stale` events cover failures.

1. Same validation and turn fencing as above; the response is written as `application/x-ndjson` and events are flushed as they happen.
2. When the dialogue plugin provides `streamResponseText` (remote and Ollama plugins do), raw model deltas are piped through `SpokenTextStreamer`, which decodes the `"text"` JSON value incrementally, respects escapes, falls back to raw prose streaming for non-JSON output, and yields complete sentences. Only reply-content deltas are used; `reasoning` deltas are ignored; a sentence that looks like internal reasoning aborts the stream and triggers the scripted fallback when nothing has been spoken yet.
3. Each sentence is synthesized and aligned on its own, so the first sentence is audible while the model is still writing the rest. A stream activity watchdog aborts the upstream stream (cancelling the provider request) and answers with a scripted line when nothing arrives: 4 s of zero stream activity, or 12 s of reasoning keep-alives with no speakable text. Reasoning deltas reach the watchdog as empty activity markers, so a healthy thinking model is never mistaken for a dead connection.
4. The client (`ConversationCoordinator`) enqueues chunk audio in `AudioPlaybackController`'s queue, prepares each chunk's facial track when that chunk starts (via `onChunkStarted`), and accumulates subtitles as words fly in. Chunks play seamlessly back to back; the turn completes when the queue drains. Plugins without streaming fall back to a single chunk produced by the classic pipeline, so the client handles one shape.
5. Memory, counters, latency sums, and stale-turn handling match the classic route; the `done` event carries the same diagnostics the browser shows.

## 6. Speech pipeline end to end

```
 Browser                                                                  Server
 ───────                                                                  ──────
 getUserMedia (echo cancellation, noise suppression, AGC)
   │ ScriptProcessor frames (4096 samples)
   ▼
 VoiceActivityDetector (RMS vs adaptive noise floor)
   │ speech-start ─────────────▶ interrupt playback, state LISTENING
   │ speech-end ───────────────▶ utterance = ring slice + preroll (400 ms)
   ▼
 resample to 16 kHz + encodeWavMono
   ▼
 POST /api/speech/transcribe (audio/wav) ─────────────▶ LocalSpeechRecognitionPlugin
   │                                                      └─ whisper.cpp / OpenAI-compatible
   ▼
 POST /api/conversation/turn ─────────────────────────▶ dialogue plugin ──▶ DialogueResponse
   │                                                      response processor (intent JSON, clamp)
   │                                                      speech-synthesis plugin ──▶ WAV, timing:null
   │                                                      alignTextToAudio (energy, else estimated)
   │                                                      lip-sync plugin ──▶ FacialAnimationTrack
   │ ◀──── JSON: base64 WAV, track keyframes, timingSource, latency, flags
   ▼
 AudioPlaybackController.prepare(wav) → play()      (playback clock = AudioContext time)
   ▼
 FacialAnimationController.fillWeights (cursor lookup, 150 ms release ramp)
   ▼
 CharacterAnimationMixer (viseme × expression, clamped)
   ▼
 PumpkinModelPlugin.applyFacialState (mouth geometry, eyes, glow, head)
   ▼
 Three.js render loop
```

Hold-to-talk uses the same path without VAD: a manual capture window (same preroll) submits its slice on release. Interruption aborts in-flight requests, stops audio with a fade, clears the facial track, and bumps the turn id so stale results are dropped on both ends.

## 7. Character state machine

| State | `visitorSpeechStarted` | `turnSubmitted` | `speechPrepared` | `playbackStarted` | `playbackFinished` | `interruptionBegan` | `turnFailed` | `recoveryFinished` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| IDLE | LISTENING | - | - | - | - | - | - | - |
| LISTENING | LISTENING | THINKING | - | - | - | - | RECOVERING | - |
| THINKING | - | - | PREPARING_SPEECH | - | - | INTERRUPTED | RECOVERING | - |
| PREPARING_SPEECH | - | - | - | SPEAKING | - | INTERRUPTED | RECOVERING | - |
| SPEAKING | - | - | - | - | IDLE | INTERRUPTED | - | - |
| INTERRUPTED | LISTENING | - | - | - | - | - | - | - |
| RECOVERING | LISTENING | - | - | - | - | - | - | IDLE |

Unlisted events for the current state are ignored with a log. With auto-listen on, the nominal `IDLE` target of `playbackFinished` and `recoveryFinished` resolves to `LISTENING`. The table lives in `CharacterController.TRANSITIONS` (`src/application/CharacterController.ts`).

## 8. Lip-sync algorithm

1. Each `PhonemeMark` maps to one 8-channel viseme vector (`SIL, CLOSED, FV, OPEN, WIDE, ROUND, NARROW, INTERMEDIATE`). Stops map to one channel; diphthongs (`AY, AW, EY`) blend across two; silence aliases map to SIL; unknown phonemes fall back to INTERMEDIATE.
2. Coarticulation blends each mark with neighbors using a triangular kernel over `lipSync.coarticulationMs` (60 ms), so the mouth anticipates instead of snapping.
3. Keyframes: one per mark start (first floored at 1 ms); a SIL keyframe at t=0 when the first mark starts later than 20 ms, and a SIL tail when the last mark ends earlier than duration − 20 ms.
4. `lipSync.minimumHoldMs` (40 ms) collapses candidates too close to the previous kept keyframe (the final one is always kept); no marks produce a two-keyframe silence track.
5. Playback: `FacialAnimationController` calls `findSegmentIndex(playbackSeconds, cursor)`; forward playback scans a few segments from the cursor, a jump falls back to binary search, and weights are linearly interpolated within the segment. When audio stops, a 150 ms release ramp blends back toward silence.

## 9. Timing algorithms (`SpeechTimingProcessor`)

- Heuristic G2P: ~55-entry exception dictionary, ordered multi-letter digraph rules (longest first), silent-e handling, letter-to-phoneme table. The estimator distributes the full duration across phonemes by intrinsic durations (single SIL mark for empty input), and the provider normalizer accepts and sanitizes `provider-phonemes` or `provider-words` marks.
- Energy alignment (primary path today): RMS per 10 ms frame; the speech gate uses the quietest 10% (noise floor) and loudest 20% (loud reference) of frames; voiced runs are bridged over short gaps, short bursts dropped, segments padded 30 ms. Words receive a share of voiced time proportional to intrinsic phoneme durations; shares walk the voiced segments in order, skipping silences, so pauses remain gaps; phonemes split each word span, and marks under 20 ms are culled.

## 10. Dependency rules

- Layers flow one way: `data` (leaf) -> `core` -> `animation` -> `plugins` -> `application` -> `server`/`frontend`; a lower layer never imports a higher one. The one deliberate exception is `Application` (core lifecycle), which invokes the server composition root as the process entry point. The browser entry never imports `src/server/`.
- Plugins depend only on `core`, `data`, and `animation` (lip-sync uses `VisemeMapper`). No plugin imports another plugin.
- Orchestration lives in `application/`; HTTP transport in `server/`; DOM and Three.js in `frontend/`.
- The composition roots (`ApplicationCompositionRoot` and `frontend/main.ts`) are the only places that construct concrete collaborators.
- Browser-only plugins are never loaded server-side: the composition root clears those selections before the unfiltered server load (the only mode that also loads `additional` plugins).

## 11. API reference

All responses are JSON; errors use `{"error": {"code": "<code>", "message": "<text>"}}`. JSON bodies are limited to 256 KiB, binary bodies to 4 MiB.

| Method + path | Request | Response |
| --- | --- | --- |
| `GET /api/client-config` | - | `applicationName, version, logLevel, characterName, plugins, booth (autoListen, pushToTalkEnabled, subtitlesEnabled, voiceActivity), characterModel (4 colors), providerLabels {dialogue, speechRecognition, speechSynthesis, lipSync, personality}` - no dialogue or remote settings |
| `GET /api/health` | - | `status: "ok" \| "degraded", version, uptimeSeconds, plugins: [{id, category, available: true \| false \| null}]`; cached 10 s; probes capped at 1.5 s; `null` when no probe is declared |
| `GET /api/diagnostics` | - | `version, uptimeSeconds, turnsCompleted, turnsFailed, fallbackTurns, averageLatency \| null {dialogueMs, synthesisMs, timingMs, lipSyncMs, totalMs}, timingSources, recentErrors (<= 20), activeSessions` |
| `POST /api/speech/transcribe` | raw WAV, `Content-Type: audio/wav` or `application/octet-stream` | `{text, confidence \| null}`; 503 `stt-unavailable`, 415 `unsupported-media-type`, 400 `invalid-audio`, 504 `transcribe-timeout`, 502 `transcription-failed` |
| `POST /api/conversation/turn` | `{sessionId, turnId, text}` | `{turnId, text, emotion, delivery, audioWavBase64 \| null, sampleRate \| null, durationSeconds \| null, track \| null, timingSource \| null, degraded, dialogueFallback, latency {dialogueMs, synthesisMs, timingMs, lipSyncMs, totalMs}, providers {dialogue, speech}}`; 409 `stale-turn`, 504 `dialogue-timeout` / `synthesis-timeout`, 502 `dialogue-unavailable` / `processing-failed` |
| `POST /api/conversation/turn-stream` | `{sessionId, turnId, text}` | NDJSON stream: `{type:"chunk", index, text, audioWavBase64 \| null, sampleRate, durationSeconds, track, timingSource}` per sentence, then `{type:"done", turnId, text, emotion, delivery, timingSource, degraded, dialogueFallback, providers, latency {dialogueMs, synthesisMs, timingMs, lipSyncMs, totalMs, firstChunkMs}}`; `{type:"error", code, message}` and `{type:"stale", turnId}` also possible; 400/409 as above |
| `POST /api/conversation/reset` | `{sessionId}` | `{ok: true}` |

Static serving: `GET`/`HEAD` from `dist/`, `index.html` fallback for extensionless paths, 503 when `dist/` is missing, traversal guard on the resolved path, and `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.

Stage magic: `CharacterEffectsController` (browser) owns five deterministic THREE.Points systems updated in place — drifting fireflies at rest, golden soul-motes that flow into the face while LISTENING, embers that puff from the mouth while SPEAKING (emission follows the mouth via the shared facial state), orbiting sparks while THINKING, and a radial burst on INTERRUPTED. All particle math is allocation-free per frame, and opacity ramps both ways so states fade into each other.

Local service supervision: `LocalSpeechServiceSupervisor` starts the local whisper.cpp server before the HTTP listener when `speechRecognition.whisperCpp.autoStart` is true and the configured executable/model exist; it leaves an already-responding server alone, streams the child's output to the logger (tagged `whisper:`), polls the endpoint until ready (30 s cap), and terminates the child on shutdown. Startup failures are warnings, never crashes: the booth degrades to no voice input with an actionable message. Everything it needs was installed into `./services` by `pnpm run setup` (`scripts/setupServices.ts`), which fetches the whisper.cpp release binaries and model plus the Piper build and voice, all relative to the repository.

## 12. Configuration model

Precedence (lowest to highest): built-in defaults, JSON file, `.env`, real environment variables. Path defaults to `llm-o-lantern.config.json` (`LLMOL_CONFIG` overrides). Typed readers clamp numbers to ranges, validate enums and hex colors, and accumulate problems into one startup error naming each path.

- Remote dialogue always requires the explicit `acknowledgeRemoteProcessing` consent (the shipped `llm-o-lantern.config.json` sets it to `true` together with the OpenRouter preset); a missing API key does not fail startup - the provider reports unavailable, health shows degraded, and turns use the scripted fallback. The piper engine requires both paths in configuration but degrades to subtitles (with a `pnpm run setup` hint) when the files are missing; whisper auto-start degrades the same way when its files are absent. `plugins.additional` cannot duplicate a primary selection.
- Environment overrides: `LLMOL_HOST`, `LLMOL_PORT`, `LLMOL_LOG_LEVEL`, `LLMOL_DIALOGUE_MODEL` (the remote provider's model id; this is how the model is selected without code or JSON edits), `LLMOL_DIALOGUE_PRESET`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `OLLAMA_KEEP_ALIVE`, `LLMOL_STT_BASE_URL`, `LLMOL_TTS_BASE_URL`. API keys are read only from the backend environment, named by `apiKeyEnv` configuration fields.
- `getPublicBoothConfig()` excludes dialogue settings, key names, and remote state from the browser payload.

## 13. Privacy and reliability

- Microphone audio exists only in the browser ring buffer and the local transcription request; nothing is persisted to disk. Session memory is per-session and bounded (16 messages / 8000 characters), cleared on reset, purged after 30 minutes idle (checked every 60 s); no cross-visitor history.
- The shipped configuration selects remote dialogue (OpenRouter, free `nvidia/nemotron-3.5-super-vl:free` chosen via `LLMOL_DIALOGUE_MODEL`) with the explicit acknowledgment flag set; selecting `dialogue.ollama` or `dialogue.scripted` in the config file restores fully offline operation. Enabling or switching remote providers requires the consent flag plus a backend-environment key. Keys never reach the browser; the logger redacts credential-shaped keys recursively.
- Dialogue falls back to scripted when enabled; TTS failure degrades to subtitles (`degraded: true`, no audio/track); stale turns are 409 on both ends; every failure path ends in RECOVERING then IDLE (or LISTENING), so the character cannot be left stuck. The UI polls `GET /api/health` every 15 s and raises a banner when the backend stops answering.

## 14. Testing

Vitest (Node environment, `tests/**/*.test.ts`): plugin lifecycle (topology, cycles, reverse shutdown, category filter, metadata validation), configuration, logger redaction, dialogue wire formats, scripted rules, personality phrases, G2P and energy alignment, viseme mapping, track interpolation and seek, the state machine (including the PREPARING_SPEECH guard), coordinator stale-result protection, subtitle-only degradation, VAD, memory bounds, response processing, server routes over real HTTP with fake plugins, the full turn pipeline with fakes, and opt-in live-service smoke tests for Ollama, Kokoro, and whisper. The render loop itself is allocation-light by rule: one reused `FacialState`, scratch objects, a cursor-based track lookup with a binary-search fallback, and a clamped frame delta.
