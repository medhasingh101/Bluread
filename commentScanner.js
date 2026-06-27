(() => {
  const HIGH_TOXICITY_THRESHOLD = 60;
  const SCAN_INTERVAL_MS = 12_000;
  const HIDDEN_TOKEN = '[Hateful content hidden]';
  const TOXIC_TERM_WEIGHTS = {
    abuse: 2,
    abusive: 2,
    awful: 1,
    clown: 1,
    creep: 2,
    creeps: 2,
    cruel: 2,
    degenerate: 3,
    disgusting: 2,
    dumb: 2,
    idiot: 3,
    idiots: 3,
    idiotic: 3,
    loser: 2,
    losers: 2,
    moron: 3,
    morons: 3,
    pathetic: 2,
    psycho: 3,
    scum: 3,
    stupid: 2,
    trash: 1,
    worthless: 3,
    'drop dead': 5,
    'go to hell': 4,
    'kill yourself': 6,
    'nobody likes you': 4,
    'shut up': 2,
    'you are disgusting': 4,
    'you are pathetic': 4,
    'you are stupid': 4,
    'you are trash': 4,
    'you are worthless': 5,
    'you are the worst': 4,
  };
  const TOXIC_TERMS = Object.keys(TOXIC_TERM_WEIGHTS)
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
  const TOXIC_REGEX = new RegExp(`\\b(?:${TOXIC_TERMS.join('|')})\\b`, 'gi');
  let protectionEnabled = true;
  let protectionReady = false;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeForTokens(value) {
    return String(value || '').toLowerCase();
  }

  function tokenize(text) {
    return text.match(/[a-z']+/g) || [];
  }

  function buildMatcher(termWeights) {
    const unigram = new Map();
    const phraseRoot = new Map();

    for (const [term, weight] of Object.entries(termWeights)) {
      const parts = tokenize(term);
      if (parts.length === 0) {
        continue;
      }

      if (parts.length === 1) {
        unigram.set(parts[0], weight);
        continue;
      }

      let node = phraseRoot;
      for (let i = 0; i < parts.length; i += 1) {
        const key = parts[i];
        if (!node.has(key)) {
          node.set(key, { next: new Map(), term: null, weight: 0, length: 0 });
        }

        const entry = node.get(key);
        if (i === parts.length - 1) {
          entry.term = term;
          entry.weight = weight;
          entry.length = parts.length;
        }

        node = entry.next;
      }
    }

    return { unigram, phraseRoot };
  }

  const MATCHER = buildMatcher(TOXIC_TERM_WEIGHTS);

  function incrementCount(map, key, amount = 1) {
    map.set(key, (map.get(key) || 0) + amount);
  }

  function analyzeToxicity(inputText) {
    const words = tokenize(normalizeForTokens(inputText));
    const wordCount = words.length;
    const detectedCounts = new Map();

    let toxicWordCount = 0;
    let severityTotal = 0;

    for (const word of words) {
      const weight = MATCHER.unigram.get(word);
      if (!weight) {
        continue;
      }

      toxicWordCount += 1;
      severityTotal += weight;
      incrementCount(detectedCounts, word, 1);
    }

    for (let start = 0; start < words.length; start += 1) {
      const firstEntry = MATCHER.phraseRoot.get(words[start]);
      if (!firstEntry) {
        continue;
      }

      let currentEntry = firstEntry;
      let index = start + 1;

      if (currentEntry.term) {
        toxicWordCount += currentEntry.length;
        severityTotal += currentEntry.weight;
        incrementCount(detectedCounts, currentEntry.term, 1);
      }

      while (index < words.length) {
        const nextEntry = currentEntry.next.get(words[index]);
        if (!nextEntry) {
          break;
        }

        currentEntry = nextEntry;
        if (currentEntry.term) {
          toxicWordCount += currentEntry.length;
          severityTotal += currentEntry.weight;
          incrementCount(detectedCounts, currentEntry.term, 1);
        }

        index += 1;
      }
    }

    const termRate = wordCount > 0 ? (toxicWordCount / wordCount) * 100 : 0;
    const severityRate = wordCount > 0 ? (severityTotal / wordCount) * 100 : 0;
    const rawScore = termRate * 1.4 + severityRate * 2.1 + Math.min(30, toxicWordCount * 0.35);

    return {
      toxicityScore: clamp(Math.round(rawScore), 0, 100),
      toxicWordCount,
      detectedWords: Array.from(detectedCounts.keys()),
    };
  }

  function isVisible(element) {
    if (!element || !(element instanceof Element)) {
      return false;
    }

    if (element.hidden || element.getAttribute('aria-hidden') === 'true') {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getCommentCandidates(root = document) {
    const selector = [
      '[role="comment"]',
      '.comment',
      '.comments .item',
      '.comment-body',
      '.comment-content',
      'article[data-testid*="comment"]',
      'li[data-testid*="comment"]',
      '[id*="comment"] p',
      '.replies p',
    ].join(', ');

    return Array.from(root.querySelectorAll(selector));
  }

  function addWarningLabel(commentEl, score) {
    if (commentEl.querySelector('.toxicity-warning-label')) {
      return;
    }

    const label = document.createElement('div');
    label.className = 'toxicity-warning-label';
    label.textContent = `Warning: hateful content masked (score ${score}/100). Click to reveal.`;
    label.style.display = 'inline-block';
    label.style.marginBottom = '6px';
    label.style.padding = '3px 8px';
    label.style.borderRadius = '999px';
    label.style.background = '#fef3c7';
    label.style.color = '#92400e';
    label.style.fontSize = '12px';
    label.style.fontWeight = '600';
    label.style.lineHeight = '1.2';

    commentEl.insertBefore(label, commentEl.firstChild);
  }

  function styleMaskedSentence(span) {
    span.className = 'toxicity-masked-sentence';
    span.style.filter = 'blur(2px)';
    span.style.background = 'rgba(254, 242, 242, 0.75)';
    span.style.borderRadius = '4px';
    span.style.padding = '0 1px';
    span.style.transition = 'filter 140ms ease';
  }

  function buildSentenceFragment(sentence) {
    const fragment = document.createDocumentFragment();
    const regex = new RegExp(TOXIC_REGEX.source, TOXIC_REGEX.flags);
    let hasToxic = false;
    let lastIndex = 0;
    let match = regex.exec(sentence);

    while (match) {
      hasToxic = true;
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(sentence.slice(lastIndex, match.index)));
      }

      const token = document.createElement('span');
      token.className = 'toxicity-hidden-token';
      token.textContent = HIDDEN_TOKEN;
      fragment.appendChild(token);

      lastIndex = match.index + match[0].length;
      match = regex.exec(sentence);
    }

    if (!hasToxic) {
      return null;
    }

    if (lastIndex < sentence.length) {
      fragment.appendChild(document.createTextNode(sentence.slice(lastIndex)));
    }

    const sentenceSpan = document.createElement('span');
    sentenceSpan.dataset.originalSentence = sentence;
    sentenceSpan.dataset.masked = 'true';
    styleMaskedSentence(sentenceSpan);
    sentenceSpan.appendChild(fragment);
    return sentenceSpan;
  }

  function maskToxicSentences(commentEl) {
    if (commentEl.dataset.toxicityMasked === 'true') {
      return;
    }

    const textNodes = [];
    const walker = document.createTreeWalker(commentEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || parent.closest('.toxicity-warning-label')) {
          return NodeFilter.FILTER_REJECT;
        }

        if (!normalizeText(node.nodeValue || '')) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let current = walker.nextNode();
    while (current) {
      textNodes.push(current);
      current = walker.nextNode();
    }

    for (const textNode of textNodes) {
      const text = textNode.nodeValue || '';
      if (!TOXIC_REGEX.test(text)) {
        TOXIC_REGEX.lastIndex = 0;
        continue;
      }
      TOXIC_REGEX.lastIndex = 0;

      const fragment = document.createDocumentFragment();
      const sentences = text.match(/[^.!?]+[.!?]?|\s+/g) || [text];

      for (const sentence of sentences) {
        const maybeMaskedSentence = buildSentenceFragment(sentence);
        if (maybeMaskedSentence) {
          fragment.appendChild(maybeMaskedSentence);
        } else {
          fragment.appendChild(document.createTextNode(sentence));
        }
      }

      if (textNode.parentNode) {
        textNode.parentNode.replaceChild(fragment, textNode);
      }
    }

    commentEl.dataset.toxicityMasked = 'true';
  }

  function setRevealState(commentEl, reveal) {
    const maskedSentences = commentEl.querySelectorAll('.toxicity-masked-sentence');
    for (const sentence of maskedSentences) {
      if (reveal) {
        sentence.textContent = sentence.dataset.originalSentence || sentence.textContent || '';
        sentence.style.filter = 'none';
        sentence.dataset.masked = 'false';
      } else {
        const original = sentence.dataset.originalSentence || sentence.textContent || '';
        const rebuilt = buildSentenceFragment(original);
        if (rebuilt) {
          sentence.replaceWith(rebuilt);
        }
      }
    }

    commentEl.dataset.toxicityRevealed = reveal ? 'true' : 'false';
  }

  function resetModeratedComment(commentEl) {
    if (!(commentEl instanceof Element)) {
      return;
    }

    const warning = commentEl.querySelector('.toxicity-warning-label');
    if (warning) {
      warning.remove();
    }

    const maskedSentences = commentEl.querySelectorAll('.toxicity-masked-sentence');
    for (const sentence of maskedSentences) {
      sentence.textContent = sentence.dataset.originalSentence || sentence.textContent || '';
      sentence.style.filter = 'none';
      sentence.style.background = '';
      sentence.style.borderRadius = '';
      sentence.style.padding = '';
      sentence.classList.remove('toxicity-masked-sentence');
    }

    commentEl.style.cursor = '';
    commentEl.dataset.toxicityRevealed = 'true';
    delete commentEl.dataset.toxicityModerated;
  }

  function clearModerationFromPage() {
    const comments = getCommentCandidates(document);
    for (const commentEl of comments) {
      resetModeratedComment(commentEl);
    }
  }

  function enableRevealToggle(commentEl) {
    if (commentEl.dataset.toxicityToggleBound === 'true') {
      return;
    }

    commentEl.style.cursor = 'pointer';
    commentEl.addEventListener('click', () => {
      const isRevealed = commentEl.dataset.toxicityRevealed === 'true';
      setRevealState(commentEl, !isRevealed);
    });
    commentEl.dataset.toxicityToggleBound = 'true';
  }

  function moderateComment(commentEl) {
    if (!protectionReady || !protectionEnabled) {
      return;
    }

    if (!(commentEl instanceof Element) || !isVisible(commentEl)) {
      return;
    }

    const sourceText = normalizeText(commentEl.innerText || commentEl.textContent || '');
    if (!sourceText) {
      return;
    }

    const analysis = analyzeToxicity(sourceText);
    commentEl.dataset.toxicityScore = String(analysis.toxicityScore);
    commentEl.dataset.toxicWordCount = String(analysis.toxicWordCount);
    commentEl.dataset.detectedToxicWords = analysis.detectedWords.join(', ');

    if (analysis.toxicityScore >= HIGH_TOXICITY_THRESHOLD) {
      maskToxicSentences(commentEl);
      addWarningLabel(commentEl, analysis.toxicityScore);
      enableRevealToggle(commentEl);
      commentEl.dataset.toxicityModerated = 'true';
    }
  }

  function scanComments(root = document) {
    if (!protectionReady || !protectionEnabled) {
      return;
    }

    const candidates = getCommentCandidates(root);
    for (const commentEl of candidates) {
      moderateComment(commentEl);
    }
  }

  const observer = new MutationObserver((mutations) => {
    if (!protectionReady || !protectionEnabled) {
      return;
    }

    for (const mutation of mutations) {
      for (const addedNode of mutation.addedNodes) {
        if (addedNode.nodeType === Node.ELEMENT_NODE) {
          scanComments(addedNode);
        }
      }
    }
  });

  chrome.storage.local.get('protectionEnabled').then(({ protectionEnabled: value }) => {
    protectionEnabled = value !== false;
    protectionReady = true;
    if (protectionEnabled) {
      scanComments();
    } else {
      clearModerationFromPage();
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.protectionEnabled) {
      return;
    }

    protectionEnabled = changes.protectionEnabled.newValue !== false;
    protectionReady = true;
    if (protectionEnabled) {
      scanComments();
    } else {
      clearModerationFromPage();
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  if (protectionReady && protectionEnabled) {
    scanComments();
  }
  window.setInterval(() => {
    if (protectionReady && protectionEnabled) {
      scanComments();
    }
  }, SCAN_INTERVAL_MS);
})();
