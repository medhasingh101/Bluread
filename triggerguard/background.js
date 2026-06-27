// Load API keys from config.js (Chrome Extension equivalent of .env)
importScripts('config.js');

/* ─── Defaults ────────────────────────────────────────────────────────────── */

const DEFAULTS = {
  enabled: true,
  sensitivity: 6,
  customWords: [],
  blurTopics: [],
  categories: {
    violence:   true,
    selfHarm:   true,
    sexual:     true,
    hate:       true,
    harassment: true,
  },
};

/* ─── Settings helper ─────────────────────────────────────────────────────── */

function getSettings() {
  return new Promise(resolve => {
    chrome.storage.sync.get(DEFAULTS, stored => {
      resolve({
        ...DEFAULTS,
        ...stored,
        categories:  { ...DEFAULTS.categories,  ...stored.categories },
        customWords: Array.isArray(stored.customWords) ? stored.customWords : [],
        blurTopics:  Array.isArray(stored.blurTopics) ? stored.blurTopics : [],
      });
    });
  });
}

/* ─── Message router ──────────────────────────────────────────────────────── */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {

    case 'GET_SETTINGS': {
      getSettings().then(settings => sendResponse(settings));
      return true;
    }

    case 'MODERATE_BATCH': {
      getSettings().then(settings => {
        if (!settings.enabled) { sendResponse([]); return; }

        const threshold = settings.sensitivity / 10;
        const payload   = message.payload ?? [];

        moderateBatch(payload, settings, threshold)
          .then(results => sendResponse(results))
          .catch(err => {
            console.warn('[TriggerGuard] moderateBatch error:', err.message);
            sendResponse([]);
          });
      });
      return true;
    }

    case 'SUMMARIZE': {
      summarize(message.text)
        .then(summary => sendResponse({ summary }))
        .catch(err => {
          console.warn('[TriggerGuard] summarize error:', err.message);
          sendResponse({ summary: null });
        });
      return true;
    }

    case 'ANALYZE_IMAGE': {
      getSettings().then(settings => {
        const videoUrl = message.videoUrl && typeof message.videoUrl === 'string' ? message.videoUrl.trim() : '';
        const topicList = [...new Set([
          ...(Array.isArray(settings.blurTopics) ? settings.blurTopics : []),
          ...(Array.isArray(settings.customWords) ? settings.customWords : []),
        ].map(t => String(t).trim()).filter(Boolean))];
        const tryTwelveLabs = videoUrl && videoUrl.startsWith('http') && CONFIG.TWELVE_LABS_BACKEND_URL;
        if (tryTwelveLabs) {
          analyzeVideoTwelveLabs(videoUrl, topicList)
            .then(result => sendResponse(result || { flagged: false }))
            .catch(err => {
              console.warn('[TriggerGuard] Twelve Labs error:', err.message);
              return analyzeImage(message.imageData, settings, message.contextText)
                .then(fallback => sendResponse(fallback || { flagged: false }));
            });
        } else {
          analyzeImage(message.imageData, settings, message.contextText)
            .then(result => sendResponse(result || { flagged: false }))
            .catch(err => {
              console.warn('[TriggerGuard] analyzeImage error:', err.message);
              sendResponse({ flagged: false });
            });
        }
      }).catch(() => sendResponse({ flagged: false }));
      return true;
    }

    case 'CAPTURE_AND_ANALYZE_VIDEO': {
      const { rect, requestId } = message;
      const tab = _sender?.tab;
      if (!tab?.id || !tab?.windowId || !rect || !requestId) {
        sendResponse({ ok: false });
        return false;
      }
      sendResponse({ ok: true });
      chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 90 })
        .then((dataUrl) => {
          chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_RESULT', fullCapture: dataUrl, rect, requestId })
            .catch(() => {});
        })
        .catch(() => {
          chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_RESULT', requestId, error: true }).catch(() => {});
        });
      return false;
    }
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   LOCAL TOXICITY ANALYZER
   Ported and extended from ../toxicityAnalyzer.js + ../commentScanner.js.
   Runs entirely in the service worker — no API key required.
   Each term carries a weight AND a category so a single pass detects both
   severity and the most likely content category.
   ═══════════════════════════════════════════════════════════════════════════ */

