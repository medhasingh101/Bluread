# Video & Image Detection — Architecture & Implementation

This document describes how to extend SafeView to **detect and blur sensitive content in videos and images**, with a focus on **Instagram Reels** and **videos on X (Twitter)**. It maps the reference project’s stack and solutions to a Chrome-extension-based design.

---

## 1. Goal

- **Text (current):** Keep existing behavior (local + OpenAI moderation, blur blocks).
- **Video / images (new):**  
  - Detect when a **Reel** or **X video** is visible and stable.  
  - Capture **one or more frames** (or full image for static images).  
  - Run **visual moderation** (sensitive content, violence, etc.).  
  - **Blur or overlay** the video/image container and show a SafeView badge; optional “Reveal” and “AI Summary” (e.g. Gemini describing the frame).

---

## 2. Technology Mapping: Reference Project → Chrome Extension

| Reference stack | Role in reference project | In SafeView (Chrome extension) |
|-----------------|---------------------------|----------------------------------|
| **Electron + React** | Desktop app UI | **Extension popup** (existing HTML/JS) + **content scripts** for overlay. |
| **DOM sensor extension** | Detects when TikTok posts are visible/stable, triggers screenshots | **Content script** on Instagram/X that finds Reels/tweet videos, observes visibility (IntersectionObserver), and triggers **frame capture** when in view and stable. |
| **Screenshots / frames** | Exact frame at right moment | **Canvas capture** in content script: draw `<video>` (or `<img>`) to canvas → `toDataURL('image/jpeg')` → send to background. No need for `captureVisibleTab` for in-page elements. |
| **Python + FastAPI** | Backend for ML (PyTorch, Transformers, etc.) | **Option A:** Keep extension-only and use **Gemini API** (multimodal) from background script for image/frame analysis. **Option B:** Run a **local FastAPI backend** (same as reference) and have extension send frames to `http://localhost:8000/analyze-image`. |
| **PyTorch + Transformers** | Text/vision models | **Option A:** Gemini. **Option B:** Your FastAPI backend with Organika/sdxl-detector, OpenCV, etc. |
| **WebSocket** | Real-time push | Optional: backend can push “analysis done” via WebSocket; extension can also use **chrome.runtime.sendMessage** and one-shot **fetch** to backend. |
| **Overlay positioning** | Badges over TikTok content | Same as current: **absolute/fixed overlay** in content script, positioned over the video container (Reel or tweet card) using `getBoundingClientRect()`. |
| **Click-through** | Don’t block clicks when not hovering | CSS `pointer-events: none` on overlay when not hovered; `pointer-events: auto` on badge/buttons. Optional for later. |
| **Multi-model / ensemble** | Reduce false positives/negatives | **Option A:** Single Gemini call with a clear prompt (e.g. “rate sensitivity 0–10, list categories”). **Option B:** Backend runs your multi-stage pipeline and returns a single score + labels. |
| **Gemini** | Frame-specific explanations | Use **Gemini multimodal** in background: send image base64 + prompt (“Summarize for a sensitive viewer” / “List concerns”). Shown in modal as “AI Summary” for that video/frame. |
| **Performance** | GPU, async, avoid blocking | Extension: **async** frame capture and **async** API call; don’t block main thread. Backend (if used): same as reference (GPU, async, model load once). |

---

## 3. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Instagram / X page                                                      │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  content.js (existing)          │  content-video.js (new)          │  │
│  │  – Text blocks, blur text       │  – Find <video> / Reel containers│  │
│  │  – Modal, Reveal, Summary       │  – IntersectionObserver (visible)│  │
│  │                                  │  – Capture frame → canvas →     │  │
│  │                                  │    base64                        │  │
│  │                                  │  – Overlay blur + badge on       │  │
│  │                                  │    container                     │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                    │
                    │ chrome.runtime.sendMessage({ type: 'ANALYZE_IMAGE', imageData })
                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  background.js (service worker)                                          │
│  – ANALYZE_IMAGE: receive base64 image                                   │
│  – If GEMINI_API_KEY: call Gemini multimodal (image + prompt)            │
│  – Else (optional): POST image to LOCAL_BACKEND_URL/analyze-image        │
│  – Return { flagged, category, score, summary? }                          │
└─────────────────────────────────────────────────────────────────────────┘
                    │
        Optional:   │  POST /analyze-image (image or base64)
        ┌───────────▼───────────┐
        │  Local FastAPI        │
        │  – PyTorch / OpenCV   │
        │  – Multi-model        │
        │  – Return score/labels│
        └───────────────────────┘
