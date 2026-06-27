# TriggerGuard AI

A Chrome Extension (Manifest V3) that detects and blurs potentially triggering content on any webpage, with an AI-powered summary option.

---

## Loading the Extension in Chrome

1. Open **Chrome** and navigate to `chrome://extensions`
2. Enable **Developer mode** using the toggle in the top-right corner
3. Click **Load unpacked**
4. Select the `triggerguard/` folder
5. The extension icon (🛡️) will appear in your toolbar

To reload after editing files, click the **↺ refresh** icon on the extension card in `chrome://extensions`.

---

## Adding API Keys

API calls are made inside **`background.js`**. Locate the two stub functions and replace them with real `fetch()` calls:

### Moderation (OpenAI)

```js
// background.js — replace callModerationAPI()
async function callModerationAPI(text) {
  const res = await fetch('https://api.openai.com/v1/moderations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer YOUR_OPENAI_KEY_HERE',
    },
    body: JSON.stringify({ input: text }),
  });
  const data = await res.json();
  const result = data.results[0];
  const topCategory = Object.entries(result.category_scores)
    .sort(([, a], [, b]) => b - a)[0];
  return {
    flagged:  result.flagged,
    category: topCategory[0],
    score:    topCategory[1],
  };
}
```

### Summarization (Anthropic)

```js
// background.js — replace summarize()
async function summarize(text) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': 'YOUR_ANTHROPIC_KEY_HERE',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-3-haiku-20240307',
      max_tokens: 256,
      messages: [{ role: 'user', content: `Summarize this content neutrally in 2-3 sentences:\n\n${text}` }],
    }),
  });
  const data = await res.json();
  return data.content[0].text;
}
```

> **Security note:** Do not hard-code API keys in files you commit to version control. Consider reading them from `chrome.storage.local` set via an options page, or using a backend proxy.

---

## File Reference

```
triggerguard/
├── manifest.json          Extension configuration (MV3): permissions, content scripts, popup
├── background.js          Service worker — handles MODERATE_BATCH, SUMMARIZE, GET_SETTINGS messages
│                          ↳ Wire your API keys here
├── content.js             Injected into every page — scans text, blurs elements, shows modals
├── styles/
│   └── overlay.css        All UI styles for blurred elements, warning labels, and modals
└── popup/
    ├── popup.html         Extension popup — master toggle, sensitivity slider, category toggles
    └── popup.js           Popup logic — reads/writes chrome.storage.sync, triggers page scan
```

### Message types

| Type | Direction | Description |
|---|---|---|
| `GET_SETTINGS` | popup/content → background | Returns current settings from `chrome.storage.sync` |
| `MODERATE_BATCH` | content → background | Sends `[{ id, text }]`, returns `[{ id, flagged, category, score }]` |
| `SUMMARIZE` | content → background | Sends `text`, returns `{ summary }` |
| `FORCE_SCAN` | popup → content | Triggers an immediate re-scan of the current page |
| `GET_COUNT` | popup → content | Returns `{ count }` of currently blurred elements |

---

## How It Works

1. `content.js` runs on every page and scans text blocks using site-aware CSS selectors (Reddit, Twitter/X, and generic news layouts)
2. Text blocks are batched and sent to `background.js` for moderation
3. Flagged elements are blurred with a warning label showing the category and confidence score
4. Clicking a blurred element opens a modal with two options:
   - **Reveal Content** — smoothly unblurs and restores the original HTML
   - **Get AI Summary** — requests a neutral summary from the AI without revealing the content
5. All behaviour is gated by the user's settings (master toggle, sensitivity threshold, per-category toggles) stored in `chrome.storage.sync`
6. A `MutationObserver` with a 1-second debounce re-scans when new content is added (SPAs like Reddit and Twitter/X)

---

## Video / Reels (Instagram, X)

- **content-video.js** runs on Instagram and X: it finds video containers, captures a frame (or uses tab capture when needed), and sends it for analysis.
- **Gemini** (with `GEMINI_API_KEY` in `config.js`) is used to analyze the frame and optional post/caption text. If the image or text matches your **Blur in Videos & Images** or **Custom Trigger Words**, the video is blurred and the modal shows **Trigger words / Why blurred** and **AI Summary**.
- **Optional: Twelve Labs** — For full-video context analysis when a **public video URL** is available, you can run the `twelvelabs-server/` backend. See `twelvelabs-server/README.md`. Set `TWELVE_LABS_BACKEND_URL` in `config.js` (e.g. `http://localhost:4001`). The extension will then try Twelve Labs first when the page exposes an `http(s)` video URL; on success you get trigger words and AI summary from the full video. If the URL is not public (e.g. blob) or the backend is not set, the extension falls back to Gemini (frame + text).

---

## Privacy Disclaimer

- Text content from the current page is sent to third-party APIs (OpenAI, Anthropic) for analysis
- No page text, URLs, or personal data are stored by this extension
- Settings (toggle state, sensitivity, category preferences) are stored locally via `chrome.storage.sync`
- You are responsible for the data handling terms of any API keys you configure
