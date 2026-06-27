const DAILY_STATS_KEY = 'dashboardDailyStats';
const TAB_STATE_KEY = 'dashboardTabState';
const MAX_DELTA_MS = 30_000;
const SUMMARY_TEXT_LIMIT = 30_000;
const SUMMARY_KEY_TERM_COUNT = 6;
const SUMMARY_SENTENCE_MAX = 3;
const POSITIVE_SENTIMENT_WORDS = new Set([
  'amazing', 'awesome', 'benefit', 'calm', 'care', 'celebrate', 'confident', 'delight', 'enjoy', 'excellent',
  'friendly', 'good', 'grateful', 'great', 'happy', 'helpful', 'hope', 'improve', 'inspiring', 'joy', 'kind',
  'love', 'optimistic', 'peace', 'positive', 'progress', 'relaxed', 'safe', 'support', 'thankful', 'wonderful',
]);
const NEGATIVE_SENTIMENT_WORDS = new Set([
  'angry', 'anxious', 'awful', 'bad', 'conflict', 'crisis', 'danger', 'depressed', 'disaster', 'fear', 'frustrated',
  'hate', 'harm', 'horrible', 'hostile', 'negative', 'panic', 'sad', 'scared', 'stress', 'toxic', 'tragic',
  'upset', 'violence', 'worse', 'worst',
]);
const STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can', 'could', 'did', 'do',
  'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had', 'has', 'have', 'having', 'he',
  'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
  'itself', 'just', 'me', 'more', 'most', 'my', 'myself', 'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once',
  'only', 'or', 'other', 'our', 'ours', 'ourselves', 'out', 'over', 'own', 'same', 'she', 'should', 'so', 'some',
  'such', 'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this',
  'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what', 'when', 'where',
  'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'you', 'your', 'yours', 'yourself', 'yourselves',
]);

function getDayKey(timestampIso) {
  const date = timestampIso ? new Date(timestampIso) : new Date();
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getDefaultDayStats() {
  return {
    toxicPostsDetected: 0,
    doomscrollingMs: 0,
    feedHealthScoreSum: 0,
    feedHealthSamples: 0,
    dailyFeedHealthScore: 100,
    updatedAt: new Date().toISOString(),
  };
}

function normalizePageText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SUMMARY_TEXT_LIMIT);
}

