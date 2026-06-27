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
  const isInstagram = false;

  let selector = 'body';
  if (host.includes('reddit.com')) selector = SITE_SELECTORS.reddit;

  // For standard news websites, we just grab the body wrapper
  const blocks = Array.from(document.querySelectorAll(selector))
    .filter(el =>
      !el.classList.contains('tg-blurred') &&
      !el.hasAttribute(REVEALED_ATTR) &&
      !el.closest('.tg-blurred, .tg-video-wrapper, .tg-blur-wrap') &&
      !el.querySelector('.tg-blurred, .tg-video-wrapper') &&
      !isInsideBlockedTag(el) &&
      !INTERACTIVE_TAGS.has(el.tagName) &&
      el.innerText?.trim().length > 30
    )
    .map(el => ({ element: el, text: el.innerText.trim().slice(0, 3000) })) // Cap length to avoid massive API payloads
    // Prevent nested duplicate blurs
    .filter((block, idx, arr) =>
      !arr.some((other, jdx) => jdx !== idx && other.element.contains(block.element))
    );

  // For body blur, there's usually only 1-2 blocks anyway
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