// Term catalog: { [term]: { weight, category } }
// Phrases are detected via trie traversal (same algorithm as the parent project).
const TERM_CATALOG = {
  // ── Violence ──────────────────────────────────────────────────────────────
  'murder':          { weight: 5, category: 'Violence' },
  'murdered':        { weight: 5, category: 'Violence' },
  'killing':         { weight: 4, category: 'Violence' },
  'massacre':        { weight: 5, category: 'Violence' },
  'slaughter':       { weight: 5, category: 'Violence' },
  'execute':         { weight: 4, category: 'Violence' },
  'executed':        { weight: 4, category: 'Violence' },
  'torture':         { weight: 5, category: 'Violence' },
  'tortured':        { weight: 5, category: 'Violence' },
  'stab':            { weight: 4, category: 'Violence' },
  'stabbed':         { weight: 4, category: 'Violence' },
  'assault':         { weight: 3, category: 'Violence' },
  'assaulted':       { weight: 3, category: 'Violence' },
  'brutally':        { weight: 3, category: 'Violence' },
  'bloodbath':       { weight: 5, category: 'Violence' },
  'gunshot':         { weight: 4, category: 'Violence' },
  'shootout':        { weight: 4, category: 'Violence' },
  'beheading':       { weight: 6, category: 'Violence' },
  'decapitation':    { weight: 6, category: 'Violence' },

  // ── Self-Harm ─────────────────────────────────────────────────────────────
  'suicide':         { weight: 5, category: 'Self-Harm' },
  'suicidal':        { weight: 5, category: 'Self-Harm' },
  'self-harm':       { weight: 5, category: 'Self-Harm' },
  'overdose':        { weight: 4, category: 'Self-Harm' },
  'kill yourself':   { weight: 8, category: 'Self-Harm' },
  'end your life':   { weight: 7, category: 'Self-Harm' },
  'hurt yourself':   { weight: 6, category: 'Self-Harm' },
  'cut yourself':    { weight: 6, category: 'Self-Harm' },
  'end it all':      { weight: 5, category: 'Self-Harm' },
  'better off dead': { weight: 6, category: 'Self-Harm' },
  'want to die':     { weight: 5, category: 'Self-Harm' },
  'no reason to live': { weight: 7, category: 'Self-Harm' },

  // ── Sexual Content ────────────────────────────────────────────────────────
  'pornographic':    { weight: 5, category: 'Sexual Content' },
  'explicit content': { weight: 4, category: 'Sexual Content' },
  'sexually explicit': { weight: 5, category: 'Sexual Content' },
  'nude':            { weight: 3, category: 'Sexual Content' },
  'nudity':          { weight: 3, category: 'Sexual Content' },
  'nsfw':            { weight: 4, category: 'Sexual Content' },

  // ── Hate Speech ───────────────────────────────────────────────────────────
  'hate crime':      { weight: 5, category: 'Hate Speech' },
  'white supremacy': { weight: 6, category: 'Hate Speech' },
  'white supremacist': { weight: 6, category: 'Hate Speech' },
  'ethnic cleansing': { weight: 7, category: 'Hate Speech' },
  'genocide':        { weight: 7, category: 'Hate Speech' },
  'racist':          { weight: 4, category: 'Hate Speech' },
  'racism':          { weight: 4, category: 'Hate Speech' },
  'antisemit':       { weight: 5, category: 'Hate Speech' },
  'islamophob':      { weight: 5, category: 'Hate Speech' },
  'bigot':           { weight: 3, category: 'Hate Speech' },
  'bigotry':         { weight: 3, category: 'Hate Speech' },
  'neo-nazi':        { weight: 6, category: 'Hate Speech' },
  'dehumaniz':       { weight: 5, category: 'Hate Speech' },

  // ── Harassment ────────────────────────────────────────────────────────────
  // (ported directly from ../toxicityAnalyzer.js + ../commentScanner.js)
  'abuse':           { weight: 2, category: 'Harassment' },
  'abusive':         { weight: 2, category: 'Harassment' },
  'awful':           { weight: 1, category: 'Harassment' },
  'clown':           { weight: 1, category: 'Harassment' },
  'creep':           { weight: 2, category: 'Harassment' },
  'creeps':          { weight: 2, category: 'Harassment' },
  'cruel':           { weight: 2, category: 'Harassment' },
  'degenerate':      { weight: 3, category: 'Harassment' },
  'disgusting':      { weight: 2, category: 'Harassment' },
  'dumb':            { weight: 2, category: 'Harassment' },
  'idiot':           { weight: 3, category: 'Harassment' },
  'idiots':          { weight: 3, category: 'Harassment' },
  'idiotic':         { weight: 3, category: 'Harassment' },
  'loser':           { weight: 2, category: 'Harassment' },
  'losers':          { weight: 2, category: 'Harassment' },
  'moron':           { weight: 3, category: 'Harassment' },
  'morons':          { weight: 3, category: 'Harassment' },
  'pathetic':        { weight: 2, category: 'Harassment' },
  'psycho':          { weight: 3, category: 'Harassment' },
  'scum':            { weight: 3, category: 'Harassment' },
  'stupid':          { weight: 2, category: 'Harassment' },
  'trash':           { weight: 1, category: 'Harassment' },
  'worthless':       { weight: 3, category: 'Harassment' },
  'drop dead':       { weight: 5, category: 'Harassment' },
  'go to hell':      { weight: 4, category: 'Harassment' },
  'nobody likes you': { weight: 4, category: 'Harassment' },
  'shut up':         { weight: 2, category: 'Harassment' },
  'you are disgusting': { weight: 4, category: 'Harassment' },
  'you are pathetic':   { weight: 4, category: 'Harassment' },
  'you are stupid':     { weight: 4, category: 'Harassment' },
  'you are trash':      { weight: 4, category: 'Harassment' },
  'you are worthless':  { weight: 5, category: 'Harassment' },
  'you are the worst':  { weight: 4, category: 'Harassment' },
};