```

---

## 4. Challenges and Solutions (Aligned with Reference)

### 4.1 When to Capture (Real-Time Sync)

- **Problem:** Reels and X videos change as the user scrolls; we need the “right” moment and avoid duplicates.
- **Solution:**  
  - Use **IntersectionObserver** on the Reel/tweet **container** (not just `<video>`).  
  - When `intersectionRatio` crosses a threshold (e.g. &gt; 0.8) and stays for ~500–800 ms, consider the item “visible and stable.”  
  - **Frame deduplication:** Hash a downscaled frame (e.g. 32×32) and skip analysis if the same hash was seen recently (e.g. last 30 s) for that container.

### 4.2 Overlay Positioning and Click-Through

- **Problem:** Badge must sit over the video without breaking scrolling or clicks.
- **Solution:**  
  - Position overlay with **getBoundingClientRect()** and **position: fixed** (or absolute inside a positioned wrapper).  
  - Update on scroll/resize (or use a wrapper that moves with the container).  
  - Use **pointer-events: none** on the overlay div; **pointer-events: auto** only on the badge and “Reveal” / “AI Summary” buttons so the rest of the page remains clickable.

### 4.3 Multi-Model / Accuracy

- **Problem:** Single model may misclassify.
- **Solution:**  
  - **Extension-only:** One strong multimodal call (Gemini) with a structured prompt (e.g. “Score 0–10, list categories: violence, self-harm, …”).  
  - **With backend:** Replicate reference: aesthetic + visual + intent pipeline and return one combined score + categories; extension just displays result.

### 4.4 Educational / Frame-Specific Summary

- **Problem:** Users need a clear, specific explanation.
- **Solution:** Send the **same frame** (or a few) to **Gemini** with a prompt like: “In one or two sentences, describe what is shown in this image for a viewer who wants to avoid distressing content. Mention only high-level topic and any obvious concerns.” Show that in the existing “AI Summary” modal.

### 4.5 Performance

- **Problem:** Analysis should not freeze the tab.
- **Solution:**  
  - Capture and encode frames **asynchronously** (requestAnimationFrame or setTimeout).  
  - Send to background; background calls Gemini (or backend) **async** and responds via message.  
  - Limit concurrent analyses (e.g. max 2 in flight) and drop oldest if user scrolls fast.  
  - Optional: **downscale** frame (e.g. max 512px) before base64 to reduce payload and cost.

---

## 5. Implementation Outline

### 5.1 Config

- **config.js**  
  - `GEMINI_API_KEY` — for multimodal image analysis and summary (optional).  
  - Optional: `VIDEO_ANALYSIS_BACKEND_URL` (e.g. `http://localhost:8000`) for your FastAPI backend.

### 5.2 Manifest

- **content_scripts:** Add a second entry that runs only on `*://www.instagram.com/*` and `*://twitter.com/*`, `*://x.com/*`, with `js: ["content-video.js"]`.  
- No new permissions needed for canvas-based frame capture from in-page `<video>`/`<img>`; existing `host_permissions` and optional backend URL are enough.

### 5.3 Content Script (content-video.js)

- **Selectors:**  
  - Instagram: Reel container (e.g. `article` that contains `video`, or data attributes for Reels).  
  - X: Tweet with video: `article` containing `video`, or `[data-testid="videoPlayer"]` and its card.  
- **Flow:**  
  1. Query all candidate containers (Reels / tweet videos).  
  2. For each, attach **IntersectionObserver**; when “visible and stable,” take 1–3 frames (e.g. at 0%, 50%, 100% of current duration or at 0s, 2s, 4s).  
  3. Draw each frame to a **canvas** (respecting aspect ratio, max width e.g. 512), then `canvas.toDataURL('image/jpeg', 0.85)`.  
  4. Send **ANALYZE_IMAGE** with `imageData: base64` (and optional `source: 'instagram'|'x'`) to background.  
  5. On response: if `flagged`, wrap the container (or the video node) in a blur overlay div, add SafeView badge, store `data-tg-video-revealed` for “Reveal” state (same pattern as text).  
  6. **Deduplication:** Maintain a `Set` of “container id + frame hash” and skip re-analysis for a short window.

