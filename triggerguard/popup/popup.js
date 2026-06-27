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

const CATEGORY_COLORS = {
  'Violence':       '#ef4444',
  'Self-Harm':      '#8b5cf6',
  'Sexual Content': '#f97316',
  'Hate Speech':    '#374151',
  'Harassment':     '#ec4899',
  'Custom':         '#6366f1',
};

/* ─── Views ───────────────────────────────────────────────────────────────── */

const viewHome     = document.getElementById('view-home');
const viewSettings = document.getElementById('view-settings');

function showView(view) {
  viewHome.classList.remove('active');
  viewSettings.classList.remove('active');
  view.classList.add('active');
}

document.getElementById('btn-go-settings').addEventListener('click', () => showView(viewSettings));
document.getElementById('btn-go-settings-2').addEventListener('click', () => showView(viewSettings));
document.getElementById('btn-back').addEventListener('click', () => showView(viewHome));

/* ─── DOM refs — Home ─────────────────────────────────────────────────────── */

const statusBadge      = document.getElementById('status-badge');
const statusDot        = document.getElementById('status-dot');
const statusText       = document.getElementById('status-text');
const statBlurred      = document.getElementById('stat-blurred');
const statDetections   = document.getElementById('stat-detections');
const statCategories   = document.getElementById('stat-categories');
const statWords        = document.getElementById('stat-words');
const statTopics       = document.getElementById('stat-topics');
const detectionsListEl = document.getElementById('detections-list');
const btnScan          = document.getElementById('btn-scan');
const scanLabel        = document.getElementById('scan-label');

/* ─── DOM refs — Settings ─────────────────────────────────────────────────── */

const toggleEnabled    = document.getElementById('toggle-enabled');
const filterRows       = document.querySelectorAll('#filter-list .toggle-row');
const sensitivityInput = document.getElementById('sensitivity');
const sensitivityDisp  = document.getElementById('sensitivity-display');
const sliderFill       = document.getElementById('slider-fill');
const customWordInput  = document.getElementById('custom-word-input');
const addWordBtn       = document.getElementById('add-word-btn');
const wordTagsEl       = document.getElementById('word-tags');
const blurTopicInput   = document.getElementById('blur-topic-input');
const addTopicBtn      = document.getElementById('add-topic-btn');
const topicTagsEl      = document.getElementById('topic-tags');

/* ─── Tab helpers ─────────────────────────────────────────────────────────── */

function getActiveTab() {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => resolve(tabs[0] ?? null));
  });
}

async function sendToContent(message) {
  const tab = await getActiveTab();
  if (!tab) return null;
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tab.id, message, response => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(response);
    });
  });
}

/* ─── Settings persistence ────────────────────────────────────────────────── */

function readSettingsFromUI() {
  const categories = {};
  filterRows.forEach(row => {
    const key    = row.dataset.category;
    const toggle = row.querySelector('.toggle-switch');
    categories[key] = toggle.classList.contains('on');
  });
  return {
    enabled:     toggleEnabled.classList.contains('on'),
    sensitivity: Number(sensitivityInput.value),
    categories,
  };
}

function saveSettings() {
  chrome.storage.sync.set(readSettingsFromUI());
  updateStatusBadge();
  updateActiveFiltersCount();
}

/* ─── Toggle helper ───────────────────────────────────────────────────────── */

function setupToggle(btn, onChange) {
  btn.addEventListener('click', () => {
    btn.classList.toggle('on');
    btn.setAttribute('aria-checked', btn.classList.contains('on'));
    if (onChange) onChange();
  });
}

/* ─── Status badge ────────────────────────────────────────────────────────── */

function updateStatusBadge() {
  const on = toggleEnabled.classList.contains('on');
  statusBadge.className = `status-badge ${on ? 'status-badge--on' : 'status-badge--off'}`;
  statusDot.className   = `status-dot ${on ? 'status-dot--on' : 'status-dot--off'}`;
  statusText.textContent = on ? 'Protection Active' : 'Protection Off';
}