/* ─── Trie builder (same algorithm as ../toxicityAnalyzer.js) ─────────────── */

function buildMatcher(catalog) {
  const unigram   = new Map(); // word → { weight, category }
  const phraseRoot = new Map(); // first word → trie node

  for (const [term, meta] of Object.entries(catalog)) {
    const parts = term.toLowerCase().match(/[a-z'-]+/g) || [];
    if (!parts.length) continue;

    if (parts.length === 1) {
      unigram.set(parts[0], meta);
      continue;
    }

    // Build trie path
    let node = phraseRoot;
    for (let i = 0; i < parts.length; i++) {
      const key = parts[i];
      if (!node.has(key)) node.set(key, { next: new Map(), meta: null });
      if (i === parts.length - 1) node.get(key).meta = { ...meta, length: parts.length };
      node = node.get(key).next;
    }
  }

  return { unigram, phraseRoot };
}

const MATCHER = buildMatcher(TERM_CATALOG);

/* ─── Local analysis ──────────────────────────────────────────────────────── */

/**
 * Scans text for toxic / sensitive terms plus any user-defined custom words.
 * Returns { flagged, category, score (0–100), detectedWords }.
 *
 * Score includes a floor based on the highest-weight single term found so that
 * one serious term in a long article still registers a meaningful score.
 * (e.g. one "murder" (weight 5) → floor of 55, regardless of article length)
 */
function localAnalyzeText(inputText, customWords = []) {
  const text  = String(inputText || '').toLowerCase();
  const words = text.match(/[a-z'-]+/g) || [];
  const wordCount = words.length;
  if (!wordCount) return { flagged: false, category: 'none', score: 0, detectedWords: [] };

  const categoryScores = {};  // category → accumulated severity
  const detectedWords  = new Set();
  let totalSeverity    = 0;
  let totalHits        = 0;
  let maxSingleWeight  = 0;  // tracks heaviest individual hit for floor calculation

  function recordHit(meta, term) {
    categoryScores[meta.category] = (categoryScores[meta.category] || 0) + meta.weight;
    totalSeverity    += meta.weight;
    totalHits        += 1;
    maxSingleWeight   = Math.max(maxSingleWeight, meta.weight);
    detectedWords.add(term);
  }

  // Single-token pass
  for (const word of words) {
    const meta = MATCHER.unigram.get(word);
    if (meta) recordHit(meta, word);
  }

  // Multi-word phrase pass (trie traversal)
  for (let start = 0; start < words.length; start++) {
    const entry = MATCHER.phraseRoot.get(words[start]);
    if (!entry) continue;

    let current = entry;
    let idx     = start + 1;
    if (current.meta) recordHit(current.meta, words.slice(start, start + current.meta.length).join(' '));

    while (idx < words.length) {
      const next = current.next.get(words[idx]);
      if (!next) break;
      current = next;
      if (current.meta) recordHit(current.meta, words.slice(start, idx + 1).join(' '));
      idx++;
    }
  }

  // Custom words pass — each match is treated as weight-5 'Custom' content
  for (const cw of customWords) {
    const cwLower = String(cw).toLowerCase().trim();
    if (cwLower && text.includes(cwLower)) {
      recordHit({ weight: 5, category: 'Custom' }, cw);
    }
  }

  if (!totalHits) return { flagged: false, category: 'none', score: 0, detectedWords: [] };

  // Density-based score (mirrors parent project formula)
  const termRate     = (totalHits / wordCount) * 100;
  const severityRate = (totalSeverity / wordCount) * 100;
  const rawScore     = termRate * 1.4 + severityRate * 2.1 + Math.min(30, totalHits * 0.35);

  // Floor ensures one serious term in a long article still registers:
  //   weight 5 (murder, suicide) → floor 55
  //   weight 4 (killing, stabbed) → floor 44
  //   weight 2 (dumb, awful)     → floor 22
  const floorScore = maxSingleWeight * 11;
  const score      = Math.min(100, Math.max(0, Math.round(Math.max(rawScore, floorScore))));

  // Top category = highest accumulated severity
  const topCategory = Object.entries(categoryScores)
    .sort(([, a], [, b]) => b - a)[0][0];

  return {
    flagged:       score > 0,
    category:      topCategory,
    score,
    detectedWords: Array.from(detectedWords),
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   LOCAL SUMMARY ENGINE
   Ported from ../background.js: extractKeyTerms, scoreSentence,
   generateSummaryParagraph, analyzePageSentiment.
   Produces a neutral 2-3 sentence summary with no API calls.
   ═══════════════════════════════════════════════════════════════════════════ */

const STOP_WORDS = new Set([
  'a','about','above','after','again','against','all','also','am','an','and','any','are','as','at',
  'be','because','been','before','being','below','between','both','but','by','can','could','did','do',
  'does','doing','down','during','each','few','for','from','had','has','have','having','he','her',
  'here','him','his','how','i','if','in','into','is','it','its','just','me','more','most','my','no',
  'nor','not','now','of','off','on','once','only','or','other','our','out','over','own','same','she',
  'should','so','some','such','than','that','the','their','them','then','there','these','they','this',
  'those','through','to','too','under','until','up','very','was','we','were','what','when','where',
  'which','while','who','will','with','you','your',
]);

function extractKeyTerms(text, max = 6) {
  const freq = new Map();
  const words = text.toLowerCase().match(/[a-z']+/g) || [];
  for (const w of words) {
    if (w.length < 3 || STOP_WORDS.has(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([t]) => t);
}

function splitSentences(text) {
  return text.match(/[^.!?]+[.!?]?/g)
    ?.map(s => s.trim())
    .filter(s => s.length > 30) || [];
}

function scoreSentence(sentence, keyTerms) {
  const lower = sentence.toLowerCase();
  let hits = 0;
  for (const t of keyTerms) if (lower.includes(t)) hits++;
  return hits * 3 - (sentence.length > 280 ? 1 : 0);
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function toTokens(text) {
  return String(text || '').toLowerCase().match(/[a-z']+/g) || [];
}

function estimateTone(text) {
  const lower = String(text || '').toLowerCase();
  const alertCues = [
    'killed', 'killing', 'murder', 'suicide', 'abuse', 'attack', 'violent', 'threat',
    'disturbing', 'graphic', 'injury', 'dead', 'death', 'harass',
  ];
  const hits = alertCues.reduce((count, cue) => count + (lower.includes(cue) ? 1 : 0), 0);
  if (hits >= 4) return 'highly distressing';
  if (hits >= 2) return 'distressing';
  return 'sensitive';
}

function isSummaryTooCloseToSource(summary, source) {
  const s = String(summary || '').trim();
  const t = String(source || '').trim();
  if (!s || !t) return true;

  // If output is almost as long as input, it is likely not a summary.
  if (s.length > t.length * 0.7) return true;

  // Exact inclusion check catches copy/paste outputs quickly.
  if (t.toLowerCase().includes(s.toLowerCase())) return true;

  // Token overlap heuristic: very high overlap usually means near copy.
  const sourceTokens = toTokens(t);
  const summaryTokens = toTokens(s);
  if (!sourceTokens.length || !summaryTokens.length) return false;
  const sourceSet = new Set(sourceTokens);
  const overlap = summaryTokens.filter(tok => sourceSet.has(tok)).length / summaryTokens.length;
  return overlap > 0.92;
}

/**
 * Generates a neutral 2-3 sentence summary using key-term extraction
 * and sentence ranking — no API call required.
 * Ported from ../background.js → generateSummaryParagraph.
 */
function localSummarize(text) {
  const clean     = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 30_000);
  const keyTerms  = extractKeyTerms(clean);
  const sentences = splitSentences(clean);
  const topTerms  = uniq(keyTerms).slice(0, 4);
  const tone      = estimateTone(clean);

  if (!clean) {
    return 'This content appears to include sensitive material, but there was not enough text to summarize.';
  }

  const topic = topTerms.length >= 2
    ? `${topTerms[0]} and ${topTerms[1]}`
    : topTerms[0] || 'a sensitive topic';

  // Keep summary synthetic/abstractive so we avoid echoing original text verbatim.
  const sentenceOne = `This section discusses ${topic} and appears ${tone}.`;
  const sentenceTwo = topTerms.length
    ? `Main themes include ${topTerms.join(', ')}.`
    : 'Main themes are unclear from the available text.';
  const sentenceThree = sentences.length > 2
    ? 'It combines multiple details and context around this topic.'
    : 'It presents brief context around this topic.';

  return `${sentenceOne} ${sentenceTwo} ${sentenceThree}`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   OPENAI CATEGORY MAP
   ═══════════════════════════════════════════════════════════════════════════ */

const OPENAI_CATEGORY_LABELS = {
  'violence':               'Violence',
  'violence/graphic':       'Violence',
  'self-harm':              'Self-Harm',
  'self-harm/intent':       'Self-Harm',
  'self-harm/instructions': 'Self-Harm',
  'sexual':                 'Sexual Content',
  'sexual/minors':          'Sexual Content',
  'hate':                   'Hate Speech',
  'hate/threatening':       'Hate Speech',
  'harassment':             'Harassment',
  'harassment/threatening': 'Harassment',
};

const LABEL_TO_SETTINGS_KEY = {
  'Violence':       'violence',
  'Self-Harm':      'selfHarm',
  'Sexual Content': 'sexual',
  'Hate Speech':    'hate',
  'Harassment':     'harassment',
};

/* ═══════════════════════════════════════════════════════════════════════════
   MODERATION
   Strategy:
     1. Always run localAnalyzeText (instant, no API, works offline).
     2. If an OpenAI key is present, confirm with the Moderation API.
        OpenAI's result takes precedence when available.
   ═══════════════════════════════════════════════════════════════════════════ */

async function moderateBatch(items, settings, _threshold) {
  if (!items.length) return [];

  const customWords = settings.customWords || [];

  // Inverted threshold: higher sensitivity = lower threshold = more things flagged.
  // sensitivity 1 (permissive) → threshold 1.0 (almost nothing local-flagged)
  // sensitivity 6 (default)    → threshold 0.5  (weight-5 floor of 55 passes)
  // sensitivity 10 (strict)    → threshold 0.1  (very sensitive)
  const localThreshold = (11 - settings.sensitivity) / 10;

  // ── Step 1: local analysis (always runs) ──────────────────────────────── //
  const localResults = items.map(item => {
    const local       = localAnalyzeText(item.text, customWords);
    const settingsKey = LABEL_TO_SETTINGS_KEY[local.category] ?? local.category.toLowerCase();
    // Custom-word hits are always enabled regardless of category toggles
    const enabled     = local.category === 'Custom' ? true : (settings.categories[settingsKey] ?? true);
    const flagged     = local.flagged && enabled && (local.score / 100) >= localThreshold;
    return { id: item.id, flagged, category: local.category, score: local.score, detectedWords: local.detectedWords };
  });

  // ── Step 2: OpenAI confirmation (only when key is configured) ─────────── //
  if (!CONFIG.OPENAI_API_KEY) {
    return localResults;
  }

  let openAIResults;
  try {
    const res = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ input: items.map(i => i.text) }),
    });

    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const { results } = await res.json();

    openAIResults = items.map((item, idx) => {
      const raw         = results[idx];
      const [topKey, topScore] = Object.entries(raw.category_scores)
        .sort(([, a], [, b]) => b - a)[0];
      const label       = OPENAI_CATEGORY_LABELS[topKey] ?? topKey;
      const settingsKey = LABEL_TO_SETTINGS_KEY[label]   ?? label.toLowerCase();
      const enabled     = settings.categories[settingsKey] ?? true;
      // Use the same inverted threshold as local analysis for consistency
      const flagged     = raw.flagged && enabled && topScore >= localThreshold;
      // OpenAI doesn't return matched phrases — run local analyzer to get them
      const local       = localAnalyzeText(item.text, customWords);
      return { id: item.id, flagged, category: label, score: Math.round(topScore * 100), detectedWords: local.detectedWords };
    });
  } catch (err) {
    // OpenAI failed — fall back to local results rather than failing silently
    console.warn('[TriggerGuard] OpenAI moderation unavailable, using local analysis:', err.message);
    return localResults;
  }

  return openAIResults;
}

/* ═══════════════════════════════════════════════════════════════════════════
   SUMMARIZATION
   Strategy:
     1. If Anthropic key is present → Claude (best quality).
     2. Otherwise → localSummarize (key-term extraction, works offline).
   ═══════════════════════════════════════════════════════════════════════════ */

async function summarize(text) {
  const cleanText = String(text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

  if (!cleanText) {
    return 'This content appears to include sensitive material, but there was not enough text to summarize.';
  }

  // ── Anthropic Claude (preferred when key is available) ─────────────────── //
  if (CONFIG.ANTHROPIC_API_KEY) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         CONFIG.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-3-haiku-20240307',
        max_tokens: 200,
        messages: [{
          role:    'user',
          content: `Write a concise 2-3 sentence abstract summary of this sensitive content. ` +
                   `Do not quote or repeat the source wording. Avoid vivid details. ` +
                   `Focus on high-level topic and tone only.\n\n${cleanText.slice(0, 3000)}`,
        }],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.warn('[TriggerGuard] Anthropic error, falling back to local summary:', res.status, body);
      // Fall through to local summary below
    } else {
      const data = await res.json();
      const candidate = data?.content?.[0]?.text?.trim();
      if (candidate && !isSummaryTooCloseToSource(candidate, cleanText)) {
        return candidate;
      }
      // If model output is too close to source text, use local abstractive fallback.
      return localSummarize(cleanText);
    }
  }

  // ── Local summary (no API needed) ─────────────────────────────────────── //
  return localSummarize(cleanText);
}

/* ═══════════════════════════════════════════════════════════════════════════
   VIDEO / IMAGE ANALYSIS (Instagram Reels, X videos)
   Uses Gemini multimodal to score a single frame for sensitive content.
   Optional: CONFIG.VIDEO_ANALYSIS_BACKEND_URL for local FastAPI pipeline.
   ═══════════════════════════════════════════════════════════════════════════ */

function parseImageDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!m) return null;
  return { mimeType: `image/${m[1]}`, data: m[2] };
}

/** Call Twelve Labs backend: full-video analysis → trigger words + summary (timeout 95s for indexing) */
async function analyzeVideoTwelveLabs(videoUrl, keywords) {
  const base = typeof CONFIG !== 'undefined' && CONFIG.TWELVE_LABS_BACKEND_URL ? CONFIG.TWELVE_LABS_BACKEND_URL.replace(/\/$/, '') : '';
  if (!base) throw new Error('Twelve Labs backend not configured');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 95000);
  try {
    const res = await fetch(`${base}/analyze-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_url: videoUrl, keywords: keywords || [] }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Twelve Labs ${res.status}`);
    const trigger_words = Array.isArray(data.trigger_words) ? data.trigger_words : [];
    return {
      flagged: Boolean(data.flagged),
      category: 'Custom',
      score: data.flagged ? 70 : 0,
      summary: typeof data.summary === 'string' ? data.summary : '',
      reasons: trigger_words,
    };
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}

async function analyzeImage(imageData, settings = {}, contextText = '') {
  const parsed = parseImageDataUrl(imageData);
  if (!parsed) {
    console.warn('[TriggerGuard] analyzeImage: no valid image data (parse failed)');
    return { flagged: false };
  }

  // Combine blur topics and custom words so videos blur when they match either list
  const blurTopics = Array.isArray(settings.blurTopics) ? settings.blurTopics : [];
  const customWords = Array.isArray(settings.customWords) ? settings.customWords : [];
  const topicList = [...new Set([...blurTopics, ...customWords].map(t => String(t).trim()).filter(Boolean))];
  const postText = typeof contextText === 'string' ? contextText.trim().slice(0, 1500) : '';

  // Optional: use backend for image analysis (e.g. Twelve Labs server with its own Gemini key — avoids extension quota 429)
  const backendBase = typeof CONFIG !== 'undefined' && CONFIG.TWELVE_LABS_BACKEND_URL ? CONFIG.TWELVE_LABS_BACKEND_URL.replace(/\/$/, '') : '';
  if (backendBase) {
    try {
      console.log('[TriggerGuard] Trying backend for image analysis:', backendBase);
      const res = await fetch(`${backendBase}/analyze-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_base64: parsed.data,
          mime_type: parsed.mimeType,
          keywords: topicList,
          post_text: postText,
        }),
      });
      if (res.ok) {
        const json = await res.json();
        const reasons = Array.isArray(json.reasons) ? json.reasons : [];
        console.log('[TriggerGuard] Backend image analysis result:', { flagged: json.flagged, category: json.category, reasons: reasons.length });
        return {
          flagged: Boolean(json.flagged),
          category: json.category || 'Sensitive content',
          score: Number(json.score) || 0,
          summary: json.summary || '',
          reasons: reasons,
        };
      }
      const errText = await res.text().catch(() => '');
      console.warn('[TriggerGuard] Backend analyze-image returned', res.status, errText.slice(0, 150));
    } catch (err) {
      console.warn('[TriggerGuard] Backend analyze-image failed, falling back to Gemini:', err.message);
    }
  }

  // Optional: local FastAPI backend (multi-model pipeline)
  if (CONFIG.VIDEO_ANALYSIS_BACKEND_URL) {
    try {
      const res = await fetch(`${CONFIG.VIDEO_ANALYSIS_BACKEND_URL}/analyze-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_base64: parsed.data,
          mime_type: parsed.mimeType,
          blur_topics: topicList,
        }),
      });
      if (res.ok) {
        const json = await res.json();
        const reasons = Array.isArray(json.reasons) ? json.reasons : [];
        return {
          flagged: Boolean(json.flagged),
          category: json.category || 'Sensitive content',
          score: Number(json.score) || 0,
          summary: json.summary || '',
          reasons: reasons,
        };
      }
    } catch (err) {
      console.warn('[TriggerGuard] Video backend unavailable:', err.message);
    }
  }

  // Gemini multimodal (image + prompt → score, category, summary, reasons)
  if (!CONFIG.GEMINI_API_KEY) {
    console.warn('[TriggerGuard] analyzeImage: no GEMINI_API_KEY, skipping image analysis');
    return { flagged: false };
  }

  const topicsInstruction = topicList.length > 0
    ? `

IMPORTANT - User keywords/topics to blur: ${JSON.stringify(topicList)}.
If this image or video frame is ABOUT or shows ANY of these (person, country, event, news, or related imagery), you MUST set category to "Custom" and sensitivity to 7 or higher. Add a "reasons" array with 1–3 short strings, e.g. "References [topic]" or "Shows [person/country]".`
    : '';

  const postTextInstruction = postText && topicList.length > 0
    ? `

Post/caption text from the page: "${postText.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"
If this text mentions or is about any of the user's keywords/topics above, you MUST set category to "Custom" and sensitivity to 7 or higher and add a reason (e.g. "Post text references [topic]").`
    : '';

  const responseFormat = topicList.length > 0
    ? '{"sensitivity": <0-10>, "category": "<Violence|Self-Harm|Sexual Content|Hate Speech|Harassment|Graphic|Custom|None>", "summary": "<short sentence>", "reasons": ["<reason1>", "<reason2>"]}'
    : '{"sensitivity": <0-10 number>, "category": "<one of: Violence, Self-Harm, Sexual Content, Hate Speech, Harassment, Graphic, None>", "summary": "<one short sentence describing what is shown for someone who wants to avoid distressing content>"}';

  const prompt = `You are a content safety classifier. Look at this single image/frame from a social media video or image post.

Respond in exactly this JSON format (no other text):
${responseFormat}

Rules:
- sensitivity 0 = completely safe; 10 = highly distressing.
- If the image shows violence, gore, self-harm, sexual content, hate symbols, or other harmful/graphic content, you MUST set the appropriate category (Violence, Graphic, Self-Harm, Sexual Content, Hate Speech, etc.) and sensitivity to 6 or higher. Do not use "None" for harmful imagery.
- If the image is safe/neutral and does NOT match any user topic below (and post text if given does not mention them), use category "None" and sensitivity 0-2.
- If it DOES match any user topic below (in the image OR in the post text), use category "Custom", sensitivity 7+, and fill "reasons". If "reasons" is in the format, use [] when category is None.${topicsInstruction}${postTextInstruction}`;

  try {
    console.log('[TriggerGuard] Analyzing image with Gemini (frame + prompt). Topics:', topicList.length, 'Post text length:', postText.length);
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { text: prompt },
              { inlineData: { mimeType: parsed.mimeType, data: parsed.data } },
            ],
          }],
          generationConfig: {
            maxOutputTokens: 320,
            temperature: 0.2,
          },
        }),
      }
    );
    if (!res.ok) {
      const errBody = await res.text();
      if (res.status === 429) {
        console.warn('[TriggerGuard] Gemini quota exceeded (429). Image analysis skipped. Check your plan and billing: https://ai.google.dev/gemini-api/docs');
      } else {
        console.warn('[TriggerGuard] Gemini HTTP', res.status, errBody.slice(0, 200));
      }
      throw new Error(`Gemini ${res.status}`);
    }
    const data = await res.json();
    let text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    console.log('[TriggerGuard] Gemini raw response:', text.slice(0, 300) + (text.length > 300 ? '...' : ''));
    text = text.replace(/^[\s\S]*?```(?:json)?\s*/i, '').replace(/\s*```[\s\S]*$/, '').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const obj = jsonMatch ? (() => { try { return JSON.parse(jsonMatch[0]); } catch (e) { return {}; } })() : {};
    const sensitivity = Number(obj.sensitivity) || 0;
    const rawCategory = (obj.category && String(obj.category).trim()) || 'Graphic';
    const category = rawCategory.toLowerCase() === 'none' ? 'None' : (rawCategory === 'Custom' || rawCategory.toLowerCase() === 'custom' ? 'Custom' : rawCategory);
    const summary = obj.summary || '';
    const reasons = Array.isArray(obj.reasons) ? obj.reasons.filter(r => typeof r === 'string') : [];
    const threshold = 5;
    const flagged = category !== 'None' && sensitivity >= threshold;
    const score = Math.min(100, sensitivity * 10);
    console.log('[TriggerGuard] Gemini result:', { sensitivity, category, threshold, flagged, score, summary: summary.slice(0, 80), reasons });
    return { flagged, category, score, summary, reasons };
  } catch (err) {
    if (err.message && err.message.includes('429')) {
      console.warn('[TriggerGuard] Gemini image analysis skipped: API quota exceeded. Add billing or wait for reset. See https://ai.google.dev/gemini-api/docs');
    } else {
      console.warn('[TriggerGuard] Gemini image analysis failed:', err.message);
    }
    return { flagged: false };
  }
}
