require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3016;
const LIGHTNINGPROX_URL = (process.env.LIGHTNINGPROX_URL || 'https://lightningprox.com') + '/v1/messages';
const AIPROX_REGISTER_URL = (process.env.AIPROX_URL || 'https://aiprox.dev') + '/api/agents/register';

// Strip HTML for URL-fetched content
function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchTextFromUrl(url) {
  console.log('[SENTIMENT-BOT] Fetching URL:', url);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SentimentBot/1.0)' }
  });
  if (!res.ok) throw new Error(`Failed to fetch URL: ${res.status}`);
  const html = await res.text();
  const text = stripHtml(html).slice(0, 20000);
  console.log('[SENTIMENT-BOT] Fetched text length:', text.length);
  return text;
}

// Detect analysis framing from task string
function detectTaskMode(task) {
  const t = (task || '').toLowerCase();
  if (/\bcompare\b|\bvs\b|\bversus\b/.test(t)) return 'comparative';
  if (/\btrend\b|\bover time\b|\bshift\b/.test(t)) return 'trend';
  return 'standard';
}

// Build context-aware system prompt
function buildPrompt(texts, context, taskMode, task) {
  const contextFraming = {
    social: 'This is social media content. Account for sarcasm, slang, abbreviations, and emoji.',
    news: 'This is news/journalistic content. Focus on tone, framing, and editorial sentiment.',
    review: 'This is a product or service review. Focus on satisfaction, recommendation likelihood, and specific praise/criticism.',
    general: 'Analyze the sentiment of this text objectively.'
  };

  const framing = contextFraming[context] || contextFraming.general;

  const taskNote = task ? `\nUser task: ${task}\n` : '';

  if (taskMode === 'comparative' && texts.length > 1) {
    const labeled = texts.map((t, i) => `[Text ${i + 1}]: ${t}`).join('\n\n');
    return `You are a sentiment analysis assistant. Compare the sentiment across the following texts.
${framing}${taskNote}
For each text and overall, respond in JSON format only:
{
  "results": [
    {
      "index": 0,
      "sentiment": "positive|negative|neutral|mixed",
      "score": <float 0-1, 1=most positive>,
      "magnitude": <float 0-1, strength of sentiment>,
      "emotions": ["joy", "anger", "fear", "sadness", "surprise", "disgust"],
      "reasoning": "brief explanation",
      "confidence": "high|medium|low"
    }
  ],
  "comparison": "brief comparative analysis across all texts",
  "dominant_sentiment": "positive|negative|neutral|mixed",
  "average_score": <float>
}

TEXTS:
${labeled}`;
  }

  if (taskMode === 'trend' && texts.length > 1) {
    const labeled = texts.map((t, i) => `[Entry ${i + 1}]: ${t}`).join('\n\n');
    return `You are a sentiment analysis assistant. Analyze sentiment trend across these entries (treat as chronological order).
${framing}${taskNote}
Respond in JSON format only:
{
  "results": [
    {
      "index": 0,
      "sentiment": "positive|negative|neutral|mixed",
      "score": <float 0-1>,
      "magnitude": <float 0-1>,
      "emotions": [],
      "reasoning": "brief explanation",
      "confidence": "high|medium|low"
    }
  ],
  "trend": "improving|declining|stable|volatile",
  "trend_summary": "brief description of how sentiment shifts across entries",
  "average_score": <float>
}

ENTRIES:
${labeled}`;
  }

  // Standard single or batch
  if (texts.length === 1) {
    return `You are a sentiment analysis assistant. ${framing}${taskNote}
Respond in JSON format only:
{
  "sentiment": "positive|negative|neutral|mixed",
  "score": <float 0-1, 1=most positive>,
  "magnitude": <float 0-1, 0=weak, 1=very strong>,
  "emotions": ["list of detected emotions, e.g. joy, anger, fear, sadness, surprise, disgust"],
  "reasoning": "1-2 sentence explanation of the sentiment",
  "confidence": "high|medium|low"
}

TEXT:
${texts[0]}`;
  }

  // Batch standard
  const labeled = texts.map((t, i) => `[Text ${i + 1}]: ${t}`).join('\n\n');
  return `You are a sentiment analysis assistant. Analyze each text independently.
${framing}${taskNote}
Respond in JSON format only:
{
  "results": [
    {
      "index": 0,
      "sentiment": "positive|negative|neutral|mixed",
      "score": <float 0-1>,
      "magnitude": <float 0-1>,
      "emotions": [],
      "reasoning": "brief explanation",
      "confidence": "high|medium|low"
    }
  ]
}

TEXTS:
${labeled}`;
}

