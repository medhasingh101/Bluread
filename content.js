(() => {
  const TEXT_INTERVAL_MS = 10_000;
  const DOOMSCROLL_WINDOW_MS = 120_000;
  const SCROLL_GAP_RESET_MS = 5_000;
  const WIDGET_EVAL_INTERVAL_MS = 5_000;
  const WIDGET_TOXICITY_THRESHOLD = 65;
  const WIDGET_SNOOZE_MS = 180_000;
  const INTERVENTION_SNOOZE_MS = 180_000;
  const SENTIMENT_DEFAULT_PREFS = {
    mode: 'balanced',
    blurNegative: true,
    blurPositive: false,
  };
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const NEGATIVE_KEYWORDS = [
    'angry',
    'awful',
    'bad',
    'depressing',
    'disaster',
    'fail',
    'hate',
    'horrible',
    'killed',
    'loss',
    'negative',
    'sad',
    'scandal',
    'toxic',
    'tragic',
    'violence',
    'war',
    'worst',
  ];
  const TOXIC_TERMS = [
    'idiot',
    'idiots',
    'moron',
    'morons',
    'stupid',
    'dumb',
    'kill yourself',
    'drop dead',
    'nobody likes you',
    'you are the worst',
  ];
  const POSITIVE_KEYWORDS = [
    'appreciate',
    'awesome',
    'beautiful',
    'calm',
    'celebrate',
    'excellent',
    'good',
    'grateful',
    'great',
    'happy',
    'helpful',
    'hope',
    'kind',
    'love',
    'peace',
    'positive',
    'relax',
    'support',
    'thank you',
    'wonderful',
  ];
  const CALMING_VIDEO_URL = 'https://www.youtube.com/watch?v=jfKfPfyJRdk';
  const TOXIC_REGEX_SOURCE = TOXIC_TERMS.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')).join('|');

  const sessionStartedAt = Date.now();
  const seenNegativeNodes = new WeakSet();
  let lastScrollY = window.scrollY;
  let lastScrollAt = Date.now();
  let currentScrollSpeed = 0;
  let continuousScrollStartAt = null;
  let negativePostsSeen = 0;
  let warningTriggered = false;
  let widgetSuppressedUntil = 0;
  let interventionSuppressedUntil = 0;
  let latestNegativeSentiment = 0;
  let protectionEnabled = true;
  let protectionReady = false;
  let sentimentPreferences = { ...SENTIMENT_DEFAULT_PREFS };

  function isVisible(element) {
    if (!element || !(element instanceof Element)) {
      return false;
    }

    if (element.hidden || element.getAttribute('aria-hidden') === 'true') {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      Number(style.opacity) === 0
    ) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function normalizeText(value) {
    return value.replace(/\s+/g, ' ').trim();
  }

  function removeWarningSurfaces() {
    const widget = document.getElementById('doom-pet-widget');
    if (widget) {
      widget.style.display = 'none';
    }

    const panel = document.getElementById('doom-intervention-panel');
    if (panel) {
      panel.style.display = 'none';
    }

    const banner = document.getElementById('doomscroll-warning-banner');
    if (banner) {
      banner.remove();
    }
  }

  function clearProtectionEffects() {
    removeWarningSurfaces();
    document.documentElement.classList.remove('doom-calm-mode');

    for (const node of document.querySelectorAll('.doom-calm-toxic, .doom-positive-highlight, .doom-sentiment-negative, .doom-sentiment-positive')) {
      node.classList.remove('doom-calm-toxic', 'doom-positive-highlight', 'doom-sentiment-negative', 'doom-sentiment-positive');
    }

    for (const hiddenToken of document.querySelectorAll('.toxicity-hidden-text')) {
      hiddenToken.style.filter = 'none';
    }

    for (const block of document.querySelectorAll('[data-toxicity-hidden=\"true\"]')) {
      block.style.display = '';
      delete block.dataset.toxicityHidden;
    }

    for (const placeholder of document.querySelectorAll('.doom-hidden-placeholder')) {
      placeholder.remove();
    }
  }

  function setProtectionEnabled(enabled) {
    protectionEnabled = enabled !== false;
    protectionReady = true;
    if (!protectionEnabled) {
      clearProtectionEffects();
    }
  }

  function setSentimentPreferences(value) {
    const prefs = value && typeof value === 'object' ? value : {};
    sentimentPreferences = {
      ...SENTIMENT_DEFAULT_PREFS,
      ...prefs,
    };
  }

  function getSentimentThresholds() {
    const mode = sentimentPreferences.mode;
    if (mode === 'strict') {
      return { positive: 8, negative: 8 };
    }
    if (mode === 'lenient') {
      return { positive: 18, negative: 18 };
    }
    return { positive: 12, negative: 12 };
  }

  function containsNegativeContent(text) {
    const normalized = normalizeText(String(text || '')).toLowerCase();
    if (!normalized) {
      return false;
    }

    return NEGATIVE_KEYWORDS.some((keyword) => normalized.includes(keyword));
  }

  function ensureWidgetStyles() {
    if (document.getElementById('doom-pet-widget-styles')) {
      return;
    }

    const style = document.createElement('style');
    style.id = 'doom-pet-widget-styles';
    style.textContent = `
      #doom-pet-widget {
        position: fixed;
        right: 16px;
        bottom: 16px;
        width: 280px;
        padding: 12px;
        border-radius: 12px;
        background: #fff7ed;
        border: 1px solid #fdba74;
        box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
        z-index: 2147483647;
        font-family: Arial, sans-serif;
        color: #7c2d12;
        display: none;
      }
      #doom-intervention-panel {
        position: fixed;
        left: 16px;
        bottom: 16px;
        width: 320px;
        padding: 12px;
        border-radius: 12px;
        background: #fff1f2;
        border: 1px solid #fda4af;
        box-shadow: 0 10px 24px rgba(0, 0, 0, 0.2);
        z-index: 2147483647;
        font-family: Arial, sans-serif;
        color: #881337;
        display: none;
      }
      #doom-intervention-panel .title {
        font-size: 13px;
        font-weight: 700;
        margin-bottom: 8px;
      }
      #doom-intervention-panel .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      #doom-intervention-panel button {
        border: 0;
        border-radius: 8px;
        padding: 6px 8px;
        font-size: 12px;
        cursor: pointer;
      }
      #doom-intervention-panel .continue-reading-btn {
        background: #e5e7eb;
        color: #111827;
      }
      #doom-intervention-panel .hide-toxic-btn {
        background: #fca5a5;
        color: #7f1d1d;
      }
      #doom-intervention-panel .take-break-btn {
        background: #86efac;
        color: #14532d;
      }
      #doom-pet-widget .pet {
        display: inline-block;
        font-size: 20px;
        margin-bottom: 8px;
        animation: doomPetBounce 0.9s ease-in-out infinite alternate;
      }
      #doom-pet-widget .message {
        font-size: 13px;
        line-height: 1.35;
        margin-bottom: 10px;
      }
      #doom-pet-widget .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      #doom-pet-widget button {
        border: 0;
        border-radius: 8px;
        padding: 6px 8px;
        font-size: 12px;
        cursor: pointer;
      }
      #doom-pet-widget .continue-btn {
        background: #e5e7eb;
        color: #111827;
      }
      #doom-pet-widget .calm-btn {
        background: #86efac;
        color: #14532d;
      }
      #doom-pet-widget .hide-btn {
        background: #fca5a5;
        color: #7f1d1d;
      }
      #doom-pet-widget .calm-link {
        display: none;
        margin-top: 8px;
        padding: 8px;
        border-radius: 8px;
        background: #dcfce7;
        color: #14532d;
        font-size: 12px;
        line-height: 1.35;
      }
      #doom-pet-widget .calm-link a {
        color: #166534;
        font-weight: 700;
      }
      .doom-hidden-placeholder {
        padding: 8px 10px;
        margin: 6px 0;
        border-radius: 8px;
        background: #f3f4f6;
        color: #4b5563;
        font: 12px/1.3 Arial, sans-serif;
      }
      html.doom-calm-mode body {
        filter: saturate(0.7) contrast(0.95);
      }
      .doom-positive-highlight {
        outline: 2px solid #86efac;
        background: linear-gradient(90deg, rgba(236, 253, 245, 0.9), rgba(220, 252, 231, 0.9));
        border-radius: 8px;
      }
      .doom-calm-toxic {
        filter: blur(4px) !important;
      }
      .doom-sentiment-negative {
        filter: blur(2px);
        background: rgba(254, 226, 226, 0.75);
        border-radius: 6px;
      }
      .doom-sentiment-positive {
        filter: blur(2px);
        background: rgba(220, 252, 231, 0.75);
        border-radius: 6px;
      }
      @keyframes doomPetBounce {
        from { transform: translateY(0px); }
        to { transform: translateY(-5px); }
      }
    `;
    document.head.appendChild(style);
  }

  function ensureWidget() {
    let widget = document.getElementById('doom-pet-widget');
    if (widget) {
      return widget;
    }

    ensureWidgetStyles();
    widget = document.createElement('div');
    widget.id = 'doom-pet-widget';
    widget.innerHTML = `
      <div class="pet">(=^.^=)</div>
      <div class="message" id="doom-pet-message">Your feed looks rough right now.</div>
      <div class="actions">
        <button class="continue-btn" type="button">Continue scrolling</button>
        <button class="calm-btn" type="button">Switch to calm mode</button>
        <button class="hide-btn" type="button">Hide toxic content</button>
      </div>
      <div class="calm-link" id="calm-video-link"></div>
    `;

    const continueBtn = widget.querySelector('.continue-btn');
    const calmBtn = widget.querySelector('.calm-btn');
    const hideBtn = widget.querySelector('.hide-btn');

    continueBtn.addEventListener('click', () => {
      widgetSuppressedUntil = Date.now() + WIDGET_SNOOZE_MS;
      widget.style.display = 'none';
    });
    calmBtn.addEventListener('click', () => {
      activateCalmMode();
    });
    hideBtn.addEventListener('click', () => {
      hideToxicContent();
    });

    document.body.appendChild(widget);
    return widget;
  }

  function ensureInterventionPanel() {
    let panel = document.getElementById('doom-intervention-panel');
    if (panel) {
      return panel;
    }

    ensureWidgetStyles();
    panel = document.createElement('div');
    panel.id = 'doom-intervention-panel';
    panel.innerHTML = `
      <div class="title">High levels of hostile or harmful language detected.</div>
      <div class="actions">
        <button class="continue-reading-btn" type="button">Continue Reading</button>
        <button class="hide-toxic-btn" type="button">Hide Toxic Content</button>
        <button class="take-break-btn" type="button">Take a Break</button>
      </div>
    `;

    const continueBtn = panel.querySelector('.continue-reading-btn');
    const hideBtn = panel.querySelector('.hide-toxic-btn');
    const breakBtn = panel.querySelector('.take-break-btn');

    continueBtn.addEventListener('click', () => {
      interventionSuppressedUntil = Date.now() + INTERVENTION_SNOOZE_MS;
      panel.style.display = 'none';
    });
    hideBtn.addEventListener('click', () => {
      hideToxicContent();
      panel.style.display = 'none';
    });
    breakBtn.addEventListener('click', () => {
      window.open(CALMING_VIDEO_URL, '_blank', 'noopener,noreferrer');
      interventionSuppressedUntil = Date.now() + INTERVENTION_SNOOZE_MS;
      panel.style.display = 'none';
    });

    document.body.appendChild(panel);
    return panel;
  }

  function blurToxicPosts() {
    if (!protectionReady || !protectionEnabled) {
      return;
    }

    const toxicNodes = Array.from(document.querySelectorAll('[data-toxicity-score]')).filter((node) => {
      const score = Number(node.dataset.toxicityScore || 0);
      return Number.isFinite(score) && score >= 60;
    });

    for (const node of toxicNodes) {
      node.classList.add('doom-calm-toxic');
    }
  }

  function containsPositiveContent(text) {
    const normalized = normalizeText(String(text || '')).toLowerCase();
    if (!normalized) {
      return false;
    }

    return POSITIVE_KEYWORDS.some((keyword) => normalized.includes(keyword));
  }

  function getSentimentBreakdownForText(text) {
    const normalized = normalizeText(String(text || '')).toLowerCase();
    const words = normalized.match(/[a-z']+/g) || [];
    if (!words.length) {
      return { positive: 0, negative: 0, neutral: 100 };
    }

    let positiveCount = 0;
    let negativeCount = 0;
    for (const word of words) {
      if (POSITIVE_KEYWORDS.includes(word)) {
        positiveCount += 1;
      }
      if (NEGATIVE_KEYWORDS.includes(word)) {
        negativeCount += 1;
      }
    }

    const positive = Math.round((positiveCount / words.length) * 100);
    const negative = Math.round((negativeCount / words.length) * 100);
    const neutral = Math.max(0, 100 - positive - negative);
    return { positive, negative, neutral };
  }

  function applySentimentBlur(root = document) {
    if (!protectionReady || !protectionEnabled) {
      return;
    }

    const thresholds = getSentimentThresholds();
    const candidates = Array.from(root.querySelectorAll ? root.querySelectorAll('article, p, li, blockquote, div') : []);

    for (const node of candidates) {
      if (!(node instanceof Element) || !isVisible(node)) {
        continue;
      }

      const text = normalizeText(node.innerText || node.textContent || '');
      if (!text || text.length < 40 || text.length > 600) {
        continue;
      }

      const sentiment = getSentimentBreakdownForText(text);
      const isNegative = sentiment.negative >= thresholds.negative;
      const isPositive = sentiment.positive >= thresholds.positive;

      node.classList.remove('doom-sentiment-negative', 'doom-sentiment-positive');

      if (sentimentPreferences.blurNegative && isNegative) {
        node.classList.add('doom-sentiment-negative');
        continue;
      }

      if (sentimentPreferences.blurPositive && isPositive) {
        node.classList.add('doom-sentiment-positive');
      }
    }
  }

  function highlightPositiveContent() {
    const candidates = Array.from(document.querySelectorAll('article, p, li, blockquote, h1, h2, h3, h4'));
    let highlighted = 0;

    for (const node of candidates) {
      if (!(node instanceof Element) || !isVisible(node) || node.classList.contains('doom-positive-highlight')) {
        continue;
      }

      if (node.closest('.doom-positive-highlight')) {
        continue;
      }

      const text = normalizeText(node.innerText || node.textContent || '');
      if (!text || text.length > 400 || !containsPositiveContent(text)) {
        continue;
      }

      node.classList.add('doom-positive-highlight');
      highlighted += 1;
      if (highlighted >= 80) {
        break;
      }
    }
  }

  function suggestCalmingVideo() {
    const widget = ensureWidget();
    const calmVideo = widget.querySelector('#calm-video-link');
    if (!calmVideo) {
      return;
    }

    calmVideo.innerHTML = `Take a short reset break: <a href="${CALMING_VIDEO_URL}" target="_blank" rel="noopener noreferrer">Watch a calming video</a>`;
    calmVideo.style.display = 'block';
  }

  function activateCalmMode() {
    if (!protectionReady || !protectionEnabled) {
      return;
    }

    document.documentElement.classList.add('doom-calm-mode');
    blurToxicPosts();
    highlightPositiveContent();
    suggestCalmingVideo();
  }

  function hideToxicContent() {
    if (!protectionReady || !protectionEnabled) {
      return;
    }

    const toxicBlocks = Array.from(document.querySelectorAll('[data-toxicity-score]')).filter((node) => {
      const score = Number(node.dataset.toxicityScore || 0);
      return score >= 60 && node.dataset.toxicityHidden !== 'true';
    });

    for (const block of toxicBlocks) {
      const placeholder = document.createElement('div');
      placeholder.className = 'doom-hidden-placeholder';
      placeholder.textContent = 'Toxic content hidden.';
      block.parentNode?.insertBefore(placeholder, block);
      block.style.display = 'none';
      block.dataset.toxicityHidden = 'true';
    }
  }

  function getToxicitySnapshot() {
    if (!protectionReady || !protectionEnabled) {
      return {
        toxicPostsDetected: 0,
        scoredPostCount: 0,
        averageToxicity: 0,
        toxicPostFrequency: 0,
        feedToxicityScore: 0,
        feedHealthScore: 100,
      };
    }

    const scoredNodes = Array.from(document.querySelectorAll('[data-toxicity-score]'));
    const scores = scoredNodes
      .map((node) => Number(node.dataset.toxicityScore || 0))
      .filter((value) => Number.isFinite(value));

    const averageToxicity = scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : 0;
    const toxicPostsDetected = scores.filter((value) => value >= 60).length;
    const frequency = scores.length ? (toxicPostsDetected / scores.length) * 100 : 0;
    const negativity = Math.min(100, negativePostsSeen * 8);
    const feedToxicityScore = Math.round(averageToxicity * 0.5 + negativity * 0.2 + frequency * 0.3);

    return {
      toxicPostsDetected,
      scoredPostCount: scores.length,
      averageToxicity: Math.round(averageToxicity),
      toxicPostFrequency: Math.round(frequency),
      feedToxicityScore,
      feedHealthScore: Math.max(0, 100 - feedToxicityScore),
    };
  }

  function getNegativeSentimentPercentage() {
    if (!protectionReady || !protectionEnabled) {
      return 0;
    }

    const sampledText = collectVisibleText().join(' ').slice(0, 20_000).toLowerCase();
    const words = sampledText.match(/[a-z']+/g) || [];
    if (!words.length) {
      return 0;
    }

    let negativeCount = 0;
    for (const word of words) {
      if (NEGATIVE_KEYWORDS.includes(word)) {
        negativeCount += 1;
      }
    }

    return Math.round((negativeCount / words.length) * 100);
  }

  function getToxicWordSnapshot() {
    if (!protectionReady || !protectionEnabled) {
      return {
        toxicWordCount: 0,
        detectedWords: [],
      };
    }

    const nodes = Array.from(document.querySelectorAll('[data-toxic-word-count], [data-detected-toxic-words]'));
    const words = new Set();
    let toxicWordCount = 0;

    for (const node of nodes) {
      toxicWordCount += Number(node.dataset.toxicWordCount || 0);
      const raw = String(node.dataset.detectedToxicWords || '');
      if (!raw) {
        continue;
      }

      for (const word of raw.split(',')) {
        const clean = normalizeText(word).toLowerCase();
        if (clean) {
          words.add(clean);
        }
      }
    }

    return {
      toxicWordCount,
      detectedWords: [...words],
    };
  }

  function getFeedToxicityScore() {
    return getToxicitySnapshot().feedToxicityScore;
  }

  function evaluateFloatingWidget() {
    if (!protectionReady || !protectionEnabled) {
      removeWarningSurfaces();
      return;
    }

    const score = getFeedToxicityScore();
    const widget = ensureWidget();
    const message = widget.querySelector('#doom-pet-message');
    message.textContent = `Warning: high toxicity detected (score ${score}/100).`;

    if (document.documentElement.classList.contains('doom-calm-mode')) {
      blurToxicPosts();
      highlightPositiveContent();
    }

    applySentimentBlur(document);

    if (Date.now() < widgetSuppressedUntil) {
      widget.style.display = 'none';
      return;
    }

    widget.style.display = score >= WIDGET_TOXICITY_THRESHOLD ? 'block' : 'none';
  }

  function evaluateInterventionPanel() {
    if (!protectionReady || !protectionEnabled) {
      removeWarningSurfaces();
      return;
    }

    const snapshot = getToxicitySnapshot();
    const toxicityScore = snapshot.feedToxicityScore;
    const negativeSentiment = latestNegativeSentiment;
    const panel = ensureInterventionPanel();

    if (Date.now() < interventionSuppressedUntil) {
      panel.style.display = 'none';
      return;
    }

    const shouldShow = toxicityScore > 60 || negativeSentiment > 50;
    panel.style.display = shouldShow ? 'block' : 'none';
  }

  function getTimeSpentOnPageMs() {
    return Date.now() - sessionStartedAt;
  }

  function collectVisibleText() {
    const parts = [];
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = normalizeText(node.nodeValue || '');
        if (!text) {
          return NodeFilter.FILTER_REJECT;
        }

        const parent = node.parentElement;
        if (!parent || SKIP_TAGS.has(parent.tagName) || !isVisible(parent)) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let currentNode = walker.nextNode();
    while (currentNode) {
      parts.push(normalizeText(currentNode.nodeValue || ''));
      currentNode = walker.nextNode();
    }

    return parts;
  }

  function collectBySelector(selector) {
    return Array.from(document.querySelectorAll(selector))
      .filter(isVisible)
      .map((element) => normalizeText(element.innerText || element.textContent || ''))
      .filter(Boolean);
  }

  function collectComments() {
    const comments = [];
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_COMMENT);

    let currentNode = walker.nextNode();
    while (currentNode) {
      const parent = currentNode.parentElement;
      if (parent && !SKIP_TAGS.has(parent.tagName)) {
        const comment = normalizeText(currentNode.nodeValue || '');
        if (comment) {
          comments.push(comment);
        }
      }
      currentNode = walker.nextNode();
    }

    return comments;
  }

  function dedupe(values) {
    return [...new Set(values)];
  }

  function blurToxicTextNode(textNode) {
    if (!protectionReady || !protectionEnabled) {
      return false;
    }

    const text = textNode.nodeValue || '';
    if (!text.trim()) {
      return false;
    }

    const regex = new RegExp(`\\b(?:${TOXIC_REGEX_SOURCE})\\b`, 'gi');
    const fragment = document.createDocumentFragment();
    let hasMatch = false;
    let lastIndex = 0;
    let match = regex.exec(text);

    while (match) {
      hasMatch = true;
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }

      const hiddenToken = document.createElement('span');
      hiddenToken.className = 'toxicity-hidden-text';
      hiddenToken.textContent = '[content hidden]';
      hiddenToken.style.filter = 'blur(3px)';
      hiddenToken.style.whiteSpace = 'pre';
      hiddenToken.style.userSelect = 'none';
      fragment.appendChild(hiddenToken);

      lastIndex = match.index + match[0].length;
      match = regex.exec(text);
    }

    if (!hasMatch) {
      return false;
    }

    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    if (textNode.parentNode) {
      textNode.parentNode.replaceChild(fragment, textNode);
    }

    return true;
  }

  function scanPageForToxicText(root = document.body) {
    if (!protectionReady || !protectionEnabled) {
      return 0;
    }

    if (!root) {
      return 0;
    }

    const candidates = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const value = normalizeText(node.nodeValue || '');
        if (!value) {
          return NodeFilter.FILTER_REJECT;
        }

        const parent = node.parentElement;
        if (!parent || SKIP_TAGS.has(parent.tagName) || !isVisible(parent)) {
          return NodeFilter.FILTER_REJECT;
        }

        if (parent.closest('.toxicity-hidden-text') || value.includes('[content hidden]')) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let node = walker.nextNode();
    while (node) {
      candidates.push(node);
      node = walker.nextNode();
    }

    let replacedCount = 0;
    for (const textNode of candidates) {
      if (blurToxicTextNode(textNode)) {
        replacedCount += 1;
      }
    }

    return replacedCount;
  }

  function getCandidatePostElements() {
    return document.querySelectorAll('article, [role="article"], .post, .feed-item, li, section, div, p');
  }

  function countNewNegativePostsInViewport() {
    let newlySeenNegative = 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

    for (const element of getCandidatePostElements()) {
      if (!(element instanceof Element) || seenNegativeNodes.has(element) || !isVisible(element)) {
        continue;
      }

      const rect = element.getBoundingClientRect();
      const inViewport = rect.bottom > 0 && rect.top < viewportHeight;
      if (!inViewport) {
        continue;
      }

      const text = normalizeText(element.innerText || element.textContent || '');
      if (text && containsNegativeContent(text)) {
        seenNegativeNodes.add(element);
        newlySeenNegative += 1;
      }
    }

    return newlySeenNegative;
  }

  function showDoomscrollWarning() {
    if (!protectionReady || !protectionEnabled) {
      return;
    }

    if (document.getElementById('doomscroll-warning-banner')) {
      return;
    }

    const banner = document.createElement('div');
    banner.id = 'doomscroll-warning-banner';
    banner.textContent = 'Doomscroll warning: you have been continuously scrolling negative content for over 2 minutes.';
    banner.style.position = 'fixed';
    banner.style.left = '16px';
    banner.style.right = '16px';
    banner.style.bottom = '16px';
    banner.style.zIndex = '2147483647';
    banner.style.padding = '12px 14px';
    banner.style.borderRadius = '10px';
    banner.style.background = '#b91c1c';
    banner.style.color = '#ffffff';
    banner.style.font = '14px/1.4 Arial, sans-serif';
    banner.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.24)';
    document.body.appendChild(banner);

    window.setTimeout(() => {
      banner.remove();
    }, 10_000);
  }

  function triggerDoomscrollWarning() {
    if (!protectionReady || !protectionEnabled) {
      return;
    }

    warningTriggered = true;
    showDoomscrollWarning();
    evaluateFloatingWidget();
    chrome.runtime
      .sendMessage({
        type: 'DOOMSCROLL_WARNING',
        payload: {
          url: window.location.href,
          title: document.title,
          triggeredAt: new Date().toISOString(),
          scrollSpeed: Math.round(currentScrollSpeed),
          timeSpentOnPageMs: getTimeSpentOnPageMs(),
          negativePostsSeen,
        },
      })
      .catch(() => {
        // Ignore transient send failures.
      });
  }

  function onScroll() {
    if (!protectionReady || !protectionEnabled) {
      return;
    }

    const now = Date.now();
    const deltaY = Math.abs(window.scrollY - lastScrollY);
    const deltaT = Math.max(1, now - lastScrollAt);
    currentScrollSpeed = (deltaY / deltaT) * 1000;

    const gapSinceLastScroll = now - lastScrollAt;
    if (gapSinceLastScroll > SCROLL_GAP_RESET_MS) {
      continuousScrollStartAt = now;
    } else if (!continuousScrollStartAt) {
      continuousScrollStartAt = now;
    }

    lastScrollY = window.scrollY;
    lastScrollAt = now;

    negativePostsSeen += countNewNegativePostsInViewport();

    const continuousDuration = continuousScrollStartAt ? now - continuousScrollStartAt : 0;
    const isNegativeSession = negativePostsSeen > 0;
    if (!warningTriggered && isNegativeSession && continuousDuration >= DOOMSCROLL_WINDOW_MS) {
      triggerDoomscrollWarning();
    }
  }

  function buildPayload() {
    if (!protectionReady || !protectionEnabled) {
      return null;
    }

    const visibleText = collectVisibleText();
    const paragraphs = collectBySelector('p');
    const headings = collectBySelector('h1, h2, h3, h4, h5, h6');
    const comments = collectComments();
    const toxicitySnapshot = getToxicitySnapshot();
    const negativeSentiment = getNegativeSentimentPercentage();
    const toxicWordSnapshot = getToxicWordSnapshot();
    latestNegativeSentiment = negativeSentiment;

    return {
      type: 'PAGE_TEXT_UPDATE',
      payload: {
        url: window.location.href,
        title: document.title,
        capturedAt: new Date().toISOString(),
        scrollSpeed: Math.round(currentScrollSpeed),
        timeSpentOnPageMs: getTimeSpentOnPageMs(),
        negativePostsSeen,
        continuousScrollMs: continuousScrollStartAt ? Date.now() - continuousScrollStartAt : 0,
        toxicPostsDetected: toxicitySnapshot.toxicPostsDetected,
        scoredPostCount: toxicitySnapshot.scoredPostCount,
        averageToxicity: toxicitySnapshot.averageToxicity,
        toxicPostFrequency: toxicitySnapshot.toxicPostFrequency,
        feedToxicityScore: toxicitySnapshot.feedToxicityScore,
        feedHealthScore: toxicitySnapshot.feedHealthScore,
        negativeSentiment,
        toxicWordCount: toxicWordSnapshot.toxicWordCount,
        detectedWords: toxicWordSnapshot.detectedWords,
        visibleText: dedupe(visibleText),
        paragraphs: dedupe(paragraphs),
        headings: dedupe(headings),
        comments,
        collectedText: dedupe([...visibleText, ...paragraphs, ...headings, ...comments]).join('\n'),
      },
    };
  }

  function sendCollectedText() {
    const message = buildPayload();
    if (!message) {
      return;
    }

    chrome.runtime.sendMessage(message).catch(() => {
      // Ignore transient send failures (e.g., worker sleeping/restarting).
    });
  }

  const toxicTextObserver = new MutationObserver((mutations) => {
    if (!protectionReady || !protectionEnabled) {
      return;
    }

    for (const mutation of mutations) {
      for (const addedNode of mutation.addedNodes) {
        if (addedNode.nodeType === Node.TEXT_NODE) {
          blurToxicTextNode(addedNode);
          continue;
        }

        if (addedNode.nodeType === Node.ELEMENT_NODE) {
          scanPageForToxicText(addedNode);
        }
      }
    }
  });

  chrome.storage.local.get(['protectionEnabled', 'sentimentPreferences']).then(({ protectionEnabled: value, sentimentPreferences: prefs }) => {
    setSentimentPreferences(prefs);
    setProtectionEnabled(value !== false);
    if (protectionEnabled) {
      scanPageForToxicText();
      applySentimentBlur(document);
      sendCollectedText();
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') {
      return;
    }

    if (changes.sentimentPreferences) {
      setSentimentPreferences(changes.sentimentPreferences.newValue);
      if (protectionEnabled) {
        applySentimentBlur(document);
      }
    }

    if (changes.protectionEnabled) {
      setProtectionEnabled(changes.protectionEnabled.newValue !== false);
      if (protectionEnabled) {
        warningTriggered = false;
        scanPageForToxicText();
        applySentimentBlur(document);
        sendCollectedText();
      }
    }
  });

  toxicTextObserver.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('scroll', onScroll, { passive: true });
  window.setInterval(evaluateFloatingWidget, WIDGET_EVAL_INTERVAL_MS);
  window.setInterval(evaluateInterventionPanel, WIDGET_EVAL_INTERVAL_MS);
  evaluateFloatingWidget();
  evaluateInterventionPanel();
  sendCollectedText();
  window.setInterval(sendCollectedText, TEXT_INTERVAL_MS);
})();
