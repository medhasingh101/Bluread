const toxicPostsEl = document.getElementById('toxicPostsValue');
const protectionToggleEl = document.getElementById('protectionToggle');
const protectionStateTextEl = document.getElementById('protectionStateText');
const sentimentModeEl = document.getElementById('sentimentMode');
const blurNegativeToggleEl = document.getElementById('blurNegativeToggle');
const blurPositiveToggleEl = document.getElementById('blurPositiveToggle');
const doomscrollTimeEl = document.getElementById('doomscrollTimeValue');
const feedHealthEl = document.getElementById('feedHealthValue');
const feedHealthFillEl = document.getElementById('feedHealthFill');
const emotionNeedleWrapEl = document.getElementById('emotionNeedleWrap');
const emotionStateEl = document.getElementById('emotionState');
const summaryTopicEl = document.getElementById('summaryTopic');
const summaryTextEl = document.getElementById('summaryText');
const keyTermsEl = document.getElementById('keyTerms');
const pageHealthScoreValueEl = document.getElementById('pageHealthScoreValue');
const pageHealthFillEl = document.getElementById('pageHealthFill');
const toxicWordCountTextEl = document.getElementById('toxicWordCountText');
const toxicWordsListEl = document.getElementById('toxicWordsList');
const sentimentBreakdownTextEl = document.getElementById('sentimentBreakdownText');
const updatedAtEl = document.getElementById('updatedAt');
const todayLabelEl = document.getElementById('todayLabel');

const DEFAULT_SENTIMENT_PREFS = {
  mode: 'balanced',
  blurNegative: true,
  blurPositive: false,
};

function getTodayKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDuration(ms) {
  const safeMs = Math.max(0, Number(ms) || 0);
  const totalSeconds = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${minutes}m ${seconds}s`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function setProtectionUI(enabled) {
  const isEnabled = Boolean(enabled);
  protectionToggleEl.checked = isEnabled;
  protectionStateTextEl.textContent = isEnabled ? 'Protection is ON' : 'Protection is OFF';
}

function setSentimentPrefsUI(prefs) {
  const merged = { ...DEFAULT_SENTIMENT_PREFS, ...(prefs || {}) };
  sentimentModeEl.value = merged.mode;
  blurNegativeToggleEl.checked = Boolean(merged.blurNegative);
  blurPositiveToggleEl.checked = Boolean(merged.blurPositive);
}

async function ensureDefaults() {
  const { protectionEnabled, sentimentPreferences } = await chrome.storage.local.get([
    'protectionEnabled',
    'sentimentPreferences',
  ]);

  if (typeof protectionEnabled !== 'boolean') {
    await chrome.storage.local.set({ protectionEnabled: true });
    setProtectionUI(true);
  } else {
    setProtectionUI(protectionEnabled);
  }

  if (!sentimentPreferences || typeof sentimentPreferences !== 'object') {
    await chrome.storage.local.set({ sentimentPreferences: DEFAULT_SENTIMENT_PREFS });
    setSentimentPrefsUI(DEFAULT_SENTIMENT_PREFS);
  } else {
    setSentimentPrefsUI(sentimentPreferences);
  }
}

function paintHealth(score, valueEl, fillEl) {
  const safeScore = clamp(Number(score) || 0, 0, 100);
  valueEl.textContent = String(Math.round(safeScore));
  fillEl.style.width = `${safeScore}%`;

  if (safeScore >= 70) {
    fillEl.style.background = '#22c55e';
  } else if (safeScore >= 40) {
    fillEl.style.background = '#f59e0b';
  } else {
    fillEl.style.background = '#ef4444';
  }
}

function getEmotionState(stressScore) {
  if (stressScore < 25) {
    return 'Calm';
  }
  if (stressScore < 50) {
    return 'Neutral';
  }
  if (stressScore < 75) {
    return 'Toxic';
  }
  return 'High Stress';
}

function paintEmotionMeter(feedHealthScore) {
  const safeHealth = clamp(Number(feedHealthScore) || 0, 0, 100);
  const stressScore = 100 - safeHealth;
  const angle = -90 + (stressScore / 100) * 180;
  emotionNeedleWrapEl.style.transform = `translateX(-50%) rotate(${angle}deg)`;
  emotionStateEl.textContent = getEmotionState(stressScore);
}

function renderChips(containerEl, values, chipClass = 'term-chip') {
  containerEl.innerHTML = '';
  for (const value of values) {
    const chip = document.createElement('span');
    chip.className = chipClass;
    chip.textContent = value;
    containerEl.appendChild(chip);
  }
}

function renderSummary(pageSummary) {
  if (!pageSummary) {
    summaryTopicEl.textContent = 'Topic: N/A';
    summaryTextEl.textContent = 'No summary available yet.';
    keyTermsEl.innerHTML = '';
    return;
  }

  summaryTopicEl.textContent = `Topic: ${pageSummary.topic || 'General webpage content'}`;
  summaryTextEl.textContent = pageSummary.summary || 'No summary available yet.';
  const terms = Array.isArray(pageSummary.keyTerms) ? pageSummary.keyTerms.slice(0, 6) : [];
  renderChips(keyTermsEl, terms);
}

function renderPageHealth(pageSummary) {
  const score = Number(pageSummary?.pageHealthScore ?? 100);
  paintHealth(score, pageHealthScoreValueEl, pageHealthFillEl);
}

function renderToxicWords(lastPageTextUpdate) {
  const count = Number(lastPageTextUpdate?.toxicWordCount || 0);
  const words = Array.isArray(lastPageTextUpdate?.detectedWords) ? lastPageTextUpdate.detectedWords.slice(0, 8) : [];

  toxicWordCountTextEl.textContent = `${count} words detected`;
  renderChips(toxicWordsListEl, words);
}

function renderSentiment(pageSummary, lastPageTextUpdate, sentimentPreferences) {
  const sentiment = pageSummary?.pageSentiment;

  const positive = Number(sentiment?.positivePercentage || 0);
  const neutral = Number(sentiment?.neutralPercentage ?? 100);
  const negativeSource = sentiment?.negativePercentage ?? lastPageTextUpdate?.negativeSentiment ?? 0;
  const negative = Number(negativeSource);
  const modeLabel = sentimentPreferences?.mode || DEFAULT_SENTIMENT_PREFS.mode;

  sentimentBreakdownTextEl.textContent = `Mode ${modeLabel} • Positive ${positive}% • Neutral ${neutral}% • Negative ${negative}%`;
}

function renderDailyStats(todayStats) {
  if (!todayStats) {
    toxicPostsEl.textContent = '0';
    doomscrollTimeEl.textContent = '0m 0s';
    paintHealth(100, feedHealthEl, feedHealthFillEl);
    paintEmotionMeter(100);
    return;
  }

  toxicPostsEl.textContent = String(todayStats.toxicPostsDetected || 0);
  doomscrollTimeEl.textContent = formatDuration(todayStats.doomscrollingMs || 0);
  const dailyScore = todayStats.dailyFeedHealthScore || 100;
  paintHealth(dailyScore, feedHealthEl, feedHealthFillEl);
  paintEmotionMeter(dailyScore);
}

async function renderDashboard() {
  const todayKey = getTodayKey();
  todayLabelEl.textContent = `Today (${todayKey})`;

  const {
    dashboardDailyStats = {},
    lastPageSummary = null,
    lastPageTextUpdate = null,
    protectionEnabled = true,
    sentimentPreferences = DEFAULT_SENTIMENT_PREFS,
  } = await chrome.storage.local.get([
    'dashboardDailyStats',
    'lastPageSummary',
    'lastPageTextUpdate',
    'protectionEnabled',
    'sentimentPreferences',
  ]);

  const todayStats = dashboardDailyStats[todayKey];

  renderDailyStats(todayStats);
  renderSummary(lastPageSummary);
  renderPageHealth(lastPageSummary);
  renderToxicWords(lastPageTextUpdate);
  renderSentiment(lastPageSummary, lastPageTextUpdate, sentimentPreferences);
  setProtectionUI(protectionEnabled);
  setSentimentPrefsUI(sentimentPreferences);

  if (lastPageSummary?.capturedAt) {
    const updated = new Date(lastPageSummary.capturedAt);
    updatedAtEl.textContent = `Updated ${updated.toLocaleTimeString()}`;
  } else if (todayStats?.updatedAt) {
    const updated = new Date(todayStats.updatedAt);
    updatedAtEl.textContent = `Updated ${updated.toLocaleTimeString()}`;
  } else {
    updatedAtEl.textContent = 'No data collected yet today.';
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') {
    return;
  }

  if (changes.protectionEnabled) {
    setProtectionUI(changes.protectionEnabled.newValue !== false);
  }

  if (changes.sentimentPreferences) {
    setSentimentPrefsUI(changes.sentimentPreferences.newValue);
  }

  if (changes.lastPageSummary || changes.lastPageTextUpdate || changes.dashboardDailyStats || changes.protectionEnabled || changes.sentimentPreferences) {
    renderDashboard();
  }
});

protectionToggleEl.addEventListener('change', () => {
  const enabled = protectionToggleEl.checked;
  chrome.storage.local.set({ protectionEnabled: enabled });
});

function saveSentimentPrefs() {
  const prefs = {
    mode: sentimentModeEl.value,
    blurNegative: blurNegativeToggleEl.checked,
    blurPositive: blurPositiveToggleEl.checked,
  };

  chrome.storage.local.set({ sentimentPreferences: prefs });
}

sentimentModeEl.addEventListener('change', saveSentimentPrefs);
blurNegativeToggleEl.addEventListener('change', saveSentimentPrefs);
blurPositiveToggleEl.addEventListener('change', saveSentimentPrefs);

(async () => {
  await ensureDefaults();
  await renderDashboard();
})();