// Call LightningProx
async function callClaude(prompt) {
  console.log('[DEBUG] Token:', process.env.LIGHTNINGPROX_TOKEN ? 'loaded' : 'MISSING');
  if (!process.env.LIGHTNINGPROX_TOKEN) throw new Error('LIGHTNINGPROX_TOKEN not set');

  console.log('[SENTIMENT-BOT] Calling LightningProx...');
  const res = await fetch(LIGHTNINGPROX_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Spend-Token': process.env.LIGHTNINGPROX_TOKEN
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  console.log('[SENTIMENT-BOT] LightningProx status:', res.status);
  const responseText = await res.text();
  console.log('[DEBUG] Response:', responseText.slice(0, 400));

  if (!res.ok) throw new Error(`LightningProx error: ${res.status} ${responseText}`);

  const data = JSON.parse(responseText);
  return data.content?.[0]?.text || '';
}

// Parse JSON from Claude response
function parseJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (e) {}
  }
  return null;
}

// Build batch summary from results array
function buildSummary(results) {
  if (!results.length) return { dominant_sentiment: 'unknown', average_score: 0, distribution: {} };
  const dist = { positive: 0, negative: 0, neutral: 0, mixed: 0 };
  let total = 0;
  for (const r of results) {
    const s = r.sentiment || 'neutral';
    if (s in dist) dist[s]++;
    total += r.score || 0;
  }
  const dominant = Object.entries(dist).sort((a, b) => b[1] - a[1])[0][0];
  return {
    dominant_sentiment: dominant,
    average_score: parseFloat((total / results.length).toFixed(3)),
    distribution: dist
  };
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'sentiment-bot' });
});

// Capabilities endpoint
app.get('/v1/capabilities', (req, res) => {
  res.json({
    capabilities: ['sentiment-analysis', 'batch-sentiment', 'emotion-detection', 'comparative-analysis', 'trend-analysis'],
    accepts: [
      'text (raw string)',
      'url (fetch and extract text)',
      'texts (array, up to 10, for batch mode)',
      'mode (optional): single (default) | batch',
      'context (optional): general (default) | social | news | review',
      'task (optional) — drives comparative or trend framing'
    ],
    returns: {
      single: ['sentiment', 'score', 'magnitude', 'emotions', 'reasoning', 'confidence', 'mode', 'context'],
      batch: ['results[]', 'summary: { dominant_sentiment, average_score, distribution }', 'mode', 'context'],
      comparative: ['results[]', 'comparison', 'dominant_sentiment', 'average_score'],
      trend: ['results[]', 'trend', 'trend_summary', 'average_score']
    }
  });
});

