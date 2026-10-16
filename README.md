# llm-o-lantern

A modular, local-first, conversational 3D jack-o'-lantern for a Halloween
booth. It listens through a microphone, answers with a local LLM, speaks with
a local neural voice, and drives a live 3D pumpkin face from the speech audio.
Everything runs on the booth machine by default; remote dialogue providers are
off unless explicitly acknowledged.

See DESCRIPTION.md for the product description, DESIGN.md for the architecture,
PLAN.md for the delivery record, and PROJECT-RULES.md for the engineering
rules.

## Requirements

- Node.js 20.11 or newer (development and testing were done on Node 24) and
  npm.
- A browser with WebGL2 and the Web Audio API (current Chrome, Edge, or
  Firefox).
- Optional local services for the full experience: Ollama (dialogue),
  Kokoro-FastAPI or Piper (speech synthesis), a whisper.cpp server or any
  OpenAI-compatible Whisper endpoint (speech recognition), and a microphone.

## Quick start

```bash
npm install
npm run dev
```

`npm run dev` starts the API server (`tsx watch src/server/server.ts`) and the
Vite dev server together. Open `http://localhost:5173`, click "Wake the
pumpkin", and allow the microphone when asked.

For a production-style run on one port:

```bash
npm run build
npm start
```

Open `http://127.0.0.1:8787`. The server serves the built frontend from
`dist/` and the API on the same origin.

| Script | Purpose |
|---|---|
| `npm run dev` | API + Vite dev server (proxy `/api` -> `127.0.0.1:8787`) |
| `npm run dev:server` | API server only, with watch mode |
| `npm run dev:web` | Vite dev server only (port 5173) |
| `npm run build` | Build the frontend to `dist/` |
| `npm start` | Serve `dist/` + API (port 8787) |
| `npm test` | Run the Vitest suite |
| `npm run test:watch` | Vitest in watch mode |
| `npm run typecheck` | TypeScript check (`tsc --noEmit`) |

## Local services

Defaults assume these ports. Each service is independent; see the
troubleshooting table for what happens when one is missing.

| Service | Default URL | Used for |
|---|---|---|
| llm-o-lantern API | `http://127.0.0.1:8787` | API + static frontend (`npm start`) |
| Vite dev server | `http://localhost:5173` | Development UI, proxies `/api` |
| Ollama | `http://127.0.0.1:11434` | Dialogue (default provider) |
| Kokoro-FastAPI | `http://127.0.0.1:8880` | Speech synthesis (default engine) |
| Piper | local executable | Speech synthesis (alternative engine) |
| whisper.cpp server | `http://127.0.0.1:8082` | Speech recognition (default engine) |

### Ollama (dialogue)

Install Ollama from `https://ollama.com`, then:

```bash
ollama pull llama3.2
ollama serve        # if it is not already running as a service
```

The app calls the native Ollama API (`POST /api/chat`) on port 11434 with
model `llama3.2` by default; change either via `dialogue.ollama.model` /
`dialogue.ollama.baseUrl` or `OLLAMA_MODEL` / `OLLAMA_BASE_URL`.

### Kokoro-FastAPI (speech synthesis, default)

Quickest start is Docker:

```bash
docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest
```

With GPU: add `--gpus all` and use `ghcr.io/remsky/kokoro-fastapi-gpu:latest`.
Alternatively run it natively with uv: clone
`https://github.com/remsky/Kokoro-FastAPI` and run `start-cpu.ps1` (Windows)
or `start-cpu.sh` (Linux/macOS). The API listens on `http://127.0.0.1:8880`
(docs at `/docs`); the app posts to `/v1/audio/speech` with
`response_format: "wav"`. The voice is `speechSynthesis.kokoro.voice`
(default `bm_george`).

### Piper (speech synthesis, alternative)

Download the Piper binary and a voice model (for example
`en_US-lessac-medium.onnx`) from the Piper releases, then configure:

```jsonc
"speechSynthesis": {
  "engine": "piper",
  "piper": {
    "executablePath": "C:\\piper\\piper.exe",
    "voiceModelPath": "C:\\piper\\en_US-lessac-medium.onnx"
  }
}
```

Manual check: `echo "Boo" | piper --model en_US-lessac-medium.onnx
--output_file test.wav`. Both paths must exist or startup fails.

### whisper.cpp (speech recognition)

```bash
git clone https://github.com/ggml-org/whisper.cpp
cd whisper.cpp
cmake -B build
cmake --build build --config Release
# Windows:      .\models\download-ggml-model.cmd base.en
# Linux/macOS:  sh ./models/download-ggml-model.sh base.en
# Run the server (binary name varies: whisper-server or server):
.\build\bin\Release\whisper-server.exe -m models\ggml-base.en.bin --port 8082
```