### 5.4 Background (background.js)

- **Message `ANALYZE_IMAGE`:**  
  - Input: `{ imageData: string (base64), source?: string }`.  
  - If `CONFIG.GEMINI_API_KEY`:  
    - Call Gemini **multimodal** API (e.g. `gemini-1.5-flash` or `gemini-1.5-pro`) with the image and a text prompt asking for a sensitivity score (0–10), categories, and a one-sentence summary.  
    - Parse response and return `{ flagged, category, score, summary }`.  
  - Else if `CONFIG.VIDEO_ANALYSIS_BACKEND_URL`:  
    - POST the image (or base64) to `{backend}/analyze-image`, then return the same shape.  
  - Else: return `{ flagged: false }` (no key/config).

### 5.5 Blur and Modal for Video

- Reuse existing **overlay CSS** for a “video container” wrapper: e.g. `.tg-video-blurred` with `filter: blur(12px)` and same SafeView label/modal.  
- Reuse the same **Reveal** and **AI Summary** modal; for “AI Summary” on video, show the **summary** returned from Gemini (frame-specific) instead of summarizing text.

### 5.6 Optional: Local Backend (FastAPI)

- Endpoint: `POST /analyze-image` (accept multipart file or JSON `{ "image_base64": "..." }`).  
- Run your pipeline (Organika/sdxl-detector, OpenCV, etc.); return e.g. `{ "flagged": true, "category": "Violence", "score": 72, "summary": "..." }`.  
- Extension uses `VIDEO_ANALYSIS_BACKEND_URL` only when set; otherwise falls back to Gemini or no analysis.

---

## 6. Instagram / X DOM Notes

- **Instagram Reels:**  
  - Reels are often inside `article` or divs with `role="presentation"` and contain a single `<video>`.  
  - Selectors may need to be updated as Instagram changes; use data attributes or stable classes when possible (e.g. `a[href*="/reel/"]` parent chain to find the Reel container).  

- **X (Twitter) videos:**  
  - Tweet card: `article[data-testid="tweet"]`; video inside: `video` or `[data-testid="videoPlayer"]`.  
  - Container to blur: the tweet `article` or the div that wraps the video.

---

## 7. Implementation Checklist (Done in This Repo)

- **config.js:** Add `GEMINI_API_KEY` (and optionally `VIDEO_ANALYSIS_BACKEND_URL`). See `config.example.js`.
- **manifest.json:** Second content script with `content-video.js` on `instagram.com`, `twitter.com`, `x.com`.
- **content-video.js:** Finds `<video>` and containers, IntersectionObserver, one-frame capture → base64, dedup, `ANALYZE_IMAGE` → blur overlay + label + modal (Reveal, AI Summary).
- **background.js:** `ANALYZE_IMAGE` → Gemini multimodal (or local backend) → `{ flagged, category, score, summary }`.
- **overlay.css:** `.tg-video-wrapper`, `.tg-video-blurred` for video overlay.

## 8. Cross-Origin Video (Tainted Canvas)

If the `<video>` src is from another origin (e.g. Instagram/X CDN), drawing it to a canvas **taints** the canvas and `toDataURL()` will throw. The extension now uses a **tab-capture fallback** when canvas fails (see content-video.js and background.js): canvas is tried first; if it returns null (tainted), the content script sends the video rect to the background, which calls **chrome.tabs.captureVisibleTab()** in the background script; content script sends the **bounding rect** of the video element and tab id; background captures the tab and crops to that rect, then runs Gemini/backend on the cropped image. (Requires careful coordinate handling and possibly host permission for activeTab.)
- **Implemented:** Background that receives full-page screenshots (e.g. from another extension or Electron) and crops to video regions; extension only sends “analyze this tab at this rect” and backend returns result.
- **Option C:** Some platforms may serve video same-origin; then canvas capture works as implemented.

## 9. Summary

- **Text:** Unchanged; existing content script + moderation.  
- **Video/images:** New content script on Instagram/X, capture frames via canvas → base64, send to background → Gemini (or local FastAPI), then blur overlay + badge + Reveal + AI Summary (Gemini frame description).  
- This gives you a path that matches the reference project’s ideas (DOM sensor, overlay, multi-model/ensemble via backend, Gemini for explanations) while staying within a Chrome extension and optional local backend.
