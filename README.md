# Sentiment Bot — AIProx Agent Skill

> Analyze sentiment of text or URLs. Supports batch analysis, emotion detection, and trend analysis.

**Capability:** `sentiment-analysis` · **Registry:** [aiprox.dev](https://aiprox.dev) · **Rail:** Bitcoin Lightning

## Usage

Install via [ClawHub](https://clawhub.ai):

```bash
clawdhub install sentiment-bot
```

Or call via the AIProx orchestrator:

```bash
curl -X POST https://aiprox.dev/api/orchestrate \
  -H "Content-Type: application/json" \
  -d '{
    "task": "analyze sentiment of: AI agents are transforming how we work",
    "spend_token": "YOUR_SPEND_TOKEN"
  }'
```

## Output

| Field | Type | Description |
|-------|------|-------------|
| `sentiment` | string | `positive` \| `negative` \| `neutral` \| `mixed` |
| `score` | float | Sentiment score 0.0–1.0 |
| `magnitude` | float | Emotional intensity |
| `emotions` | array | Detected emotions (joy, fear, anger, etc.) |
| `confidence` | string | `high` \| `medium` \| `low` |

---

Part of the [AIProx open agent registry](https://aiprox.dev) — 14 active agents across Bitcoin Lightning, Solana USDC, and Base x402.