function tokenize(text) {
  return text.toLowerCase().match(/[a-z']+/g) || [];
}

function extractKeyTerms(pageText, maxTerms = SUMMARY_KEY_TERM_COUNT) {
  const freq = new Map();
  const words = tokenize(pageText);

  for (const word of words) {
    if (word.length < 3 || STOP_WORDS.has(word)) {
      continue;
    }
    freq.set(word, (freq.get(word) || 0) + 1);
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTerms)
    .map(([term]) => term);
}

function analyzePageSentiment(pageText) {
  const words = tokenize(pageText);
  if (!words.length) {
    return {
      positivePercentage: 0,
      neutralPercentage: 100,
      negativePercentage: 0,
    };
  }

  let positiveCount = 0;
  let negativeCount = 0;
  for (const word of words) {
    if (POSITIVE_SENTIMENT_WORDS.has(word)) {
      positiveCount += 1;
    }
    if (NEGATIVE_SENTIMENT_WORDS.has(word)) {
      negativeCount += 1;
    }
  }

  const sentimentHits = positiveCount + negativeCount;
  const neutralCount = Math.max(0, words.length - sentimentHits);

  return {
    positivePercentage: Math.round((positiveCount / words.length) * 100),
    neutralPercentage: Math.round((neutralCount / words.length) * 100),
    negativePercentage: Math.round((negativeCount / words.length) * 100),
  };
}

function calculatePageHealthScore(input = {}) {
  const toxicityScore = clamp(Number(input.toxicityScore || 0), 0, 100);
  const negativeSentiment = clamp(Number(input.negativeSentiment || 0), 0, 100);
  const numberOfToxicSections = Math.max(0, Number(input.numberOfToxicSections || 0));

  // Convert section count to a bounded risk score.
  const toxicSectionRisk = Math.min(100, numberOfToxicSections * 15);

  // Weighted risk model:
  // toxicityScore 50%, negativeSentiment 30%, toxic section count 20%.
  const riskScore = toxicityScore * 0.5 + negativeSentiment * 0.3 + toxicSectionRisk * 0.2;
  return clamp(Math.round(100 - riskScore), 0, 100);
}

function identifyMainTopic(keyTerms) {
  if (!keyTerms.length) {
    return 'General webpage content';
  }
  if (keyTerms.length === 1) {
    return keyTerms[0];
  }
  return `${keyTerms[0]} and ${keyTerms[1]}`;
}

function splitSentences(pageText) {
  return pageText
    .match(/[^.!?]+[.!?]?/g)
    ?.map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 30) || [];
}

function scoreSentence(sentence, keyTerms) {
  const lower = sentence.toLowerCase();
  let hits = 0;
  for (const term of keyTerms) {
    if (lower.includes(term)) {
      hits += 1;
    }
  }

  const lengthPenalty = sentence.length > 280 ? 1 : 0;
  return hits * 3 - lengthPenalty;
}

function generateSummaryParagraph(pageText, keyTerms, topic) {
  const sentences = splitSentences(pageText);

  if (!sentences.length) {
    if (!keyTerms.length) {
      return 'This page contains general content with no dominant repeated terms detected. The overall topic appears broad.';
    }
    return `This page mainly discusses ${topic}. Frequent terms include ${keyTerms.slice(0, 3).join(', ')}.`;
  }

  const ranked = sentences
    .map((sentence, index) => ({
      sentence,
      index,
      score: scoreSentence(sentence, keyTerms),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, SUMMARY_SENTENCE_MAX)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.sentence);

  const selected = ranked.slice(0, 3);
  let summary = selected.join(' ');
  if (selected.length < 2) {
    const keyTermText = keyTerms.length ? ` Key terms include ${keyTerms.slice(0, 3).join(', ')}.` : '';
    summary = `${selected[0] || `This page mainly discusses ${topic}.`}${keyTermText}`;
  }

  return summary;
}

function buildPageSummary(pageText, metrics = {}) {
  const normalizedText = normalizePageText(pageText);
  const keyTerms = extractKeyTerms(normalizedText);
  const topic = identifyMainTopic(keyTerms);
  const summary = generateSummaryParagraph(normalizedText, keyTerms, topic);
  const pageSentiment = analyzePageSentiment(normalizedText);
  const pageHealthScore = calculatePageHealthScore({
    toxicityScore: metrics.toxicityScore,
    negativeSentiment: pageSentiment.negativePercentage,
    numberOfToxicSections: metrics.numberOfToxicSections,
  });

  return {
    topic,
    summary,
    keyTerms,
    pageSentiment,
    pageHealthScore,
  };
}

function buildSanitizedPageUpdate(payload, tabId, pageSummary) {
  return {
    tabId: tabId ?? null,
    url: payload.url || '',
    title: payload.title || '',
    capturedAt: payload.capturedAt || new Date().toISOString(),
    scrollSpeed: Number(payload.scrollSpeed || 0),
    timeSpentOnPageMs: Number(payload.timeSpentOnPageMs || 0),
    negativePostsSeen: Number(payload.negativePostsSeen || 0),
    continuousScrollMs: Number(payload.continuousScrollMs || 0),
    toxicPostsDetected: Number(payload.toxicPostsDetected || 0),
    scoredPostCount: Number(payload.scoredPostCount || 0),
    averageToxicity: Number(payload.averageToxicity || 0),
    toxicPostFrequency: Number(payload.toxicPostFrequency || 0),
    feedToxicityScore: Number(payload.feedToxicityScore || 0),
    feedHealthScore: Number(payload.feedHealthScore || 100),
    negativeSentiment: Number(payload.negativeSentiment || 0),
    toxicWordCount: Number(payload.toxicWordCount || 0),
    detectedWords: Array.isArray(payload.detectedWords) ? payload.detectedWords : [],
    pageSummary,
  };
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('MV3 Starter Extension installed.');
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return;
  }

  if (message.type === 'PAGE_TEXT_UPDATE') {
    const payload = message.payload || {};
    const tabId = sender.tab?.id;

    (async () => {
      try {
        const local = await chrome.storage.local.get([DAILY_STATS_KEY, TAB_STATE_KEY]);
        const pageSummary = buildPageSummary(payload.collectedText || '', {
          toxicityScore: Number(payload.feedToxicityScore || payload.averageToxicity || 0),
          numberOfToxicSections: Number(payload.toxicPostsDetected || 0),
        });
        const sanitizedPageUpdate = buildSanitizedPageUpdate(payload, tabId, pageSummary);

        await chrome.storage.local.set({
          lastPageSummary: {
            ...pageSummary,
            url: payload.url || '',
            capturedAt: payload.capturedAt || new Date().toISOString(),
          },
          // Persist only derived analytics. Raw page text is never stored.
          lastPageTextUpdate: sanitizedPageUpdate,
        });

        const dailyStats = local[DAILY_STATS_KEY] || {};
        const tabState = local[TAB_STATE_KEY] || {};

        const dayKey = getDayKey(payload.capturedAt);
        const dayStats = {
          ...getDefaultDayStats(),
          ...(dailyStats[dayKey] || {}),
        };

        const nowMs = Date.parse(payload.capturedAt || new Date().toISOString());
        const previousTab = tabId != null ? tabState[tabId] : null;

        let doomIncrementMs = 0;
        if (previousTab && Number.isFinite(nowMs) && Number.isFinite(previousTab.lastCapturedAtMs)) {
          const deltaMs = clamp(nowMs - previousTab.lastCapturedAtMs, 0, MAX_DELTA_MS);
          const isDoomscrollingNow = Number(payload.negativePostsSeen || 0) > 0 && Number(payload.scrollSpeed || 0) > 0;
          if (isDoomscrollingNow) {
            doomIncrementMs = deltaMs;
          }
        }

        let toxicIncrement = 0;
        if (previousTab && previousTab.url === payload.url) {
          toxicIncrement = Math.max(0, Number(payload.toxicPostsDetected || 0) - Number(previousTab.toxicPostsDetected || 0));
        } else {
          toxicIncrement = Math.max(0, Number(payload.toxicPostsDetected || 0));
        }

        dayStats.toxicPostsDetected += toxicIncrement;
        dayStats.doomscrollingMs += doomIncrementMs;

        const feedHealth = clamp(Number(payload.feedHealthScore || 100), 0, 100);
        dayStats.feedHealthScoreSum += feedHealth;
        dayStats.feedHealthSamples += 1;
        dayStats.dailyFeedHealthScore = Math.round(dayStats.feedHealthScoreSum / Math.max(1, dayStats.feedHealthSamples));
        dayStats.updatedAt = new Date().toISOString();

        dailyStats[dayKey] = dayStats;

        if (tabId != null) {
          tabState[tabId] = {
            url: payload.url || '',
            toxicPostsDetected: Number(payload.toxicPostsDetected || 0),
            lastCapturedAtMs: Number.isFinite(nowMs) ? nowMs : Date.now(),
          };
        }

        await chrome.storage.local.set({
          [DAILY_STATS_KEY]: dailyStats,
          [TAB_STATE_KEY]: tabState,
        });
      } catch (error) {
        console.warn('Failed to process PAGE_TEXT_UPDATE:', error);
      }
    })();

    return;
  }

  if (message.type === 'DOOMSCROLL_WARNING') {
    const warning = {
      ...message.payload,
      tabId: sender.tab?.id ?? null,
      warningCapturedAt: new Date().toISOString(),
    };

    chrome.storage.local
      .set({ lastDoomscrollWarning: warning })
      .catch(() => {
        // Ignore storage errors.
      });

    console.warn('Doomscroll warning triggered:', warning);
    sendResponse({ ok: true });
  }
});
