/**
 * SafeView — Twelve Labs backend
 * Indexes a video from URL, then analyzes it for keyword match and returns
 * trigger words + AI summary. Used by the extension when a public video URL is available.
 * See: https://github.com/mrnkim/generate-social-posts
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const TWELVE_LABS_API_KEY = process.env.TWELVE_LABS_API_KEY;
const TWELVE_LABS_INDEX_ID = process.env.TWELVE_LABS_INDEX_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const API_BASE = 'https://api.twelvelabs.io/v1.3';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
const PORT = process.env.PORT || 4001;
const INDEX_WAIT_MS = 90000;  // max wait for indexing (90s)
const POLL_INTERVAL_MS = 3000;

const app = express();
app.use(cors());
app.use(express.json());

const headers = {
  'Content-Type': 'application/json',
  'x-api-key': TWELVE_LABS_API_KEY,
  'Accept': 'application/json',
};

/** Create indexing task from video URL (Twelve Labs expects multipart/form-data) */
async function createTask(videoUrl) {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('index_id', TWELVE_LABS_INDEX_ID);
  form.append('video_url', videoUrl);
  const res = await axios.post(`${API_BASE}/tasks`, form, {
    headers: {
      'x-api-key': TWELVE_LABS_API_KEY,
      'Accept': 'application/json',
      ...form.getHeaders(),
    },
  });
  return res.data;
}

/** Poll task until ready or timeout */
async function waitForTask(taskId) {
  const deadline = Date.now() + INDEX_WAIT_MS;
  while (Date.now() < deadline) {
    const res = await axios.get(`${API_BASE}/tasks/${taskId}`, { headers });
    const status = res.data?.status;
    if (status === 'ready') return res.data.video_id || res.data.video?.id;
    if (status === 'failed') throw new Error(res.data?.message || 'Indexing failed');
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error('Indexing timeout');
}

/** Analyze video with prompt; return text */
async function analyzeVideo(videoId, prompt) {
  const res = await axios.post(
    `${API_BASE}/analyze`,
    {
      video_id: videoId,
      prompt,
      temperature: 0.2,
      stream: false,
    },
    { headers }
  );
  return res.data?.data?.trim() || '';
}

/** Parse trigger words and summary from model response (may be JSON or prose) */
function parseAnalyzeResponse(text, keywords) {
  const trigger_words = [];
  let summary = '';
  let has_match = false;
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const obj = JSON.parse(jsonMatch[0]);
      has_match = Boolean(obj.has_match ?? obj.flagged);
      if (Array.isArray(obj.trigger_words)) trigger_words.push(...obj.trigger_words);
      else if (Array.isArray(obj.reasons)) trigger_words.push(...obj.reasons);
      if (typeof obj.summary === 'string') summary = obj.summary;
    }
  } catch (e) {
    summary = text.slice(0, 500);
    keywords.forEach(k => {
      if (text.toLowerCase().includes(String(k).toLowerCase())) trigger_words.push(k);
    });
    has_match = trigger_words.length > 0;
  }
  return { has_match, trigger_words, summary };
}

