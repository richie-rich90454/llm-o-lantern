# llm-o-lantern

A modular, local-first, conversational 3D jack-o'-lantern for a Halloween booth. It listens through a microphone, answers with an LLM that streams sentence by sentence (so it starts speaking while it is still thinking), speaks with a neural voice, and drives a live 3D pumpkin face from the speech audio — with soul-motes flowing into its face when it listens and embers puffing from its mouth when it speaks.

Out of the box the dialogue provider is **OpenCode Go** when a key is available (from `opencode auth login` or `OPENCODE_API_KEY`), with **OpenRouter** as the configured failover provider and the scripted mode as the final safety net. Without any key the booth still runs and answers with the scripted fallback dialogue. Every provider is replaceable: local Ollama, a self-hosted llama.cpp server, any of the other remote presets, local Kokoro/Piper voices, and local Whisper speech recognition all plug into the same boundaries.

See DESCRIPTION.md for the product description, DESIGN.md for the architecture, PLAN.md for the delivery record, and PROJECT-RULES.md for the engineering rules.

## Requirements

- Node.js 20.11 or newer (development and testing were done on Node 24) and npm.
- A browser with WebGL2 and the Web Audio API (current Chrome, Edge, or Firefox).
- An OpenRouter API key (free) for cloud dialogue — optional; without it the scripted fallback answers.
- A microphone for voice input (push-to-talk works even if auto-listen does not).

Speech recognition (whisper.cpp) and speech synthesis (Piper) install themselves into this directory with `pnpm run setup`; the booth backend starts and stops the whisper server automatically. No Python, Docker, or system-wide installs are needed.

## Quick start

```bash
pnpm install
pnpm run setup               # downloads whisper.cpp + Piper into ./services (one time)
cp .env.example .env        # Windows: copy .env.example .env
# paste your key from https://openrouter.ai/settings/keys into .env
pnpm start
```

Open `http://127.0.0.1:8787`, click "Wake the pumpkin", and allow the microphone when asked. The booth talks through Piper and listens through whisper.cpp — both started from `./services` — and thinks through OpenRouter. `pnpm run dev` gives the same experience with hot reload (open `http://localhost:5173` instead).

Without an OpenRouter key the booth still starts and talks, but every reply comes from the scripted fallback (the diagnostics panel shows "Fallback: active"). Add the key and restart to hear the real model. Without `pnpm run setup`, dialogue and subtitles still work and the logs say exactly what to run.

For a production-style run on one port:

```bash
pnpm run build
pnpm start
```

Open `http://127.0.0.1:8787`. The server serves the built frontend from `dist/` and the API on the same origin.

| Script | Purpose |
| --- | --- |
| `pnpm run setup` | Download whisper.cpp + Piper into `./services` (one time; `-- --model small.en` to pick a bigger model, `-- --force` to refresh) |
| `pnpm run dev` | API + Vite dev server (proxy `/api` -> `127.0.0.1:8787`) |
| `pnpm run dev:server` | API server only, with watch mode |
| `pnpm run dev:web` | Vite dev server only (port 5173) |
| `pnpm run build` | Build the frontend to `dist/` |
| `pnpm start` | Serve `dist/` + API, auto-start whisper.cpp (port 8787) |
| `pnpm test` | Run the Vitest suite |
| `pnpm run test:watch` | Vitest in watch mode |
| `pnpm run typecheck` | TypeScript check (`tsc --noEmit`) |

## Local services

The speech services are self-contained: `pnpm run setup` downloads them into `./services/` and `pnpm start` launches whisper.cpp automatically (Piper runs per utterance, no server). Ollama and Kokoro remain supported as alternatives.

