
(function TextBlurring() {
  /* ─── Category badge colours ──────────────────────────────────────────────── */

  const CATEGORY_COLORS = {
    'Violence': '#ef4444',
    'Self-Harm': '#8b5cf6',
    'Sexual Content': '#f97316',
    'Hate Speech': '#374151',
    'Harassment': '#374151',
    'Custom': '#6366f1',
  };

  /* ─── Site-specific selectors ─────────────────────────────────────────────── */

  const SITE_SELECTORS = {
    reddit: 'div[data-testid="post-container"], .Comment, [data-testid="comment"]',
    twitter: '[data-testid="tweetText"]',
    instagram: 'article span, [role="main"] ul li span, [role="main"] div[role="button"] span',
    default: 'article h1, article h2, article h3, article p, .article-body h1, .article-body h2, .article-body h3, .article-body p, main h1, main h2, main h3, main p, [role="main"] h1, [role="main"] h2, [role="main"] h3, [role="main"] p',
  };

  const BLOCKED_ANCESTORS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'HEAD']);
  const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'LABEL', 'SVG']);
  const REVEALED_ATTR = 'data-tg-user-revealed';

  const RATE_LIMIT = 20;

  /* ─── 1. getTextBlocks ────────────────────────────────────────────────────── */

  /** Returns true if any ancestor of el is in BLOCKED_ANCESTORS. */
  function isInsideBlockedTag(el) {
    let node = el.parentElement;
    while (node) {
      if (BLOCKED_ANCESTORS.has(node.tagName)) return true;
      node = node.parentElement;
    }
    return false;
  }

  function getTextBlocks() {
    const host = window.location.hostname;
    const isX = false;
    const isInstagram = true;

    let selector = SITE_SELECTORS.default;
    if (host.includes('reddit.com')) selector = SITE_SELECTORS.reddit;
    if (isX) selector = SITE_SELECTORS.twitter;
    if (isInstagram) selector = SITE_SELECTORS.instagram;
    const minTextLength = isX ? 12 : (isInstagram ? 15 : 30);

    const blocks = Array.from(document.querySelectorAll(selector))
      .filter(el =>
        !el.classList.contains('tg-blurred') &&
        !el.hasAttribute(REVEALED_ATTR) &&
        !el.closest('.tg-blurred, .tg-video-wrapper, .tg-blur-wrap') &&
        !el.querySelector('.tg-blurred, .tg-video-wrapper') &&
        !isInsideBlockedTag(el) &&
        !INTERACTIVE_TAGS.has(el.tagName) &&
        !el.closest('button, a, [role="button"], nav, header, footer, form') &&
        el.innerText?.trim().length > minTextLength
      )
      .map(el => ({ element: el, text: el.innerText.trim() }))
      // Prevent nested duplicate blurs, common on X and news article markup.
      .filter((block, idx, arr) =>
        !arr.some((other, jdx) => jdx !== idx && other.element.contains(block.element))
      );

    // Prioritise elements nearer the top of the page and cap at RATE_LIMIT
    return blocks.slice(0, RATE_LIMIT);
  }

  /* ─── 2. sendForModeration ────────────────────────────────────────────────── */

  function sendForModeration(textBlocks) {
    const payload = textBlocks.map((block, index) => ({ id: index, text: block.text }));

    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: 'MODERATE_BATCH', payload }, response => {
          if (chrome.runtime.lastError || !Array.isArray(response)) {
            // Network / extension error — resolve with all-safe results, never reject
            resolve(payload.map(item => ({ id: item.id, flagged: false })));
          } else {
            resolve(response);
          }
        });
      } catch {
        // Catches synchronous throws (e.g. extension context invalidated)
        resolve(payload.map(item => ({ id: item.id, flagged: false })));
      }
    });
  }

  /* ─── 3. showModal ────────────────────────────────────────────────────────── */

  function showModal(element, category) {
    document.querySelector('.tg-modal')?.remove();

    const detectedWords = JSON.parse(element.dataset.tgDetected || '[]');
    const wordsHtml = detectedWords.length
      ? `<div class="tg-modal__detected">
         Flagged for: ${detectedWords.map(w => `<code class="tg-token">${w}</code>`).join(' ')}
       </div>`
      : '';

    const modal = document.createElement('div');
    modal.className = 'tg-modal';
    modal.innerHTML = `
    <div class="tg-modal__card">
      <div class="tg-modal__header">
        <p class="tg-modal__title">⚠️ ${category} content detected</p>
        <button class="tg-modal__close" aria-label="Close">✕</button>
      </div>
      <p class="tg-modal__body">
        This section was flagged as <strong>${category}</strong>.
      </p>
      ${wordsHtml}
      <div class="tg-summary-box tg-summary-box--loading">
        <span class="tg-summary-box__label">Summary</span>Loading summary…
      </div>
      <div class="tg-modal__actions">
        <button class="tg-btn-reveal">Reveal Content</button>
        <button class="tg-btn-summary">Refresh Summary</button>
      </div>
    </div>
  `;

    document.body.appendChild(modal);

    const closeBtn = modal.querySelector('.tg-modal__close');
    const revealBtn = modal.querySelector('.tg-btn-reveal');
    const summaryBtn = modal.querySelector('.tg-btn-summary');
    const summaryBox = modal.querySelector('.tg-summary-box');

    function closeModal() { modal.remove(); }

    // Backdrop click closes without revealing
    modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
    closeBtn.addEventListener('click', closeModal);

    revealBtn.addEventListener('click', () => {
      element.setAttribute(REVEALED_ATTR, '1');
      element.classList.add('tg-unblurring');
      element.addEventListener('transitionend', () => {
        const original = element.dataset.tgOriginal;
        if (original !== undefined) {
          element.innerHTML = original;
          delete element.dataset.tgOriginal;
          delete element.dataset.tgDetected;
        }
        element.classList.remove('tg-blurred', 'tg-unblurring');
        const labelSib = element.previousElementSibling;
        if (labelSib?.classList.contains('tg-label')) labelSib.remove();
        const wrap = element.parentElement;
        if (wrap?.classList?.contains('tg-blur-wrap')) {
          wrap.parentNode.insertBefore(element, wrap);
          wrap.remove();
        }
      }, { once: true });
      closeModal();
    });

    // Shared summary loader — called automatically on open and by "Refresh Summary"
    function loadSummary() {
      summaryBox.classList.add('tg-summary-box--loading');
      summaryBox.innerHTML = '<span class="tg-summary-box__label">Summary</span>Loading summary…';
      summaryBtn.disabled = true;

      function onSummaryResponse(response) {
        summaryBox.classList.remove('tg-summary-box--loading');
        const err = chrome.runtime.lastError;
        if (err || !response?.summary) {
          const hint = err?.message?.includes('Extension context') ? ' — try refreshing the page.' : '.';
          summaryBox.innerHTML = `<span class="tg-summary-box__label">Summary</span>Could not load summary${hint}`;
        } else {
          summaryBox.innerHTML = `<span class="tg-summary-box__label">Summary</span>${response.summary}`;
        }
        summaryBtn.disabled = false;
      }

      try {
        chrome.runtime.sendMessage(
          {
            type: 'SUMMARIZE',
            text: element.dataset.tgText ?? element.innerText,
          },
          onSummaryResponse
        );
      } catch {
        onSummaryResponse(null);
      }
    }

    summaryBtn.addEventListener('click', loadSummary);
    loadSummary(); // auto-load as soon as the modal opens
  }

  /* ─── 4. blurElement ──────────────────────────────────────────────────────── */

  /** Accumulated list of everything flagged on this page, shown in the popup. */
  const detections = [];

  function blurElement(element, category, score, detectedWords = []) {
    element.removeAttribute(REVEALED_ATTR);

    element.dataset.tgOriginal = element.innerHTML;
    element.dataset.tgText = element.innerText?.trim() ?? '';
    element.dataset.tgDetected = JSON.stringify(detectedWords);

    element.classList.add('tg-blurred');
    detections.push({ category, score, words: detectedWords });

    const badgeColor = CATEGORY_COLORS[category] ?? '#78716c';
    const wordPreview = detectedWords.slice(0, 2).map(w => `"${w}"`).join(', ');
    const wordHint = wordPreview ? ` · ${wordPreview}` : '';

    const label = document.createElement('div');
    label.className = 'tg-label';
    label.innerHTML = `
    <span class="tg-label__badge" style="background:${badgeColor};"></span>
    <span class="tg-label__icon">⚠️</span>
    <span class="tg-label__category">${category}</span>
    <span class="tg-label__hint">${wordHint} (${score}%) — Click for details</span>
  `;

    const wrap = document.createElement('div');
    wrap.className = 'tg-blur-wrap';
    const parent = element.parentNode;
    parent.insertBefore(wrap, element);
    wrap.appendChild(label);
    wrap.appendChild(element);

    const openModal = () => showModal(element, category);
    label.addEventListener('click', openModal);
    element.addEventListener('click', openModal, { once: true });
  }

  /* ─── 5. getSettings ──────────────────────────────────────────────────────── */

  function getSettings() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, response => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(response);
        }
      });
    });
  }

  /* ─── 6. scan ─────────────────────────────────────────────────────────────── */

  async function scan() {
    try {
      let settings;
      try {
        settings = await getSettings();
      } catch {
        return; // Extension not ready yet — fail silently
      }

      if (!settings?.enabled) return;

      const blocks = getTextBlocks();
      if (!blocks.length) return;

      // sendForModeration never rejects — errors resolve as all-safe
      const results = await sendForModeration(blocks);

      if (!Array.isArray(results)) return;

      results.forEach(result => {
        if (result.flagged && blocks[result.id]) {
          blurElement(blocks[result.id].element, result.category, result.score, result.detectedWords || []);
        }
      });
    } catch {
      // Outer catch swallows any unexpected error — never surface to console
    }
  }

  /* ─── 7. Init + MutationObserver (debounced) ──────────────────────────────── */

  let debounceTimer = null;

  function debouncedScan() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(scan, 500);
  }

  // At document_idle the DOM is already ready — DOMContentLoaded has already fired,
  // so we must call scan() directly here instead of listening for the event.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scan);
  } else {
    scan();
  }

  /** Returns true if a node or any of its classes starts with "tg-". */
  function hasTgClass(node) {
    return node.nodeType === Node.ELEMENT_NODE &&
      Array.from(node.classList).some(c => c.startsWith('tg-'));
  }

  /** Returns true if every added node in the list was injected by TriggerGuard. */
  function isOwnMutation(addedNodes) {
    for (const node of addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      // Accept this node as "ours" if it has a tg- class or contains any tg- element
      if (hasTgClass(node) || node.querySelector?.('[class*="tg-"]')) return true;
    }
    return false;
  }

  const observer = new MutationObserver(mutations => {
    const hasExternalNewNodes = mutations.some(
      m => m.addedNodes.length > 0 && !isOwnMutation(m.addedNodes)
    );
    if (hasExternalNewNodes) debouncedScan();
  });

  observer.observe(document.body, { childList: true, subtree: true });

  /* ─── 8. Message listener ─────────────────────────────────────────────────── */

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.type) {
      case 'FORCE_SCAN':
        scan().then(() => sendResponse({ ok: true }));
        return true; // async response

      case 'GET_COUNT':
        sendResponse({ count: document.querySelectorAll('.tg-blurred').length });
        return false;

      case 'GET_DETECTIONS':
        sendResponse({ detections });
        return false;
    }
  });

})();

