# llm-o-lantern - Product Description

## Vision

llm-o-lantern is a modular, local-first, conversational 3D jack-o'-lantern. A visitor walks up to the booth, speaks, and the pumpkin answers out loud through a face that actually moves: mouth shapes driven by the speech itself, blinking eyes, a glow that shifts with mood, and a body that reacts to the conversation. The privacy posture is explicit, not silent: the shipped configuration selects OpenRouter cloud dialogue with the required acknowledgment flag, while speech recognition and speech synthesis stay on the booth machine. Selecting the local Ollama provider or the scripted provider returns the entire experience to fully offline operation.

The project is built as a small plugin platform, not a monolith: every capability (dialogue source, personality, speech in, speech out, lip-sync, character model, memory) is a swappable concrete class that is registered, validated, and initialized at startup.

## Audience

- Operators and builders: Developers' Club members running a Halloween booth. They configure the machine, start the local services, watch the diagnostics panel, and reset the character between visitors.
- Booth visitors: people passing by in a dark, loud, fast-moving venue. They get one short interaction - no account, no app, no awareness of the stack.

## The booth experience

1. A start overlay covers the scene. One click unlocks browser audio and the microphone, and the pumpkin wakes up.
2. The pumpkin idles with a breathing sway, periodic blinks, and a flickering candle glow.
3. Auto-listen (default) or hold-to-talk captures the visitor's voice; voice activity detection decides when an utterance starts and ends.
4. The character visibly thinks (dimmed glow, narrowed eyes), prepares, then speaks with a moving mouth and shifts in light and motion for the reply's emotion.
5. Subtitles show both sides of the conversation, so the interaction still reads in a noisy room and still works if speech synthesis fails.
6. An operator presses Reset (or R) between visitors: audio stops, the session memory is purged, and the character returns to IDLE without a restart.
7. If a new visitor starts talking while the character speaks, it stops and listens - an interruption is behavior, not an error.

## Features

- Conversational dialogue with three selectable provider plugins: the remote plugin shipped as the default (OpenRouter with the free `nvidia/nemotron-3.5-super-vl:free` model via the OpenAI-compatible Chat Completions API — the model is chosen from `.env` via `LLMOL_DIALOGUE_MODEL`, not hardcoded — with the required `acknowledgeRemoteProcessing` consent set in the shipped configuration; 13 other presets available), the local Ollama plugin as a drop-in alternative, and a scripted offline fallback that answers in character with no services running. A missing key or failed provider degrades to the scripted fallback instead of stalling the booth.
- A named personality ("Gourdrick", a haunted pumpkin) that constrains the model to short, in-character, family-friendly replies with a fixed emotion and delivery vocabulary, plus discoverable secret phrases.
- Local speech recognition (whisper.cpp server or any OpenAI-compatible Whisper endpoint) and local neural speech synthesis (Kokoro-FastAPI, a Piper executable, or a generic OpenAI-compatible endpoint).
- Lip-sync from phoneme timing: provider timestamps when available, energy-based forced alignment on the synthesized WAV as the primary path, and a duration-based estimator as the final fallback; the timing source is reported in every turn's diagnostics.
- A procedural, code-generated 3D pumpkin (Three.js): ribbed body, stem, emissive eyes and mouth, visible teeth, face and ground lights, with the palette coming from configuration.
- Expressive behavior: per-state expression presets, deterministic idle motion, blinking, six emotion reactions, and an 8-channel viseme mouth deformation.
- An explicit character state machine (IDLE, LISTENING, THINKING, PREPARING_SPEECH, SPEAKING, INTERRUPTED, RECOVERING) so the character is never stuck in an impossible combination of behaviors.
- Privacy by design: per-session bounded memory purged on reset and idle expiry; nothing persisted to disk; credentials read only from the backend environment and redacted from logs.
- Booth hardening: health endpoint with per-plugin probes, a latency diagnostics panel, error banner, one-action reset, stale-turn rejection on both ends, and graceful degradation around every failed provider.

## Constraints

- Runs on a single booth machine; one visitor conversation at a time per page load. The browser must support WebGL and the Web Audio API.
- The shipped configuration uses OpenRouter cloud dialogue (explicitly acknowledged) while speech recognition and speech synthesis run locally from the self-contained `services/` directory that `npm run setup` fills with whisper.cpp and Piper; selecting `dialogue.ollama` or `dialogue.scripted` returns the whole experience to fully offline, and the scripted fallback keeps the character talking if any provider dies.
- Latency matters more than sophistication: replies are capped (280 characters by default) so synthesis and lip-sync stay short.
- The booth is dark and loud; the design leans on subtitles, push-to-talk, a large state badge, and operator controls.
- No accounts, no analytics, no persistence; local providers and scripted mode run with no cloud dependency at all. Non-goals: multi-character scenes, persistent visitor history, mobile apps.

## What makes it a character, not a chatbot

- Dialogue output is not text on a screen. It is a speech intent (text, emotion, delivery) that becomes audio, a timed mouth track, body state, and light; text is only one channel.
- State is embodied: THINKING dims the glow and narrows the eyes, SPEAKING raises it, INTERRUPTED flares it. The state machine drives the body, and the body is the interface.
- Time is physical: the mouth is driven by the audio playback clock, so the same cursor that decides where the audio is decides which viseme shows.
- Conversation has social rules: interrupting makes the pumpkin stop and listen; a failure is a recovery beat, not an error dialog; secret phrases are part of its personality.
- The platform is replaceable underneath the character. Swap the LLM, the voice, or the model and it is still the same pumpkin, because the character is defined by the personality plugin, the state machine, and the animation layer - not by the model.