| Service | Default URL | Used for | Managed by |
| --- | --- | --- | --- |
| llm-o-lantern API | `http://127.0.0.1:8787` | API + static frontend (`pnpm start`) | you |
| Vite dev server | `http://localhost:5173` | Development UI, proxies `/api` | `pnpm run dev` |
| OpenCode Go | `https://opencode.ai/inference/go/v1` | Dialogue (shipped default provider) | cloud |
| OpenRouter | `https://openrouter.ai/api/v1` | Dialogue (configured failover provider) | cloud |
| whisper.cpp | `http://127.0.0.1:8082` | Speech recognition (default engine) | auto-started by the backend |
| Piper | `services/piper/piper.exe` | Speech synthesis (default engine) | spawned per reply |
| Ollama | `http://127.0.0.1:11434` | Dialogue (optional local provider) | you |
| Kokoro-FastAPI | `http://127.0.0.1:8880` | Speech synthesis (optional engine) | you |

### Setup details

```bash
pnpm run setup                 # whisper model base.en (141 MB) + piper + voice
pnpm run setup -- --model=small.en   # more accurate Whisper (466 MB)
pnpm run setup -- --force      # re-download everything
```

The installer downloads:

- `services/whisper/` — the latest whisper.cpp Windows binaries plus a `ggml-*.bin` model from Hugging Face
- `services/piper/` — the Piper Windows build (with `espeak-ng-data`) and the `en_US-lessac-medium` voice in `services/piper/voices/`

`llm-o-lantern.config.json` already points at these paths; the backend starts whisper before the HTTP listener and stops it on shutdown. If the services are missing, startup logs a warning with the setup command and the booth runs with subtitles only. To use a different Piper voice, download the `.onnx` and `.onnx.json` files into `services/piper/voices/` and update `speechSynthesis.piper.voiceModelPath`.

### OpenCode Go (dialogue, shipped default)

OpenCode Go is the OpenCode subscription gateway (`https://opencode.ai/inference/go/v1`, OpenAI-compatible). No API key wrangling needed: if you use the opencode CLI, the booth reads the same login the CLI uses - the account token and active workspace from `~/.local/share/opencode/opencode.db` - and resolves it on every turn, so a token the CLI refreshes is picked up without a booth restart. Credentials are tried in order: `OPENCODE_API_KEY` from `.env`, then the CLI login, then the API key in `~/.local/share/opencode/auth.json`. The default model is `deepseek-v4.1-flash`.

Three gateway specifics are handled by the plugin:

- Every request carries the **mandatory `x-opencode-session` header** (the gateway rejects requests without it, and uses it to route and cache the conversation). The booth sends your visitor session id, so each visitor conversation gets its own cache-affinity lane.
- Requests made with the **CLI login** also carry `x-opencode-org-id` (the active workspace); the gateway requires workspace selection for account tokens and answers "Workspace selection is required" otherwise.
- Gateway rejections are surfaced verbatim. In particular, a direct `OPENCODE_API_KEY` whose workspace **Privacy setting is not "Global"** (Workspace → Privacy) gets "This Go model requires Global regions" - the auto-fetched CLI login is unaffected. Other models on the gateway require an active Go subscription seat for them individually.

### OpenRouter (dialogue, configured failover)

Create a key at `https://openrouter.ai/settings/keys`, put it in `.env`:

```bash
OPENROUTER_API_KEY=sk-or-v1-...
```

This provider is the configured failover: once OpenCode Go is cooling down or failing, OpenRouter answers. Its model is not hardcoded either - `.env` decides it (`LLMOL_DIALOGUE_MODEL`), so switching models never requires touching code or the JSON configuration file.

```bash
# .env — any OpenRouter model id works, including ":free" variants
LLMOL_DIALOGUE_MODEL=nvidia/nemotron-3.5-super-vl:free
# optional: switch the provider preset entirely
# LLMOL_DIALOGUE_PRESET=openrouter
```

Other free OpenRouter models work the same way — set `LLMOL_DIALOGUE_MODEL` to any id from `https://openrouter.ai/models?max_price=0`, for example `deepseek/deepseek-r1:free`, `meta-llama/llama-3.3-70b-instruct:free`, or `qwen/qwen3-8b:free`. The JSON file can also carry `dialogue.remote.model` when no environment override is present; if neither sets it, the preset's built-in default applies. If a model rejects the `json_object` response format, the plugin retries once without it automatically.