The app posts multipart audio to `http://127.0.0.1:8082/inference`. Any
OpenAI-compatible Whisper endpoint also works: set `speechRecognition.engine`
to `"openai-compatible"` and point `speechRecognition.openaiCompatible.baseUrl`
at it (optionally with a key via `apiKeyEnv`).

## Configuration

The configuration file is `llm-o-lantern.config.json` (override the path with
`LLMOL_CONFIG`). Precedence, lowest to highest: built-in defaults, JSON file,
`.env`, real environment variables. Copy `.env.example` to `.env` to override
service URLs and set API keys. Invalid values fail startup with one error
listing every problem and its exact path.

Frequently changed settings:

| Setting | Default | Purpose |
|---|---|---|
| `server.host` / `server.port` | `127.0.0.1` / `8787` | API bind address |
| `plugins.*` | see file | Plugin selection per category |
| `dialogue.ollama.model` | `llama3.2` | Local model |
| `dialogue.scripted.fallbackEnabled` | `true` | Scripted replies when the provider fails |
| `personality.characterName` | `Gourdrick` | Name shown in the UI |
| `personality.secretPhraseDiscovery` | `true` | Enable secret-phrase responses |
| `speechSynthesis.engine` | `kokoro` | `kokoro`, `piper`, or `openai-compatible` |
| `speechSynthesis.speedAdjustments` | per delivery | Speed multipliers (normal/fast/slow/dramatic/whisper) |
| `speechRecognition.engine` | `whisper-cpp` | `whisper-cpp` or `openai-compatible` |
| `speechRecognition.language` | `null` (auto) | Force a transcription language |
| `lipSync.coarticulationMs` / `lipSync.minimumHoldMs` | `60` / `40` | Mouth smoothing / keyframe collapsing |
| `conversation.maxHistoryMessages` | `16` | Bounded per-session history |
| `conversation.maxResponseCharacters` | `280` | Reply length clamp |
| `conversation.sessionIdleExpiryMs` | `1800000` | Idle session purge (30 min) |
| `booth.autoListen` | `true` | Continuous listening vs push-to-talk only |
| `booth.voiceActivity.*` | thresholds | Mic gate tuning for the venue |
| `characterModel.*` | orange/gold palette | Pumpkin and glow colors |
| `logging.level` | `info` | `debug`, `info`, `warn`, `error` |

Environment variables (always win over the JSON file): `LLMOL_HOST`,
`LLMOL_PORT`, `LLMOL_CONFIG`, `LLMOL_LOG_LEVEL`, `OLLAMA_BASE_URL`,
`OLLAMA_MODEL`, `OLLAMA_KEEP_ALIVE`, `LLMOL_STT_BASE_URL`,
`LLMOL_TTS_BASE_URL`.

### Remote dialogue providers (opt-in)

Remote providers are disabled by default. To use one, make two explicit
configuration changes and provide the key in the backend environment:

```jsonc
"plugins": { "dialogue": "dialogue.remote" },
"dialogue": {
  "remote": { "preset": "openai", "acknowledgeRemoteProcessing": true }
}
```

```bash
# .env (backend only; never sent to the browser)
OPENAI_API_KEY=sk-...
```

| Preset | Provider | Default base URL | Default model | API key env |
|---|---|---|---|---|
| `openai` | OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | `OPENAI_API_KEY` |
| `anthropic` | Anthropic | `https://api.anthropic.com/v1` | `claude-sonnet-4-5` | `ANTHROPIC_API_KEY` |
| `deepseek` | DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | `DEEPSEEK_API_KEY` |
| `openrouter` | OpenRouter | `https://openrouter.ai/api/v1` | `meta-llama/llama-3.3-70b-instruct` | `OPENROUTER_API_KEY` |
| `groq` | Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | `GROQ_API_KEY` |
| `mistral` | Mistral | `https://api.mistral.ai/v1` | `mistral-small-latest` | `MISTRAL_API_KEY` |
| `together` | Together AI | `https://api.together.xyz/v1` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | `TOGETHER_API_KEY` |
| `xai` | xAI | `https://api.x.ai/v1` | `grok-3-mini` | `XAI_API_KEY` |
| `perplexity` | Perplexity | `https://api.perplexity.ai` | `sonar` | `PERPLEXITY_API_KEY` |
| `fireworks` | Fireworks | `https://api.fireworks.ai/inference/v1` | `accounts/fireworks/models/llama-v3p3-70b-instruct` | `FIREWORKS_API_KEY` |
| `llamacpp` | llama.cpp (local) | `http://127.0.0.1:8080/v1` | `local-model` | none |
| `vllm` | vLLM (local) | `http://127.0.0.1:8000/v1` | `local-model` | none |
| `lmstudio` | LM Studio (local) | `http://127.0.0.1:1234/v1` | `local-model` | none |
| `ollama-openai` | Ollama (OpenAI-compatible) | `http://127.0.0.1:11434/v1` | `llama3.2` | none |

