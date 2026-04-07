# Free AI Image Generator — Host on Cloudflare Worker

A serverless, full-stack AI Image Generator running entirely on **Cloudflare Workers**. Uses **Cloudflare Workers AI** (Black Forest Labs Flux models) for generation and **Cloudflare KV** to track daily neuron usage and enforce limits — no external services required.

---

## Features

- **Three AI Models:**
  - `Flux-2 Klein 4B` — High quality, tile-based billing (default)
  - `Flux-2 Klein 9B` — Highest quality, megapixel-based billing (launched Jan 2026)
  - `Flux-1 Schnell` — Fastest generation, step + tile billing
- **100% Accurate Neuron Tracking:** Mirrors Cloudflare's exact billing formulas per model so your internal counter matches the Cloudflare console.
- **Daily Limit Enforcement:** Blocks requests with HTTP 429 once the neuron budget is exhausted. Resets at UTC midnight.
- **Live Cost Estimator:** UI shows estimated neuron cost for the selected model and dimensions before you generate.
- **Secure API:** `X-API-KEY` header authentication.
- **Built-in UI:** Dark mode responsive interface with:
  - Real-time neuron usage bar and countdown timer
  - Live cost estimate per model/dimension
  - Photorealistic prompt enhancer
  - Custom dimension controls (32px steps, 256–1280px)
  - One-click download button
- **Built-in API Docs:** In-app modal with full pricing table, parameter reference, and cURL examples.

---

## Prerequisites

1. A **Cloudflare account** (free tier works; AI neuron limits apply).
2. **Node.js** and **npm** installed locally.
3. **Wrangler CLI**: `npm install -g wrangler`

---

## Setup & Deployment

### 1. Create a new Worker project

```bash
wrangler init ai-image-generator
# Select "Hello World" (ES module) when prompted
cd ai-image-generator
```

### 2. Create a KV namespace for usage tracking

```bash
wrangler kv:namespace create "USAGE_DB"
```

Copy the `id` from the output — you need it in the next step.

### 3. Configure `wrangler.toml`

```toml
name = "ai-image-generator"
main = "src/index.js"
compatibility_date = "2024-09-23"

[ai]
binding = "AI"

[[kv_namespaces]]
binding = "USAGE_DB"
id = "YOUR_KV_ID_HERE"
```

### 4. Set the API key secret

```bash
wrangler secret put API_KEY
# Enter your desired password when prompted
```

### 5. Copy the worker code

Copy `ai-image-worker.js` into `src/index.js`.

### 6. Deploy

```bash
wrangler deploy
```

You'll receive a URL like `https://ai-image-generator.yourname.workers.dev`.

---

## Configuration

Edit these constants near the top of `src/index.js`:

| Constant | Default | Description |
|:---|:---|:---|
| `ENFORCE_AUTH` | `true` | Set to `false` to make the API public (not recommended). |
| `DAILY_LIMIT` | `10000` | Max neurons per day (matches Cloudflare free tier). |
| `MAX_SIZE` | `1280` | Maximum pixel width or height. |
| `MIN_SIZE` | `256` | Minimum pixel width or height. |
| `SIZE_STEP` | `32` | Dimensions must be multiples of this value. |
| `MODELS` | Object | Map of short names to full Cloudflare model IDs. |

---

## API Reference

**Endpoint:** `POST /generate`  
**Headers:** `Content-Type: application/json`, `X-API-KEY: <your-key>`

### Request body

```json
{
  "prompt": "A cyberpunk street at night, neon lights",
  "model": "flux-2-klein-4b",
  "width": 1024,
  "height": 576,
  "photorealistic": true,
  "seed": 42,
  "safety_tolerance": 2
}
```

| Field | Type | Default | Notes |
|:---|:---|:---|:---|
| `prompt` | string | — | **Required.** |
| `model` | string | `flux-2-klein-4b` | `flux-2-klein-4b` · `flux-2-klein-9b` · `flux-1-schnell` |
| `width` | integer | `768` | 256–1280, multiple of 32 |
| `height` | integer | `768` | 256–1280, multiple of 32 |
| `photorealistic` | boolean | `false` | Appends quality keywords to the prompt |
| `seed` | integer | random | Fixed seed for reproducible results |
| `safety_tolerance` | integer | — | `1` Strict · `2` Medium · `3` Loose |

### Response

```json
{
  "success": true,
  "modelUsed": "@cf/black-forest-labs/flux-2-klein-4b",
  "extension": "png",
  "costNeurons": 58.61,
  "imageData": "data:image/png;base64,iVBORw0KGgo..."
}
```

### Stats endpoint

`GET /stats` — Returns current daily usage (no auth required).

```json
{
  "neurons": 1842.30,
  "count": 18,
  "limit": 10000,
  "db_connected": true
}
```

---

## Neuron Pricing

Costs mirror [Cloudflare's official pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) exactly. 1 neuron ≈ $0.000011.

### Flux-1 Schnell

```
Cost = (steps × 9.6) + (tiles × 4.8)
```
- `tiles` = (width × height) / (512 × 512)
- Default steps = 4
- Example — 768×768: `(4 × 9.6) + (2.25 × 4.8)` = **49.2 neurons**

### Flux-2 Klein 4B

```
Cost = tiles × 26.05
```
- Example — 768×768: `2.25 × 26.05` = **~58.6 neurons**

### Flux-2 Klein 9B

```
Cost = (min(mp, 1) × 1363.64) + (max(0, mp − 1) × 181.82)
```
- `mp` = (width × height) / 1,000,000 (output megapixels)
- First megapixel: **1363.64 neurons/MP**
- Each additional megapixel: **181.82 neurons/MP**
- Example — 768×768 (0.59 MP): **~804 neurons**
- Example — 1024×1024 (1.0 MP): **1363.64 neurons**

> **Note:** The 9B model is significantly more expensive than 4B. At the default 10,000 neuron daily limit you'll get roughly 7–12 images at typical resolutions.

---

## Troubleshooting

**"Database Not Connected" in the UI**  
Ensure `wrangler.toml` has the correct `[[kv_namespaces]]` block and ID. Redeploy with `wrangler deploy`.

**403 Unauthorized**  
The key in the UI must match what you set via `wrangler secret put API_KEY`.

**HTTP 429 Daily Limit Reached**  
The neuron budget for today is exhausted. It resets at UTC midnight, or raise `DAILY_LIMIT` in `src/index.js`.

---

## License

MIT — open source. See `LICENSE`.  
**Footer:** TechnoChat.IN™ | © iAmSaugata