(function VideoBlurring() {
  /**
   * SafeView — Video & image detection for Instagram Reels and X (Twitter) videos.
   * Captures frames from visible videos, sends to background for analysis, blurs if flagged.
   * See docs/VIDEO_IMAGE_DETECTION.md for architecture.
   */

  (function () {
    const CATEGORY_COLORS = {
      'Violence': '#ef4444',
      'Self-Harm': '#8b5cf6',
      'Sexual Content': '#f97316',
      'Hate Speech': '#374151',
      'Harassment': '#ec4899',
      'Custom': '#6366f1',
      'Graphic': '#dc2626',
    };

    const host = window.location.hostname;
    const isInstagram = host.includes('instagram.com');
    const isX = host.includes('twitter.com') || host.includes('x.com');
    if (!isInstagram && !isX) return;

    const MAX_FRAME_SIZE = 512;
    const JPEG_QUALITY = 0.82;
    const STABLE_MS = isInstagram ? 400 : 600;
    const INTERSECTION_RATIO = isInstagram ? 0.4 : 0.6;
    const REVEALED_ATTR = 'data-tg-video-revealed';
    const ANALYZED_ATTR = 'data-tg-video-analyzed';
    const FRAME_HASH_SET = new Set();
    const FRAME_HASH_TTL = 45000;
    const pendingCapture = new Map();
    const pendingContainers = new Set();
    let captureRequestId = 0;

    /* ─── Selectors for image-only containers (tweets/posts with photo, no video) ─── */
    function getImageContainers() {
      if (!isX && !isInstagram) return [];
      const out = [];
      const minSize = 80;
      const selector = isX
        ? 'article[data-testid="tweet"] img'
        : 'article img, main img';
      const imgs = document.querySelectorAll(selector);
      const seen = new Set();
      imgs.forEach((img) => {
        if (!img.complete || !img.naturalWidth || !img.naturalHeight) return;
        if (img.naturalWidth < minSize || img.naturalHeight < minSize) return;

        // Tight container to prevent sweeping blur over the entire post text
        let container = isX
          ? img.closest('[data-testid="tweetPhoto"]') || img.parentElement
          : img.closest('div[role="button"]') || img.closest('div[role="presentation"]') || img.parentElement;

        if (!container) return;
        if (container.querySelector('video')) return;
        if (container.closest('.tg-video-wrapper') || container.hasAttribute(REVEALED_ATTR) || container.hasAttribute(ANALYZED_ATTR)) return;
        if (pendingContainers.has(container) || seen.has(container)) return;
        seen.add(container);
        out.push({ img, container });
      });
      return out;
    }

    /* ─── Selectors for video containers ───────────────────────────────────── */
    function getVideoContainers() {
      const videos = document.querySelectorAll('video');
      const out = [];
      const seenVideo = new Set();
      videos.forEach((video) => {
        if (seenVideo.has(video)) return;
        if (!isInstagram && video.readyState < 1 && video.videoWidth === 0 && video.videoHeight === 0) return;
        let container;
        if (isInstagram) {
          container = video.closest('article') ||
            video.closest('div[data-pressable-container="true"]') ||
            video.closest('div[role="presentation"]') ||
            video.closest('div[role="button"]') ||
            video.closest('section') ||
            video.parentElement?.parentElement ||
            video.parentElement;
        } else {
          container = video.closest('article[data-testid="tweet"]') ||
            video.closest('[data-testid="videoPlayer"]') ||
            video.parentElement;
        }
        if (!container || container.closest('.tg-video-wrapper')) return;
        if (container.hasAttribute(REVEALED_ATTR) || container.hasAttribute(ANALYZED_ATTR)) return;
        if (pendingContainers.has(container)) return;
        seenVideo.add(video);
        out.push({ video, container });
      });
      return out;
    }

    /* ─── Capture image from img element to base64 (same-origin only; cross-origin returns null) ─── */
    function captureImageFromImg(img) {
      if (!img || !img.naturalWidth || !img.naturalHeight) return null;
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const scale = Math.min(1, MAX_FRAME_SIZE / Math.max(w, h));
      const cw = Math.round(w * scale);
      const ch = Math.round(h * scale);
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      try {
        ctx.drawImage(img, 0, 0, cw, ch);
        return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
      } catch (e) {
        return null;
      }
    }

    /* ─── Capture one frame from video to base64 ────────────────────────────── */
    function captureFrame(video) {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return null;
      const scale = Math.min(1, MAX_FRAME_SIZE / Math.max(w, h));
      const cw = Math.round(w * scale);
      const ch = Math.round(h * scale);
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      try {
        ctx.drawImage(video, 0, 0, cw, ch);
        return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
      } catch (e) {
        return null;
      }
    }

    /* ─── Simple hash for deduplication ────────────────────────────────────── */
    function simpleHash(str) {
      let h = 0;
      for (let i = 0; i < Math.min(str.length, 2000); i++) h = ((h << 5) - h) + str.charCodeAt(i) | 0;
      return h.toString(36);
    }

    function shouldSkipDup(dataUrl) {
      const hash = simpleHash(dataUrl);
      if (FRAME_HASH_SET.has(hash)) return true;
      FRAME_HASH_SET.add(hash);
      setTimeout(() => FRAME_HASH_SET.delete(hash), FRAME_HASH_TTL);
      return false;
    }

    /* ─── Get public video URL for Twelve Labs (must be http/https, not blob) ─── */
    function getVideoUrl(video) {
      if (!video || !video.src) return '';
      const url = (video.currentSrc || video.src || '').trim();
      if (url.startsWith('http://') || url.startsWith('https://')) return url;
      return '';
    }

    /* ─── Get post/caption text for context (X tweet text, Instagram caption) ─── */
    function getContextText(container) {
      if (!container || !container.isConnected) return '';
      if (isX) {
        // Find the parent tweet to get text as container points only to media now
        const tweet = container.closest('article[data-testid="tweet"]') || container;
        const tweetText = tweet.querySelector('[data-testid="tweetText"]');
        return tweetText ? (tweetText.textContent || '').trim().slice(0, 1000) : '';
      }
      if (isInstagram) {
        const article = container.closest('article') || document.querySelector('main');
        if (!article) return '';
        const spans = article.querySelectorAll('span');
        for (const s of spans) {
          const t = (s.textContent || '').trim();
          if (t.length > 20 && t.length < 500 && !s.querySelector('span')) return t.slice(0, 500);
        }
      }
      return '';
    }

    /* ─── Moderate tweet/post text only (X: blur by keywords in tweet text when no frame yet) ─── */
    function moderateText(text) {
      if (!text || text.length < 3) return Promise.resolve(null);
      return new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'MODERATE_BATCH', payload: [{ id: 0, text: text.slice(0, 2000) }] },
          (response) => {
            if (chrome.runtime.lastError || !Array.isArray(response) || !response.length) resolve(null);
            else resolve(response[0]);
          }
        );
      });
    }

    /* ─── Ask background to analyze (image + optional contextText + optional videoUrl for Twelve Labs) ─── */
    function analyzeImage(imageData, contextText, videoUrl) {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage(
          {
            type: 'ANALYZE_IMAGE',
            imageData,
            contextText: typeof contextText === 'string' ? contextText : '',
            videoUrl: typeof videoUrl === 'string' ? videoUrl : '',
          },
          (response) => {
            if (chrome.runtime.lastError) resolve({ flagged: false });
            else resolve(response || { flagged: false });
          }
        );
      });
    }

    /* ─── Blur overlay and badge ────────────────────────────────────────────── */
    function escapeHtml(s) {
      const div = document.createElement('div');
      div.textContent = s;
      return div.innerHTML;
    }

    function applyBlur(container, result) {
      if (!container || !container.isConnected || !container.parentNode) return;
      if (container.hasAttribute(REVEALED_ATTR)) return;
      if (container.closest('.tg-video-wrapper')) return;
      const safe = result && typeof result === 'object' ? result : {};
      container.setAttribute(ANALYZED_ATTR, '1');
      const category = safe.category || 'Sensitive content';
      const score = safe.score != null ? safe.score : 0;
      const color = CATEGORY_COLORS[category] || '#78716c';
      const summary = typeof safe.summary === 'string' ? safe.summary : '';
      const reasons = Array.isArray(safe.reasons) ? safe.reasons : [];
      const reasonHint = reasons.length ? reasons[0] : '';

      const wrapper = document.createElement('div');
      wrapper.className = 'tg-video-wrapper';
      wrapper.style.cssText = 'position:relative;display:inline-block;width:100%;';
      container.parentNode.insertBefore(wrapper, container);
      wrapper.appendChild(container);

      const overlay = document.createElement('div');
      overlay.className = 'tg-video-blurred';
      overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
      wrapper.appendChild(overlay);

      const label = document.createElement('div');
      label.className = 'tg-label tg-label--video';
      label.style.cssText = 'position:absolute;top:10px;left:10px;z-index:10;pointer-events:auto;';
      label.innerHTML = `
      <span class="tg-label__badge" style="background:${color};"></span>
      <span class="tg-label__icon">⚠️</span>
      <span class="tg-label__category">${escapeHtml(category)}</span>
      <span class="tg-label__hint">${score}% — Click for options</span>
      ${reasonHint ? `<span class="tg-label__reason">${escapeHtml(reasonHint)}</span>` : ''}
    `;

      wrapper.appendChild(label);
      wrapper.dataset.tgSummary = summary;
      wrapper.dataset.tgCategory = category;
      wrapper.dataset.tgReasons = reasons.join('\n');

      const openModal = () => showVideoModal(wrapper, category, summary, reasons);
      label.addEventListener('click', openModal);
      overlay.addEventListener('click', openModal, { once: true });
    }

    /* ─── Modal for video: Reveal + reasons + AI Summary ────────────────────── */
    function showVideoModal(wrapper, category, summary, reasons) {
      let reasonList = Array.isArray(reasons) ? reasons : (wrapper.dataset.tgReasons || '').split('\n').filter(Boolean);
      if (!reasonList.length && category && category !== 'None') reasonList = ['Content matches your safety or keyword preferences.'];
      document.querySelector('.tg-modal')?.remove();
      const modal = document.createElement('div');
      modal.className = 'tg-modal';
      const reasonsHtml = reasonList.length
        ? `<div class="tg-reasons-box">
          <span class="tg-reasons-box__label">Trigger words / Why blurred</span>
          <ul class="tg-reasons-list">${reasonList.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
        </div>`
        : '';
      modal.innerHTML = `
      <div class="tg-modal__card">
        <div class="tg-modal__header">
          <p class="tg-modal__title">⚠️ ${escapeHtml(category)} (video/image)</p>
          <button class="tg-modal__close" aria-label="Close">✕</button>
        </div>
        <p class="tg-modal__body">This content was <strong>blocked</strong> and flagged as <strong>${escapeHtml(category)}</strong>.</p>
        ${reasonsHtml}
        <div class="tg-summary-box">
          <span class="tg-summary-box__label">AI Summary</span>
          ${summary ? escapeHtml(summary) : 'Summary not available.'}
        </div>
        <div class="tg-modal__actions">
          <button class="tg-btn-reveal">Reveal Content</button>
        </div>
      </div>
    `;
      document.body.appendChild(modal);

      modal.querySelector('.tg-modal__close').addEventListener('click', () => modal.remove());
      modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

      modal.querySelector('.tg-btn-reveal').addEventListener('click', () => {
        wrapper.setAttribute(REVEALED_ATTR, '1');
        wrapper.querySelector('.tg-video-blurred')?.remove();
        wrapper.querySelector('.tg-label')?.remove();
        modal.remove();
      });
    }

    /* ─── Crop viewport capture to rect (device pixels) ─────────────────────── */
    function cropCaptureToRect(fullCaptureDataUrl, rect) {
      const r = rect && typeof rect.x === 'number' && typeof rect.y === 'number' &&
        typeof rect.width === 'number' && typeof rect.height === 'number'
        ? rect : null;
      if (!r || r.width <= 0 || r.height <= 0) return Promise.resolve(null);

      return new Promise((resolve) => {
        try {
          const img = new Image();
          img.onload = () => {
            try {
              const dpr = window.devicePixelRatio || 1;
              const sx = Math.max(0, Math.min(img.width, Math.round(r.x * dpr)));
              const sy = Math.max(0, Math.min(img.height, Math.round(r.y * dpr)));
              const sw = Math.max(0, Math.min(img.width - sx, Math.round(r.width * dpr)));
              const sh = Math.max(0, Math.min(img.height - sy, Math.round(r.height * dpr)));
              if (sw <= 0 || sh <= 0) { resolve(null); return; }
              const scale = Math.min(1, MAX_FRAME_SIZE / Math.max(sw, sh));
              const cw = Math.round(sw * scale);
              const ch = Math.round(sh * scale);
              const canvas = document.createElement('canvas');
              canvas.width = cw;
              canvas.height = ch;
              const ctx = canvas.getContext('2d');
              if (!ctx) { resolve(null); return; }
              ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cw, ch);
              resolve(canvas.toDataURL('image/jpeg', JPEG_QUALITY));
            } catch (e) {
              resolve(null);
            }
          };
          img.onerror = () => resolve(null);
          img.src = fullCaptureDataUrl;
        } catch (e) {
          resolve(null);
        }
      });
    }

    /* ─── Process one visible video container ───────────────────────────────── */
    /* ─── Process one image container (tweet/post with photo) ────────────────── */
    async function processImageContainer({ img, container }) {
      if (!container || !img || !container.isConnected) return;
      const contextText = getContextText(container);
      if (isX && contextText) {
        const textResult = await moderateText(contextText);
        if (textResult && textResult.flagged) {
          if (!container.isConnected) return;
          applyBlur(container, {
            category: textResult.category || 'Custom',
            score: textResult.score != null ? textResult.score : 70,
            summary: 'Tweet text matches your blocked keywords.',
            reasons: Array.isArray(textResult.detectedWords) ? textResult.detectedWords : ['Text matches your list'],
          });
          return;
        }
      }
      let imageData = captureImageFromImg(img);
      if (imageData) {
        if (shouldSkipDup(imageData)) return;
        const result = await analyzeImage(imageData, contextText, '');
        if (!container.isConnected) return;
        if (result && result.flagged) applyBlur(container, result);
        else container.setAttribute(ANALYZED_ATTR, '1');
        return;
      }
      const r = img.getBoundingClientRect();
      if (r.width < 20 || r.height < 20) return;
      const requestId = 'i' + (++captureRequestId);
      pendingCapture.set(requestId, { container, video: null });
      pendingContainers.add(container);
      chrome.runtime.sendMessage({
        type: 'CAPTURE_AND_ANALYZE_VIDEO',
        rect: { x: r.left, y: r.top, width: r.width, height: r.height },
        requestId,
      }, (response) => {
        if (!response?.ok) {
          pendingCapture.delete(requestId);
          pendingContainers.delete(container);
          if (container && container.isConnected) container.setAttribute(ANALYZED_ATTR, '1');
        }
      });
    }

    async function processContainer({ video, container }) {
      if (!container || !video) return;

      if (video.readyState < 1 && video.videoWidth === 0) {
        await new Promise(r => {
          const t = setTimeout(r, isInstagram ? 800 : 1500);
          video.addEventListener('loadeddata', () => { clearTimeout(t); r(); }, { once: true });
        });
      }

      const contextText = getContextText(container);
      const videoUrl = getVideoUrl(video);

      // X / Instagram: if tweet or caption text matches keywords, blur immediately (no need to wait for frame)
      if ((isX || isInstagram) && contextText) {
        const textResult = await moderateText(contextText);
        if (textResult && textResult.flagged) {
          if (!container.isConnected) return;
          applyBlur(container, {
            category: textResult.category || 'Custom',
            score: textResult.score != null ? textResult.score : 70,
            summary: isInstagram ? 'Caption matches your blocked keywords.' : 'Tweet text matches your blocked keywords.',
            reasons: Array.isArray(textResult.detectedWords) ? textResult.detectedWords : ['Text matches your list'],
          });
          return;
        }
      }

      let imageData = captureFrame(video);
      if (imageData) {
        if (shouldSkipDup(imageData)) return;
        const result = await analyzeImage(imageData, contextText, videoUrl);
        if (!container.isConnected) return;
        if (result && result.flagged) applyBlur(container, result);
        else container.setAttribute(ANALYZED_ATTR, '1');
        return;
      }
      const r = video.getBoundingClientRect();
      if (r.width < 20 || r.height < 20) return;
      const requestId = 'v' + (++captureRequestId);
      pendingCapture.set(requestId, { container, video });
      pendingContainers.add(container);
      chrome.runtime.sendMessage({
        type: 'CAPTURE_AND_ANALYZE_VIDEO',
        rect: { x: r.left, y: r.top, width: r.width, height: r.height },
        requestId,
      }, (response) => {
        if (!response?.ok) {
          pendingCapture.delete(requestId);
          pendingContainers.delete(container);
          if (container && container.isConnected) container.setAttribute(ANALYZED_ATTR, '1');
        }
      });
    }

    function isExtensionEnabled() {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (s) => {
          if (chrome.runtime.lastError) resolve(false);
          else resolve(Boolean(s?.enabled));
        });
      });
    }

    /* ─── IntersectionObserver: when stable visible, analyze ─────────────────── */
    const pending = new Map();
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const container = entry.target;
          if (!container.isConnected) return;
          const video = container._tgVideo;
          const img = container._tgImage;
          if (!video && !img) return;
          if (entry.intersectionRatio < INTERSECTION_RATIO) {
            const t = pending.get(container);
            if (t) clearTimeout(t);
            pending.delete(container);
            return;
          }
          const t = setTimeout(async () => {
            pending.delete(container);
            const enabled = await isExtensionEnabled();
            if (!enabled) return;
            if (video) processContainer({ video, container });
            else if (img) processImageContainer({ img, container });
          }, STABLE_MS);
          pending.set(container, t);
        });
      },
      { threshold: [0, INTERSECTION_RATIO, 1], rootMargin: '50px' }
    );

    function observeContainers() {
      getVideoContainers().forEach(({ video, container }) => {
        container._tgVideo = video;
        container._tgImage = null;
        observer.observe(container);
      });
      getImageContainers().forEach(({ img, container }) => {
        if (container.hasAttribute(ANALYZED_ATTR) || container.hasAttribute(REVEALED_ATTR)) return;
        container._tgImage = img;
        if (!container._tgVideo) observer.observe(container);
      });
    }

    /* ─── Run on load and when DOM adds new videos ───────────────────────────── */
    function run() {
      observeContainers();
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', run);
    } else {
      run();
    }

    let observeDebounce = null;
    const observeDebounceMs = isInstagram ? 120 : 0;
    const mo = new MutationObserver(() => {
      if (observeDebounceMs) {
        if (observeDebounce) clearTimeout(observeDebounce);
        observeDebounce = setTimeout(() => {
          observeDebounce = null;
          observeContainers();
        }, observeDebounceMs);
      } else {
        observeContainers();
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type !== 'CAPTURE_RESULT') return;
      const { fullCapture, rect, requestId, error } = message;
      const pending = requestId ? pendingCapture.get(requestId) : null;
      if (pending) {
        pendingCapture.delete(requestId);
        pendingContainers.delete(pending.container);
      }
      const validRect = rect && typeof rect.x === 'number' && typeof rect.y === 'number' &&
        typeof rect.width === 'number' && typeof rect.height === 'number' && rect.width > 0 && rect.height > 0;
      if (error || !pending || !fullCapture || !validRect) {
        if (pending && pending.container.isConnected) pending.container.setAttribute(ANALYZED_ATTR, '1');
        return;
      }
      cropCaptureToRect(fullCapture, rect).then((croppedDataUrl) => {
        if (!pending.container.isConnected) return;
        if (!croppedDataUrl || shouldSkipDup(croppedDataUrl)) {
          pending.container.setAttribute(ANALYZED_ATTR, '1');
          return;
        }
        const contextText = getContextText(pending.container);
        const videoUrl = getVideoUrl(pending.video);
        analyzeImage(croppedDataUrl, contextText, videoUrl).then((result) => {
          if (!pending.container.isConnected) return;
          if (result && result.flagged) applyBlur(pending.container, result);
          else pending.container.setAttribute(ANALYZED_ATTR, '1');
        });
      });
    });
  })();

})();