/** Call Gemini to analyze a single image (frame); same logic as extension. */
async function analyzeImageWithGemini(imageBase64, mimeType, keywords = [], postText = '') {
  const topicList = Array.isArray(keywords) ? keywords : [];
  const topicsInstruction = topicList.length > 0
    ? `\nIMPORTANT - User keywords/topics to blur: ${JSON.stringify(topicList)}.\nIf this image or video frame is ABOUT or shows ANY of these, you MUST set category to "Custom" and sensitivity to 7 or higher. Add a "reasons" array.`
    : '';
  const postTextInstruction = postText && topicList.length > 0
    ? `\nPost/caption text from the page: "${(postText || '').slice(0, 500).replace(/"/g, '\\"')}"\nIf this text mentions any of the user's keywords above, set category to "Custom" and sensitivity 7+.`
    : '';
  const responseFormat = topicList.length > 0
    ? '{"sensitivity": <0-10>, "category": "<Violence|Self-Harm|Sexual Content|Hate Speech|Harassment|Graphic|Custom|None>", "summary": "<short sentence>", "reasons": ["<reason1>"]}'
    : '{"sensitivity": <0-10>, "category": "<Violence|Self-Harm|Sexual Content|Hate Speech|Harassment|Graphic|None>", "summary": "<short sentence>"}';
  const prompt = `You are a content safety classifier. Look at this image/frame from a social media video or post. Respond in exactly this JSON format (no other text): ${responseFormat}
Rules: sensitivity 0 = safe, 10 = highly distressing. If the image shows violence, gore, self-harm, sexual content, or other harmful content, set the appropriate category and sensitivity to 6 or higher. If safe/neutral and no user topic match, use category "None" and sensitivity 0-2.${topicsInstruction}${postTextInstruction}`;

  const res = await axios.post(
    `${GEMINI_URL}?key=${GEMINI_API_KEY}`,
    {
      contents: [{
        role: 'user',
        parts: [
          { text: prompt },
          { inlineData: { mimeType: mimeType || 'image/jpeg', data: imageBase64 } },
        ],
      }],
      generationConfig: { maxOutputTokens: 320, temperature: 0.2 },
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
  );
  const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  const obj = jsonMatch ? (() => { try { return JSON.parse(jsonMatch[0]); } catch (e) { return {}; } })() : {};
  const sensitivity = Number(obj.sensitivity) || 0;
  const rawCategory = (obj.category && String(obj.category).trim()) || 'Graphic';
  const category = rawCategory.toLowerCase() === 'none' ? 'None' : rawCategory;
  const summary = obj.summary || '';
  const reasons = Array.isArray(obj.reasons) ? obj.reasons.filter(r => typeof r === 'string') : [];
  const threshold = 5;
  const flagged = category !== 'None' && sensitivity >= threshold;
  const score = Math.min(100, sensitivity * 10);
  return { flagged, category, score, summary, reasons };
}

/** POST /analyze-image — analyze a single frame with Gemini (server's key; avoids extension quota).
 * Body: { image_base64: string, mime_type?: string, keywords?: string[], post_text?: string }
 * Returns: { flagged, category, score, summary, reasons }
 */
app.post('/analyze-image', async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(503).json({ error: 'Gemini not configured (GEMINI_API_KEY missing in .env)' });
  }
  const { image_base64, mime_type, keywords = [], post_text = '' } = req.body || {};
  if (!image_base64 || typeof image_base64 !== 'string') {
    return res.status(400).json({ error: 'image_base64 required' });
  }
  try {
    const result = await analyzeImageWithGemini(image_base64, mime_type || 'image/jpeg', keywords, post_text);
    res.json(result);
  } catch (err) {
    const status = err.response?.status || 500;
    const message = err.response?.data?.error?.message || err.message;
    res.status(status).json({ error: message, flagged: false });
  }
});

/** POST /analyze-video
 * Body: { video_url: string, keywords: string[] }
 * Returns: { flagged, trigger_words: string[], summary: string }
 */
app.post('/analyze-video', async (req, res) => {
  if (!TWELVE_LABS_API_KEY || !TWELVE_LABS_INDEX_ID) {
    return res.status(503).json({ error: 'Twelve Labs not configured (API key or index ID missing)' });
  }
  const { video_url, keywords = [] } = req.body || {};
  if (!video_url || typeof video_url !== 'string') {
    return res.status(400).json({ error: 'video_url required' });
  }
  const topicList = Array.isArray(keywords) ? keywords.filter(k => typeof k === 'string') : [];
  const prompt = topicList.length > 0
    ? `Analyze this video. Does it contain or discuss any of these topics? ${JSON.stringify(topicList)}. ` +
      `Respond with ONLY a JSON object (no other text): {"has_match": true or false, "trigger_words": ["word1", "word2"] (list which topics/keywords appear), "summary": "One short sentence describing the video content."}`
    : `Summarize this video in one short sentence. Respond with JSON: {"has_match": false, "trigger_words": [], "summary": "your summary"}`;

  try {
    const task = await createTask(video_url);
    const taskId = task._id || task.id;
    if (!taskId) throw new Error('No task ID returned');
    const videoId = await waitForTask(taskId);
    if (!videoId) throw new Error('No video_id after indexing');
    const text = await analyzeVideo(videoId, prompt);
    const { has_match, trigger_words, summary } = parseAnalyzeResponse(text, topicList);
    res.json({
      flagged: has_match,
      trigger_words,
      summary: summary || 'Video analyzed.',
    });
  } catch (err) {
    const status = err.response?.status || 500;
    const message = err.response?.data?.message || err.message;
    res.status(status).json({ error: message, flagged: false });
  }
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    twelve_labs: !!(TWELVE_LABS_API_KEY && TWELVE_LABS_INDEX_ID),
    gemini_image: !!GEMINI_API_KEY,
  });
});

app.listen(PORT, () => {
  console.log(`SafeView Twelve Labs server listening on port ${PORT}`);
});
