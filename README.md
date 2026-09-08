# Neattttty — offline-first desktop whiteboard

A local-first whiteboard app for Windows: a full hand-drawn editor, unlimited
scenes stored on your machine, frame-based slides with presenter notes, and AI
diagram generation that works fully offline (Ollama) or with your own cloud key
(OpenAI, OpenRouter, Anthropic, Gemini, OpenCode Zen, or any OpenAI-compatible
endpoint).

> Built with the MIT-licensed [`@excalidraw/excalidraw`](https://github.com/excalidraw/excalidraw)
> editor package. **Not affiliated with Excalidraw or Excalidraw+.**
> No Excalidraw+ code, templates, styles, or assets are included — the dashboard,
> slides, trash, themes, and AI features are original re-implementations.
> See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Features

- **Full editor** — infinite canvas, shapes, arrows with binding, freedraw with
  optional constant-width (no-pressure) brush, text in bundled handwriting
  fonts (Virgil, Nunito, Cascadia…), images, frames, laser pointer, dark/light
  canvas. All editor fonts ship inside the app, so it works with no internet.
- **Unlimited scenes** — every scene is yours, stored locally with autosave
  (`Ctrl+S`), searchable dashboard, collections, duplicate/rename, file
  import/export as portable `.excalidraw` JSON, and a 30-day trash with restore.
- **Slides** — any Frame becomes a slide: slide navigator, presenter notes,
  fullscreen presenting with keyboard control, PDF (print) and PPTX export.
- **AI generation** — describe a flow in the bottom bar; the model returns a
  plan that lands on the canvas as editable boxes and arrows. Providers:
  Ollama (offline default), LM Studio, OpenAI, OpenRouter, Anthropic, Gemini,
  **OpenCode Zen** (Chat Completions + Responses styles), or any custom
  OpenAI-compatible endpoint.
- **Catppuccin themes** — Latte / Frappé / Macchiato / Mocha with one shared
  green accent, tinted through the whole shell and the editor.
- **Privacy** — no account, no telemetry, no cloud. API keys (BYOK) live only
  in your machine's local storage and are sent straight to the provider you
  pick. In the desktop app, AI requests are relayed through the local backend
  so providers without CORS headers (e.g. Zen) work too.

## Run it

Prerequisites: [Node.js](https://nodejs.org) 20+ and [Rust](https://rustup.rs)
(for the desktop build only).

```sh
npm install
npm run dev        # web app at http://localhost:1420
```

Desktop app (native window, offline, ~40 MB):

```sh
npx tauri dev      # run with hot reload
npx tauri build    # installer bundle under src-tauri/target/
# ..or a portable exe with no installer:
cargo build --release  # -> src-tauri/target/release/Neattttty.exe
```

> `preview.html` is the original static UI mock — open it in a browser for a
> click-through of the layout. It is not the app.

## AI setup

- **Offline:** install [Ollama](https://ollama.ai), e.g. `ollama pull llama3.1:8b`,
  make sure `ollama serve` is running. Pick provider `Ollama` in the
  model pill → settings. Nothing leaves your machine.
- **OpenCode Zen:** create a key at opencode.ai (a Zen account with billing on
  file is required even for free models, otherwise the API rejects the key).
  Pick provider `OpenCode Zen`, paste the key, choose the model id
  (default `muse-spark-1.3-contributor-free`) and the API style that model
  needs — Chat Completions (Kimi/DeepSeek/free models) or Responses
  (GPT/Grok-type models). The app surfaces the server's own error message
  (e.g. bad key vs billing) instead of guessing.
- **Anything else:** provider `Custom OpenAI-compatible` + base URL + key +
  model works with LM Studio, Together, Groq, Cerebras, OpenRouter-style
  gateways — anything speaking the OpenAI protocol.

Keys are typed into the app UI and kept in local storage on your machine.
**Never commit keys**: there are no `.env` files in this repo and none are
needed — `.env*` is git-ignored as a safety net.

## Project layout

```
src/            React + Vite frontend (App shell, scenes store, AI, exporters)
  lib/          scenes.ts (local persistence) · ai.ts (providers) · exporters.ts
src-tauri/      Tauri desktop wrapper (Rust backend incl. CORS-free AI relay)
public/fonts/   Bundled editor + UI fonts (offline use, see notices)
preview.html    Static UI mock / design reference
```

## License

- Neattttty's own code: MIT — see [LICENSE](LICENSE).
- Third-party notices (Excalidraw MIT, fonts, icons): see
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
