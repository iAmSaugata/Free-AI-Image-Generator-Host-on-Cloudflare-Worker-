# 🎨 Free AI Image Generator (Cloudflare Worker)

A serverless, full-stack AI Image Generator running entirely on **Cloudflare Workers**. It utilizes **Cloudflare Workers AI** (Black Forest Labs Flux Models) for generation and **Cloudflare KV** for tracking daily neuron usage and enforcing limits.

## ✨ Features

* **Serverless Architecture:** Runs on Cloudflare Edge (Workers).
* **Dual Model Support:**
    * `Flux-2 Klein 4B` (High Quality, ~20 steps).
    * `Flux-1 Schnell` (Fast Generation, ~4 steps).
* **Precise Usage Tracking:** Real-time tracking of "Neurons" used per image, matched exactly to Cloudflare's billing calculation.
* **Daily Limit Enforcement:** Automatically blocks requests (HTTP 429) if the daily limit (default: 10,000 neurons) is exceeded.
* **Total Image Counter:** Tracks the total number of images generated across the lifetime of the database.
* **Secure API:** Protected via `X-API-KEY` header authentication.
* **Responsive UI:** Built-in Dark Mode HTML/JS interface with:
    * Real-time progress bars.
    * Countdown timer to UTC midnight reset.
    * "Photorealistic" prompt enhancer.
    * Custom dimension controls.
    * Direct download button.

---

## 🛠️ Prerequisites

1.  A **Cloudflare Account** (Free tier works, but AI usage limits apply).
2.  **Node.js** and **npm** installed locally.
3.  **Wrangler CLI** installed (`npm install -g wrangler`).

---

## 🚀 Setup & Deployment

### 1. Initialize Project
Create a new directory and initialize a Cloudflare Worker:
```bash
wrangler init ai-image-generator
# Select "Hello World" (ES module) when asked
cd ai-image-generator
```

### 2. Create KV Namespace
You need a KV database to store the usage stats. Run this command:
```bash
wrangler kv:namespace create "USAGE_DB"
```
*Copy the `id` output from this command. You will need it for step 3.*

### 3. Configure `wrangler.toml`
Replace the contents of your `wrangler.toml` file with the configuration below. **Replace `{YOUR_KV_ID_HERE}` with the ID you copied in Step 2.**

```toml
name = "ai-image-generator"
main = "src/index.js"
compatibility_date = "2024-09-23"

# Bind Workers AI
[ai]
binding = "AI"

# Bind KV Namespace for Stats
[[kv_namespaces]]
binding = "USAGE_DB"
id = "{YOUR_KV_ID_HERE}"
```

### 4. Set the API Key
Securely store your desired API key (password) using Wrangler secrets. Do not hardcode this in the file.
```bash
wrangler secret put API_KEY
# Enter your desired password when prompted (e.g., "super-secret-password")
```

### 5. Add the Application Code
Copy the provided **golden version** JavaScript code into `src/index.js`.

### 6. Deploy
Deploy your worker to the Cloudflare global network:
```bash
wrangler deploy
```
*You will receive a URL (e.g., `https://ai-image-generator.yourname.workers.dev`).*

---

## ⚙️ Configuration (Inside `src/index.js`)

You can modify these constants at the top of the `src/index.js` file to tune the application:

| Constant | Default | Description |
| :--- | :--- | :--- |
| `ENFORCE_AUTH` | `true` | Set to `false` to make the API public (not recommended). |
| `DAILY_LIMIT` | `10000` | The max Neurons allowed per day (matches CF Free Tier). |
| `MAX_SIZE` | `1280` | Maximum pixel width/height allowed. |
| `MODELS` | Object | Map of model names to Cloudflare Model IDs. |

---

## 🔌 API Documentation

You can use the backend programmatically without the UI.

**Base URL:** `https://<your-worker-url>/generate`
**Method:** `POST`
**Headers:**
* `Content-Type`: `application/json`
* `X-API-KEY`: `Your-Secret-Key`

### Request Body
```json
{
  "prompt": "A cyberpunk street at night, neon lights",
  "width": 1024,
  "height": 576,
  "model": "flux-2-klein-4b", 
  "photorealistic": true,
  "seed": 12345,
  "safety_tolerance": 2
}
```
* **model:** Options are `flux-2-klein-4b` or `flux-1-schnell`.
* **photorealistic:** If `true`, appends quality-boosting keywords to the prompt.
* **seed:** (Optional) Integer for reproducibility.
* **safety_tolerance:** (Optional) Integer 1-3.

### Response Example
```json
{
  "success": true,
  "modelUsed": "@cf/black-forest-labs/flux-2-klein-4b",
  "extension": "png",
  "costNeurons": 74.25,
  "imageData": "data:image/png;base64,iVBORw0KGgo..."
}
```

---

## 💰 Neuron Pricing Logic

This worker calculates cost exactly as Cloudflare documents to ensure your internal tracker matches the Cloudflare console.

1.  **Flux-1 Schnell:**
    * Cost = `(Steps * 9.6) + (Tiles * 4.8)`
    * *Note: Tiles are calculated as (Width * Height) / (512 * 512).*
2.  **Flux-2 Klein:**
    * Cost = `Tiles * 26.05`

---

## 🐛 Troubleshooting

**1. "Database Not Connected" Error in UI**
* **Cause:** The KV binding is missing or incorrect.
* **Fix:** Ensure your `wrangler.toml` has the correct `[[kv_namespaces]]` block and ID. Redeploy using `wrangler deploy`.

**2. 403 Unauthorized Error**
* **Cause:** Incorrect API Key.
* **Fix:** Ensure the key entered in the UI matches the one you set via `wrangler secret put API_KEY`.

**3. Stats not updating immediately**
* **Fix:** Ensure you are using the latest code version where `await env.USAGE_DB.put(...)` is used instead of `ctx.waitUntil`.

---

## 📜 License

This project is open-source.
**Footer:** TechnoChat.IN™ | © iAmSAugata