/* ─── Active filters count ────────────────────────────────────────────────── */

function updateActiveFiltersCount() {
  let count = 0;
  filterRows.forEach(row => {
    if (row.querySelector('.toggle-switch').classList.contains('on')) count++;
  });
  statCategories.textContent = count;
}

/* ─── Apply settings to UI ────────────────────────────────────────────────── */

function applyToUI(settings) {
  if (settings.enabled) toggleEnabled.classList.add('on');
  else toggleEnabled.classList.remove('on');
  toggleEnabled.setAttribute('aria-checked', String(settings.enabled));

  filterRows.forEach(row => {
    const key    = row.dataset.category;
    const toggle = row.querySelector('.toggle-switch');
    if (settings.categories[key]) {
      toggle.classList.add('on');
      toggle.setAttribute('aria-checked', 'true');
    } else {
      toggle.classList.remove('on');
      toggle.setAttribute('aria-checked', 'false');
    }
  });

  sensitivityInput.value      = settings.sensitivity;
  const pct = ((settings.sensitivity - 1) / 9) * 100;
  sensitivityDisp.textContent = `${Math.round(pct)}%`;
  sliderFill.style.width      = `${pct}%`;

  renderWordTags(settings.customWords || []);
  statWords.textContent = (settings.customWords || []).length;
  renderTopicTags(settings.blurTopics || []);
  statTopics.textContent = (settings.blurTopics || []).length;
  updateStatusBadge();
  updateActiveFiltersCount();
}

/* ─── Refresh stats from content ──────────────────────────────────────────── */

async function refreshStats() {
  const countResp = await sendToContent({ type: 'GET_COUNT' });
  statBlurred.textContent = countResp?.count ?? '0';

  const detectResp = await sendToContent({ type: 'GET_DETECTIONS' });
  const detections = detectResp?.detections ?? [];
  statDetections.textContent = detections.length;
  renderDetections(detections);
}

/* ─── Detections ──────────────────────────────────────────────────────────── */

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderDetections(detections) {
  if (!detections.length) {
    detectionsListEl.innerHTML = '<span class="detections-empty">No issues detected yet.</span>';
    return;
  }
  detectionsListEl.innerHTML = detections.map(d => {
    const color    = CATEGORY_COLORS[d.category] ?? '#78716c';
    const wordsStr = d.words.length
      ? d.words.map(w => escHtml(w)).join(', ')
      : '—';
    return `
      <div class="detection-row">
        <span class="detection-badge" style="background:${color};">${escHtml(d.category)}</span>
        <span class="detection-words">${wordsStr}</span>
        <span class="detection-score">${d.score}%</span>
      </div>`;
  }).join('');
}

/* ─── Custom words ────────────────────────────────────────────────────────── */

function renderWordTags(words) {
  if (!words.length) {
    wordTagsEl.innerHTML = '<span class="word-tags--empty">No custom words added yet.</span>';
    return;
  }
  wordTagsEl.innerHTML = words.map((w, i) => `
    <span class="word-tag">
      ${escHtml(w)}
      <button class="word-tag__x" data-index="${i}" aria-label="Remove">×</button>
    </span>
  `).join('');
  wordTagsEl.querySelectorAll('.word-tag__x').forEach(btn => {
    btn.addEventListener('click', () => removeWord(Number(btn.dataset.index)));
  });
}

function loadCustomWords(cb) {
  chrome.storage.sync.get({ customWords: [] }, stored => {
    cb(Array.isArray(stored.customWords) ? stored.customWords : []);
  });
}

function saveCustomWords(words) {
  chrome.storage.sync.set({ customWords: words });
  statWords.textContent = words.length;
}

