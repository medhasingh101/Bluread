// SafeView — API Keys Template
// Copy this file to config.js and fill in your keys.
// config.js is gitignored — never commit real keys.

const CONFIG = {
  OPENAI_API_KEY:    '',   // https://platform.openai.com/api-keys
  ANTHROPIC_API_KEY: '',   // https://console.anthropic.com/settings/keys
  // Video/image detection (Instagram Reels, X videos)
  GEMINI_API_KEY:    '',   // https://aistudio.google.com/app/apikey — multimodal frame analysis
  // Optional: local FastAPI backend for multi-model pipeline (PyTorch, OpenCV, etc.)
  // VIDEO_ANALYSIS_BACKEND_URL: 'http://localhost:8000',
  // Optional: Twelve Labs backend for full-video context analysis (run twelvelabs-server/)
  // TWELVE_LABS_BACKEND_URL: 'http://localhost:4001',
};