Starting without the acknowledgment, or without the key present in the
environment, fails startup with a message naming the requirement. The startup
log warns that visitor speech will leave the machine while a remote provider
is active.

## Operator guide

- Start overlay: one click unlocks browser audio and the microphone. In
  auto-listen mode this is also the microphone permission moment.
- State badge: the live character state - IDLE, LISTENING, THINKING,
  PREPARING_SPEECH, SPEAKING, INTERRUPTED, RECOVERING.
- Subtitles: both sides of the conversation, so the booth works even when the
  room is too loud to hear it.
- Error banner: service and backend problems, auto-hiding after 8 seconds; the
  last 10 errors stay listed in the diagnostics panel.

| Control | Key | Action |
|---|---|---|
| Listen toggle | `M` | Turn auto-listening on/off |
| Hold to talk | `T` (hold) | Capture while held, submit on release |
| Reset visitor | `R` | Stop everything, purge the session, return to IDLE |
| Diagnostics | `D` | Show/hide the diagnostics panel |

Diagnostics rows: Backend (health polling), Turn, Providers, Timing source
(`energy-alignment`, `estimated`, `provider-phonemes`, or `provider-words`),
Reply total, Sound to lips (turn submission to first audible audio in the
browser), Dialogue / Synthesis / Timing / Lip sync per-stage latency, Audio
length, and Fallback (scripted fallback or subtitle degradation used).

Reset between visitors: it clears the session memory server-side and stops any
audio or animation immediately, with no restart.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Overlay says the backend is not reachable | API server not running | `npm run dev:server` (or `npm run dev`); check `http://127.0.0.1:8787/api/health` |
| Diagnostics Backend shows "offline" | Same as above | Start the API; the banner clears automatically |
| "Microphone permission was denied" | Browser permission refused | Allow the microphone for the page and reload |
| "Speech recognition is offline." | whisper.cpp server not running | Start it on port 8082; health shows `speech-recognition.local` unavailable |
| Replies time out (`dialogue-timeout`) | Ollama not running or model not pulled | `ollama serve` and `ollama pull llama3.2` |
| No audio, subtitles only | Speech synthesis unreachable | Start Kokoro (`docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest`) or switch `speechSynthesis.engine` to `piper` |
| Mouth motion looks approximate | Timing source is `energy-alignment` or `estimated` | Expected today (no TTS timing metadata); see PLAN.md open decisions |
| All providers down | No local services reachable | The scripted fallback keeps the character talking; set `plugins.dialogue` to `dialogue.scripted` for deliberate offline operation |
| Startup fails naming a configuration path | Invalid value in `llm-o-lantern.config.json` | Fix the named path; the error lists every problem at once |
| `npm start` says the web build is missing | `dist/` not built | `npm run build` |

## Privacy notes

- Microphone recordings are never persisted: audio lives in an in-memory ring
  buffer, is sent once to the local transcription endpoint, and is discarded.
- Conversation memory is per-session and bounded (16 messages / 8000
  characters), cleared by Reset, purged after 30 minutes idle. No
  cross-visitor history.
- Remote dialogue is off by default; enabling it requires the explicit
  acknowledgment plus a backend-environment API key. Keys never reach the
  browser, and the logger redacts credential-shaped fields from every entry.
- The public configuration endpoint exposes plugin ids, booth settings, and
  colors only - never dialogue provider settings or secrets.

## Development

- Tests: `npm test` (Vitest, Node environment). Coverage spans the plugin
  lifecycle, configuration, logger redaction, dialogue wire formats, timing
  and alignment, viseme mapping, facial track interpolation, the state
  machine, the conversation coordinator, VAD, memory bounds, response
  processing, server routes over real HTTP, and the full turn pipeline with
  fake plugins.
- Live-service smoke tests are opt-in:
  `INTEGRATION=1 npx vitest run tests/integration` (PowerShell:
  `$env:INTEGRATION="1"; npx vitest run tests/integration`). They check that
  Ollama answers on `/api/tags`, that Kokoro returns RIFF WAV from
  `/v1/audio/speech`, and that the whisper server is reachable.
- Standard loop: `npm run typecheck`, then `npm test`, then `npm run build`.

## License

No license has been chosen for this project. The repository is private and
unlicensed; all rights are reserved by its authors. It may not be copied,
distributed, or reused without explicit permission. Add a LICENSE file and
update this section before any public release.
