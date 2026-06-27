# SafeView — Twelve Labs backend

Optional backend that uses [Twelve Labs](https://twelvelabs.io) to analyze **full-video** context. When the extension has a **public video URL** (e.g. from some embeds), it can call this server to get:

- **Trigger words** — which of your keywords appear in the video
- **AI summary** — short description of the video content
- **flagged** — whether to blur (video matches your keywords)

Inspired by [generate-social-posts](https://github.com/mrnkim/generate-social-posts).

## Requirements

- **GEMINI_API_KEY** — For **frame/image** analysis (Reels, X, any image). The extension sends frames to this server; the server calls Gemini with this key. Use a key with enough quota to avoid 429 (e.g. [Google AI Studio](https://aistudio.google.com/app/apikey)).
- **Twelve Labs** (optional) — For **full-video** analysis when a public video URL is available:
  - `TWELVE_LABS_API_KEY` — [Playground](https://playground.twelvelabs.io)
  - `TWELVE_LABS_INDEX_ID` — create an index in the dashboard

**Note:** Instagram Reels and many X videos use blob URLs, so the extension usually has no video URL. For those, the server uses **Gemini** (via `GEMINI_API_KEY`) to analyze the **frame** with `POST /analyze-image`. Twelve Labs is only used when the page exposes a public video URL.

## Setup

1. Copy `.env.example` to `.env` and set:
   - **`GEMINI_API_KEY`** — **Required** for image/frame analysis (avoids extension quota 429 by using the server’s key).
   - `TWELVE_LABS_API_KEY` and `TWELVE_LABS_INDEX_ID` — optional, for full-video when URL is available.
   - `PORT` — optional (default 4001)

2. Install and start:
   ```bash
   npm install
   npm start
   ```

3. In the extension `config.js`, set:
   ```js
   TWELVE_LABS_BACKEND_URL: 'http://localhost:4001'
   ```
   (Use your server URL if not local.)

## API

- **POST /analyze-image** *(used for Reels / X when no video URL)*  
  Body: `{ "image_base64": "<base64>", "mime_type": "image/jpeg", "keywords": ["word1", ...], "post_text": "optional caption" }`  
  Returns: `{ "flagged", "category", "score", "summary", "reasons" }`.  
  The server calls **Gemini** with its own `GEMINI_API_KEY`, so the extension avoids quota limits.

- **POST /analyze-video** *(when extension has a public video URL)*  
  Body: `{ "video_url": "https://...", "keywords": ["word1", "word2"] }`  
  Returns: `{ "flagged", "trigger_words", "summary" }`.  
  Uses Twelve Labs to index the video, then analyze. May take 1–2 minutes.

- **GET /health**  
  Returns `{ "ok": true, "twelve_labs": boolean, "gemini_image": boolean }`.

## Flow

1. Extension gets `video.currentSrc` or `video.src` from the page. If it’s `http`/`https`, it sends it with your keywords to this backend.
2. Backend creates a Twelve Labs indexing task with `video_url`, polls until ready, then calls the analyze API with a prompt that checks for your keywords and asks for trigger words + summary.
3. Extension receives `flagged`, `trigger_words`, and `summary`, blurs the video if `flagged`, and shows **Trigger words** and **AI summary** in the modal.

If the video URL is not public or the backend is not set, the extension falls back to **Gemini** (frame + post text) for immediate blur.