// Main task endpoint
app.post('/v1/task', async (req, res) => {
  const { task, text, url, texts, mode, context } = req.body;

  const resolvedContext = ['social', 'news', 'review', 'general'].includes(context) ? context : 'general';
  const taskMode = detectTaskMode(task);

  // Batch mode
  if (mode === 'batch' || Array.isArray(texts)) {
    const inputTexts = Array.isArray(texts) ? texts.slice(0, 10) : (text ? [text] : []);
    if (inputTexts.length === 0) {
      return res.status(400).json({ error: 'texts array or text is required for batch mode' });
    }

    console.log(`[SENTIMENT-BOT] Batch mode: ${inputTexts.length} texts, context: ${resolvedContext}, taskMode: ${taskMode}`);

    try {
      const prompt = buildPrompt(inputTexts, resolvedContext, taskMode, task);
      const raw = await callClaude(prompt);
      const parsed = parseJson(raw);

      if (parsed?.results) {
        const results = parsed.results.map((r, i) => ({
          index: i,
          sentiment: r.sentiment ?? 'neutral',
          score: r.score ?? 0.5,
          magnitude: r.magnitude ?? 0.5,
          emotions: Array.isArray(r.emotions) ? r.emotions : [],
          reasoning: r.reasoning ?? '',
          confidence: r.confidence ?? 'medium'
        }));

        const response = { results, mode: 'batch', context: resolvedContext };

        if (taskMode === 'comparative') {
          response.comparison = parsed.comparison ?? '';
          response.dominant_sentiment = parsed.dominant_sentiment ?? '';
          response.average_score = parsed.average_score ?? null;
          response.task_mode = 'comparative';
        } else if (taskMode === 'trend') {
          response.trend = parsed.trend ?? '';
          response.trend_summary = parsed.trend_summary ?? '';
          response.average_score = parsed.average_score ?? null;
          response.task_mode = 'trend';
        } else {
          response.summary = buildSummary(results);
        }

        console.log(`[SENTIMENT-BOT] Batch complete: ${results.length} results`);
        return res.json(response);
      }

      return res.json({ results: [], summary: buildSummary([]), mode: 'batch', context: resolvedContext });
    } catch (err) {
      console.error('[SENTIMENT-BOT ERROR]', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // Single mode
  let inputText = text;

  if (!inputText && url) {
    try {
      inputText = await fetchTextFromUrl(url);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  if (!inputText) {
    return res.status(400).json({ error: 'text or url is required' });
  }

  console.log(`[SENTIMENT-BOT] Single mode, context: ${resolvedContext}, text length: ${inputText.length}`);

  try {
    const prompt = buildPrompt([inputText], resolvedContext, 'standard', task);
    const raw = await callClaude(prompt);
    const parsed = parseJson(raw);

    if (parsed?.sentiment) {
      console.log(`[SENTIMENT-BOT] Analysis complete: ${parsed.sentiment} (${parsed.score})`);
      return res.json({
        sentiment: parsed.sentiment ?? 'neutral',
        score: parsed.score ?? 0.5,
        magnitude: parsed.magnitude ?? 0.5,
        emotions: Array.isArray(parsed.emotions) ? parsed.emotions : [],
        reasoning: parsed.reasoning ?? '',
        confidence: parsed.confidence ?? 'medium',
        mode: 'single',
        context: resolvedContext
      });
    }

    // Fallback
    return res.json({
      sentiment: 'neutral',
      score: 0.5,
      magnitude: 0,
      emotions: [],
      reasoning: raw,
      confidence: 'low',
      mode: 'single',
      context: resolvedContext
    });
  } catch (err) {
    console.error('[SENTIMENT-BOT ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Register with AIProx on startup
async function registerWithAIProx() {
  try {
    const endpoint = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
    const res = await fetch(AIPROX_REGISTER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: process.env.BOT_NAME || 'sentiment-bot',
        description: 'Sentiment analysis agent. Analyzes text or fetched URLs for sentiment, emotions, and tone. Supports batch processing (up to 10 texts), comparative and trend analysis, and context-aware framing for social, news, and review content.',
        capability: process.env.CAPABILITY || 'data-analysis',
        rail: 'bitcoin-lightning',
        endpoint: `${endpoint}/v1/task`,
        price_per_call: parseInt(process.env.PRICE_SATS || '15', 10),
        price_unit: 'sats'
      })
    });

    const data = await res.json();
    if (res.ok) {
      console.log('[REGISTER] Registered with AIProx:', data.name || 'sentiment-bot');
    } else {
      console.log('[REGISTER] AIProx response:', data.error || data.message || 'already registered');
    }
  } catch (err) {
    console.log('[REGISTER] Could not register with AIProx:', err.message);
  }
}

app.listen(PORT, () => {
  console.log(`[SENTIMENT-BOT] Running on port ${PORT}`);
  if (process.env.AUTO_REGISTER === 'true') {
    registerWithAIProx();
  }
});