To stop sending visitor speech off the machine, set `"plugins": {"dialogue": "dialogue.ollama"}` (or `"dialogue.scripted"`) in the config file and use one of the local providers below.

### Ollama (dialogue, optional local alternative)

Install Ollama from `https://ollama.com`, then:

```bash
ollama pull llama3.2
ollama serve        # if it is not already running as a service
```

The app calls the native Ollama API (`POST /api/chat`) on port 11434 with model `llama3.2` by default; change either via `dialogue.ollama.model` / `dialogue.ollama.baseUrl` or `OLLAMA_MODEL` / `OLLAMA_BASE_URL`.

### Kokoro-FastAPI (speech synthesis, default)

Quickest start is Docker:

```bash
docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest
```

With GPU: add `--gpus all` and use `ghcr.io/remsky/kokoro-fastapi-gpu:latest`. Alternatively run it natively with uv: clone `https://github.com/remsky/Kokoro-FastAPI` and run `start-cpu.ps1` (Windows) or `start-cpu.sh` (Linux/macOS). The API listens on `http://127.0.0.1:8880` (docs at `/docs`); the app posts to `/v1/audio/speech` with `response_format: "wav"`. The voice is `speechSynthesis.kokoro.voice` (default `bm_george`).

### Piper (speech synthesis, shipped default)

Piper is installed by `pnpm run setup` into `services/piper/` together with the `en_US-lessac-medium` voice, and it is the default engine; nothing else to do. To use a different voice, download its `.onnx` and `.onnx.json` files into `services/piper/voices/` and update `speechSynthesis.piper.voiceModelPath`. To use a system-wide Piper instead, point both paths in `speechSynthesis.piper` wherever you like (they may be absolute). Manual check: `echo "Boo" | .\services\piper\piper.exe --model .\services\piper\voices\en_US-lessac-medium.onnx --output_file test.wav --espeak_data .\services\piper\espeak-ng-data`. If the files are missing the booth still runs with subtitles, and the log names `pnpm run setup`.

### whisper.cpp (speech recognition)

`pnpm run setup` installs the latest whisper.cpp Windows binaries plus a model into `services/whisper/`, and `pnpm start` launches and supervises the server automatically (`speechRecognition.whisperCpp.autoStart`). The app posts multipart audio to `http://127.0.0.1:8082/inference`. If a whisper server is already running, the backend leaves it alone; if the files are missing, the booth runs without voice input and the log names `pnpm run setup`. Any OpenAI-compatible Whisper endpoint also works: set `speechRecognition.engine` to `"openai-compatible"` and point `speechRecognition.openaiCompatible.baseUrl` at it (optionally with a key via `apiKeyEnv`). To build whisper.cpp yourself instead, compile it from https://github.com/ggml-org/whisper.cpp and point `speechRecognition.whisperCpp.executablePath` / `modelPath` at your binaries.

## Configuration

The configuration file is `llm-o-lantern.config.json` (override the path with `LLMOL_CONFIG`). Precedence, lowest to highest: built-in defaults, JSON file, `.env`, real environment variables. Copy `.env.example` to `.env` to override service URLs and set API keys. Invalid values fail startup with one error listing every problem and its exact path.

Frequently changed settings:

| Setting | Default | Purpose |
| --- | --- | --- |
| `server.host` / `server.port` | `127.0.0.1` / `8787` | API bind address |
| `plugins.*` | see file | Plugin selection per category |
| `dialogue.opencodeGo.model` | `deepseek-v4.1-flash` | OpenCode Go model |
| `dialogue.opencodeGo.reasoningEffort` | `low` | Sent as `reasoning_effort`; keeps first-token latency low |
| `dialogue.opencodeGo.apiKeyEnv` / `authFilePath` / `databasePath` | `OPENCODE_API_KEY` / `~/.local/share/opencode/auth.json` / `~/.local/share/opencode/opencode.db` | Where the credentials come from (env key, then CLI login, then auth file) |
| `dialogue.remote.preset` | `openrouter` in the shipped file | Provider preset; overridable with `LLMOL_DIALOGUE_PRESET` |
| `dialogue.remote.model` | `null` (preset default) | Model id; set `LLMOL_DIALOGUE_MODEL` in `.env` to choose freely |
| `dialogue.remote.acknowledgeRemoteProcessing` | `true` in the shipped file | Required consent for cloud dialogue |
| `dialogue.ollama.model` | `llama3.2` | Local model when `dialogue.ollama` is selected |
| `dialogue.scripted.fallbackEnabled` | `true` | Scripted replies when the provider fails |
| `personality.characterName` | `Gourdrick` | Name shown in the UI |
| `personality.secretPhraseDiscovery` | `true` | Enable secret-phrase responses |
| `speechSynthesis.engine` | `piper` in the shipped file (code default `kokoro`) | `piper`, `kokoro`, or `openai-compatible` |
| `speechSynthesis.piper.*` | `services/piper/...` | Piper executable and voice (see `pnpm run setup`) |
| `speechSynthesis.speedAdjustments` | per delivery | Speed multipliers (normal/fast/slow/dramatic/whisper) |
| `speechRecognition.engine` | `whisper-cpp` | `whisper-cpp` or `openai-compatible` |
| `speechRecognition.whisperCpp.autoStart` | `true` | Let the backend launch whisper.cpp |
| `speechRecognition.language` | `null` (auto) | Force a transcription language |
| `lipSync.coarticulationMs` / `lipSync.minimumHoldMs` | `60` / `40` | Mouth smoothing / keyframe collapsing |
| `conversation.maxHistoryMessages` | `16` | Bounded per-session history |
| `conversation.maxResponseCharacters` | `280` | Reply length clamp |
| `conversation.sessionIdleExpiryMs` | `1800000` | Idle session purge (30 min) |
| `booth.autoListen` | `true` | Continuous listening vs push-to-talk only |
| `booth.voiceActivity.*` | thresholds | Mic gate tuning for the venue |
| `characterModel.*` | orange/gold palette | Pumpkin and glow colors |
| `logging.level` | `info` | `debug`, `info`, `warn`, `error` |

Environment variables (always win over the JSON file): `LLMOL_HOST`, `LLMOL_PORT`, `LLMOL_CONFIG`, `LLMOL_LOG_LEVEL`, `LLMOL_DIALOGUE_MODEL`, `LLMOL_DIALOGUE_PRESET`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `OLLAMA_KEEP_ALIVE`, `LLMOL_STT_BASE_URL`, `LLMOL_TTS_BASE_URL`.

### Remote dialogue providers

OpenRouter is the configured failover provider (see above) and can also be selected directly as primary. To switch the remote provider, change the preset and provide the matching key in the backend environment:

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

Remote processing always requires `acknowledgeRemoteProcessing: true` in the configuration; selecting a remote provider without it fails startup with a message naming the requirement, and the startup log warns that visitor speech will leave the machine while a remote provider is active. A missing API key does not stop the booth: the provider is marked unavailable (health and diagnostics show it) and replies use the scripted fallback until the key is set.

| Preset | Provider | Default base URL | Default model | API key env |
| --- | --- | --- | --- | --- |
| `openai` | OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | `OPENAI_API_KEY` |
| `anthropic` | Anthropic | `https://api.anthropic.com/v1` | `claude-sonnet-4-5` | `ANTHROPIC_API_KEY` |
| `deepseek` | DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | `DEEPSEEK_API_KEY` |
| `openrouter` | OpenRouter | `https://openrouter.ai/api/v1` | `nvidia/nemotron-3.5-super-vl:free` | `OPENROUTER_API_KEY` |
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