function addWord() {
  const raw = customWordInput.value.trim();
  if (!raw) return;
  loadCustomWords(words => {
    if (words.map(w => w.toLowerCase()).includes(raw.toLowerCase())) {
      customWordInput.value = '';
      return;
    }
    const updated = [...words, raw];
    saveCustomWords(updated);
    renderWordTags(updated);
    customWordInput.value = '';
    customWordInput.focus();
  });
}

function removeWord(index) {
  loadCustomWords(words => {
    const updated = words.filter((_, i) => i !== index);
    saveCustomWords(updated);
    renderWordTags(updated);
  });
}

/* ─── Blur topics (videos & images) ────────────────────────────────────────── */

function renderTopicTags(topics) {
  if (!topics.length) {
    topicTagsEl.innerHTML = '<span class="word-tags--empty">No topics added yet.</span>';
    return;
  }
  topicTagsEl.innerHTML = topics.map((t, i) => `
    <span class="word-tag">
      ${escHtml(t)}
      <button class="word-tag__x" data-index="${i}" aria-label="Remove">×</button>
    </span>
  `).join('');
  topicTagsEl.querySelectorAll('.word-tag__x').forEach(btn => {
    btn.addEventListener('click', () => removeTopic(Number(btn.dataset.index)));
  });
}

function loadBlurTopics(cb) {
  chrome.storage.sync.get({ blurTopics: [] }, stored => {
    cb(Array.isArray(stored.blurTopics) ? stored.blurTopics : []);
  });
}

function saveBlurTopics(topics) {
  chrome.storage.sync.set({ blurTopics: topics });
  if (statTopics) statTopics.textContent = topics.length;
}

function addTopic() {
  const raw = blurTopicInput.value.trim();
  if (!raw) return;
  loadBlurTopics(topics => {
    if (topics.map(t => t.toLowerCase()).includes(raw.toLowerCase())) {
      blurTopicInput.value = '';
      return;
    }
    const updated = [...topics, raw];
    saveBlurTopics(updated);
    renderTopicTags(updated);
    blurTopicInput.value = '';
    blurTopicInput.focus();
  });
}

function removeTopic(index) {
  loadBlurTopics(topics => {
    const updated = topics.filter((_, i) => i !== index);
    saveBlurTopics(updated);
    renderTopicTags(updated);
  });
}

/* ─── Wire up events ──────────────────────────────────────────────────────── */

setupToggle(toggleEnabled, saveSettings);
filterRows.forEach(row => {
  setupToggle(row.querySelector('.toggle-switch'), saveSettings);
});

sensitivityInput.addEventListener('input', () => {
  const pct = ((sensitivityInput.value - 1) / 9) * 100;
  sensitivityDisp.textContent = `${Math.round(pct)}%`;
  sliderFill.style.width      = `${pct}%`;
  saveSettings();
});

addWordBtn.addEventListener('click', addWord);
customWordInput.addEventListener('keydown', e => { if (e.key === 'Enter') addWord(); });
addTopicBtn.addEventListener('click', addTopic);
blurTopicInput.addEventListener('keydown', e => { if (e.key === 'Enter') addTopic(); });

/* ─── Scan button ─────────────────────────────────────────────────────────── */

btnScan.addEventListener('click', async () => {
  scanLabel.textContent = 'Scanning…';
  btnScan.style.pointerEvents = 'none';
  btnScan.style.opacity = '.6';

  await sendToContent({ type: 'FORCE_SCAN' });
  await refreshStats();

  scanLabel.textContent = 'Scan This Page';
  btnScan.style.pointerEvents = '';
  btnScan.style.opacity = '';
});

/* ─── Init ────────────────────────────────────────────────────────────────── */

chrome.storage.sync.get(DEFAULTS, stored => {
  const settings = {
    ...DEFAULTS,
    ...stored,
    categories:  { ...DEFAULTS.categories,  ...stored.categories  },
    customWords: Array.isArray(stored.customWords) ? stored.customWords : [],
    blurTopics:  Array.isArray(stored.blurTopics) ? stored.blurTopics : [],
  };
  applyToUI(settings);
});

refreshStats();