OpenRouter-specific provider errors are surfaced with their HTTP status and body message (401 invalid key, 402 insufficient credits, 429 rate limited, 502 upstream failure); any failed turn falls back to the scripted dialogue when `dialogue.scripted.fallbackEnabled` is true.

### Rate limits, cooldowns, and failover chains

OpenRouter's free tier allows **50 free-model requests per day per account, shared across every `:free` model** — switching between free models does not reset it. A one-time $10 credit purchase raises the cap to 1000/day. The booth is built to survive the cap either way:

- A quota or rate-limit error puts the primary provider into **cooldown** (until the next UTC midnight for daily caps, otherwise `dialogue.failover.rateLimitCooldownMs`). While cooling down it is skipped instantly, so no requests are wasted and the logs stay quiet.
- `dialogue.failover.chain` lists dialogue plugin ids tried in order before the scripted line. Chain entries are loaded automatically; no `plugins.additional` edits needed.

To add a second provider (for example Groq's free tier) next to OpenRouter:

```jsonc
"dialogue": {
  "failover": {
    "chain": ["dialogue.remote.groq", "dialogue.ollama"],
    "instances": [{ "preset": "groq", "model": "llama-3.3-70b-versatile" }]
  }
}
```

```bash
# .env — the instance id is dialogue.remote.<preset>
GROQ_API_KEY=gsk_...
```

Any preset from the table above works as an instance. `dialogue.ollama` is always available as a chain entry once Ollama runs on the booth machine. When the chain is empty and the primary is cooling down, the scripted fallback keeps the character in character until the quota resets.

## Operator guide

- Start overlay: one click unlocks browser audio and the microphone. In auto-listen mode this is also the microphone permission moment.
- State badge: the live character state - IDLE, LISTENING, THINKING, PREPARING_SPEECH, SPEAKING, INTERRUPTED, RECOVERING.
- Subtitles: both sides of the conversation, so the booth works even when the room is too loud to hear it; reply words fly in as the pumpkin says them, and while a visitor talks the transcript updates live. Replies stream sentence by sentence, so speech begins as soon as the first sentence is ready; if a provider goes fully silent, the scripted line answers within seconds instead of leaving dead air, while reasoning models are given up to twelve seconds of patience while they think.
- Error banner: service and backend problems, auto-hiding after 8 seconds; the last 10 errors stay listed in the diagnostics panel.

| Control       | Key        | Action                                             |
| ------------- | ---------- | -------------------------------------------------- |
| Listen toggle | `M`        | Turn auto-listening on/off                         |
| Hold to talk  | `T` (hold) | Capture while held, submit on release              |
| Reset visitor | `R`        | Stop everything, purge the session, return to IDLE |
| Diagnostics   | `D`        | Show/hide the diagnostics panel                    |

Diagnostics rows: Backend (health polling), Turn, Providers, Timing source (`energy-alignment`, `estimated`, `provider-phonemes`, or `provider-words`), Reply total, Sound to lips (turn submission to first audible audio in the browser), Dialogue / Synthesis / Timing / Lip sync per-stage latency, Audio length, and Fallback (scripted fallback or subtitle degradation used).

Reset between visitors: it clears the session memory server-side and stops any audio or animation immediately, with no restart.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Overlay says the backend is not reachable | API server not running | `pnpm run dev:server` (or `pnpm run dev`); check `http://127.0.0.1:8787/api/health` |
| Diagnostics Backend shows "offline" | Same as above | Start the API; the banner clears automatically |
| "Microphone permission was denied" | Browser permission refused | Allow the microphone for the page and reload |
| "Speech recognition is offline." | whisper.cpp is not running (auto-start disabled, files missing, or it failed to start) | Run `pnpm run setup`, check the startup log lines tagged `whisper:`, and `http://127.0.0.1:8787/api/health` |
| "Speech recognizer is unreachable at http://127.0.0.1:8082" | Same as above | Same fix; the whisper server starts with `pnpm start` unless `whisperCpp.autoStart` is false |
| Replies are scripted and Fallback shows "active" | Every provider failed or is cooling down (missing key, quota, subscription, or a local LLM is down) | Read the terminal warning naming the reason; for OpenCode Go check your workspace Privacy setting (Global) and `opencode auth login`; for OpenRouter free tiers see the quota notes above |
| OpenCode Go says "requires Global regions" | You set `OPENCODE_API_KEY` and that workspace's Privacy region is not Global | Remove the key from `.env` to use the auto-fetched CLI login, or set Workspace → Privacy → Global at https://opencode.ai |
| OpenCode Go says "Workspace selection is required" | The login token from `opencode.db` has no active workspace recorded | Run `opencode` once so it refreshes its state, then turn again |
| OpenCode Go says "An active OpenCode Go subscription is required" | That gateway model is not part of your seat | Use `deepseek-v4.1-flash` (the included model) or upgrade the subscription |
| Replies time out (`dialogue-timeout`) | Free model very slow or provider unreachable | Raise `dialogue.remote.timeoutMs`; check `/api/health`; for Ollama run `ollama serve` and `ollama pull llama3.2` |
| No audio, subtitles only | Piper files missing | Run `pnpm run setup` (installs `services/piper/`), or switch `speechSynthesis.engine` and run a Kokoro server instead |
| Port 8787 already in use at startup | Another llm-o-lantern instance is running | Stop it, or change `server.port`; the message names the port |
| Mouth motion looks approximate | Timing source is `energy-alignment` or `estimated` | Expected today (no TTS timing metadata); see PLAN.md open decisions |
| All providers down | No local services reachable | The scripted fallback keeps the character talking; set `plugins.dialogue` to `dialogue.scripted` for deliberate offline operation |
| Startup fails mentioning `acknowledgeRemoteProcessing` | `dialogue.remote` selected without consent flag | Set `dialogue.remote.acknowledgeRemoteProcessing` to `true` (this is the explicit consent that visitor speech leaves the machine) |
| Startup fails naming a configuration path | Invalid value in `llm-o-lantern.config.json` | Fix the named path; the error lists every problem at once |
| `pnpm start` says the web build is missing | `dist/` not built | `pnpm run build` |

## Privacy notes

- Microphone recordings are never persisted: audio lives in an in-memory ring buffer, is sent once to the local transcription endpoint, and is discarded.
- Conversation memory is per-session and bounded (16 messages / 8000 characters), cleared by Reset, purged after 30 minutes idle. No cross-visitor history.
- Remote dialogue (the shipped OpenRouter default included) requires the explicit `acknowledgeRemoteProcessing` consent in configuration plus a backend-environment API key. Keys never reach the browser, and the logger redacts credential-shaped fields from every entry. With no key or an unavailable provider, replies fall back to the scripted dialogue and no visitor speech is sent anywhere.
- The public configuration endpoint exposes plugin ids, booth settings, and colors only - never dialogue provider settings or secrets.

## Development

- Tests: `pnpm test` (Vitest, Node environment). Coverage spans the plugin lifecycle, configuration, logger redaction, dialogue wire formats, timing and alignment, viseme mapping, facial track interpolation, the state machine, the conversation coordinator, VAD, memory bounds, response processing, server routes over real HTTP, and the full turn pipeline with fake plugins.
- Live-service smoke tests are opt-in: `INTEGRATION=1 npx vitest run tests/integration` (PowerShell: `$env:INTEGRATION="1"; npx vitest run tests/integration`). They check that Ollama answers on `/api/tags`, that Kokoro returns RIFF WAV from `/v1/audio/speech`, and that the whisper server is reachable.
- Standard loop: `pnpm run typecheck`, then `pnpm test`, then `pnpm run build`.

## License

No license has been chosen for this project. The repository is private and unlicensed; all rights are reserved by its authors. It may not be copied, distributed, or reused without explicit permission. Add a LICENSE file and update this section before any public release.
