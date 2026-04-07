export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ==================================================
    // 🛡️ CONFIGURATION
    // ==================================================
    const ENFORCE_AUTH = true;
    const MAX_SIZE = 1280;
    const MIN_SIZE = 256;
    const SIZE_STEP = 32;
    const DAILY_LIMIT = 10000; // Cloudflare Free Tier Limit

    const MODELS = {
      "default": "@cf/black-forest-labs/flux-2-klein-4b",
      "flux-2-klein-4b": "@cf/black-forest-labs/flux-2-klein-4b",
      "flux-2-klein-9b": "@cf/black-forest-labs/flux-2-klein-9b",
      "flux-1-schnell": "@cf/black-forest-labs/flux-1-schnell"
    };

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-API-KEY",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // ==================================================
    // 🧠 NEURON CALCULATOR — Exact Cloudflare Billing Rates
    // Source: developers.cloudflare.com/workers-ai/platform/pricing/
    // ==================================================
    function calculateCost(model, width, height, steps) {
      // tiles = number of 512×512 pixel blocks in output image
      // mp    = output megapixels (width × height / 1,000,000)
      const tiles = (width * height) / (512 * 512);
      const mp    = (width * height) / 1_000_000;

      if (model.includes("schnell")) {
        // Flux-1 Schnell: 9.6 neurons/step + 4.8 neurons/output tile
        const numSteps = steps || 4;
        return (numSteps * 9.6) + (tiles * 4.8);
      }
      else if (model.includes("9b")) {
        // Flux-2 Klein 9B: tiered megapixel billing
        //   First MP  → 1363.64 neurons/MP
        //   Extra MPs → 181.82 neurons/MP each
        const firstMp = Math.min(mp, 1);
        const extraMp = Math.max(0, mp - 1);
        return (firstMp * 1363.64) + (extraMp * 181.82);
      }
      else {
        // Flux-2 Klein 4B: 26.05 neurons per output 512×512 tile
        return tiles * 26.05;
      }
    }

    // Helper to get current usage safely
    async function getUsage() {
      if (!env.USAGE_DB) return { neurons: 0, count: 0 };
      const today = new Date().toISOString().split('T')[0];
      const val = await env.USAGE_DB.get("usage_stats", { type: "json" });
      if (val && val.date === today) {
        return { 
            neurons: val.neurons || 0,
            count: val.count || 0 
        };
      }
      return { neurons: 0, count: 0 };
    }

    // ==================================================
    // 📊 STATS ROUTE (GET /stats)
    // ==================================================
    if (request.method === "GET" && url.pathname === "/stats") {
      const usageData = await getUsage();
      return new Response(JSON.stringify({ 
        neurons: parseFloat(usageData.neurons.toFixed(2)), 
        count: usageData.count,
        limit: DAILY_LIMIT,
        db_connected: !!env.USAGE_DB
      }), { headers: { "Content-Type": "application/json" } });
    }

    // ==================================================
    // 🎨 UI ROUTE (GET /)
    // ==================================================
    if (request.method === "GET" && url.pathname === "/") {
      const usageData = await getUsage();
      return new Response(getHTML(usageData.neurons, usageData.count, DAILY_LIMIT, !!env.USAGE_DB), {
        headers: { "Content-Type": "text/html; charset=UTF-8" }
      });
    }

    // ==================================================
    // ⚡ IMAGE GENERATION API (POST /generate)
    // ==================================================
    if (request.method === "POST" && url.pathname === "/generate") {
      
      // 1. AUTH CHECK
      if (ENFORCE_AUTH) {
        const key = request.headers.get("X-API-KEY");
        if (!env.API_KEY) return new Response(JSON.stringify({ success: false, error: "Server configuration error: API_KEY missing." }), { status: 500, headers: corsHeaders });
        if (key !== env.API_KEY) return new Response(JSON.stringify({ success: false, error: "Unauthorized: Invalid API Key." }), { status: 403, headers: corsHeaders });
      }

      // 2. PARSE BODY
      let body;
      try { body = await request.json(); } 
      catch (e) { return new Response(JSON.stringify({ success: false, error: "Invalid JSON body." }), { status: 400, headers: corsHeaders }); }

      let { prompt, width, height, seed, safety_tolerance, photorealistic, model } = body;

      if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
        return new Response(JSON.stringify({ success: false, error: "Prompt is required." }), { status: 400, headers: corsHeaders });
      }

      // 3. MODEL SELECTION
      let selectedModel = MODELS[model] || MODELS["default"];
      const isFlux2 = selectedModel.includes("flux-2") || selectedModel.includes("klein");
      const steps = isFlux2 ? 20 : 4; 

      // 4. PROMPT ENGINEERING
      let finalPrompt = prompt.trim();
      if (photorealistic === true) finalPrompt += ", photorealistic, ultra-detailed, 8k, realistic texture, cinematic lighting";

      // 5. DIMENSIONS
      let safeWidth = Math.round((width || 768) / SIZE_STEP) * SIZE_STEP;
      let safeHeight = Math.round((height || 768) / SIZE_STEP) * SIZE_STEP;
      safeWidth = Math.min(Math.max(safeWidth, MIN_SIZE), MAX_SIZE);
      safeHeight = Math.min(Math.max(safeHeight, MIN_SIZE), MAX_SIZE);

      try {
        // --- 📊 CALCULATE COST & CHECK LIMIT ---
        const cost = calculateCost(selectedModel, safeWidth, safeHeight, steps);

        // 🛑 STRICT LIMIT ENFORCEMENT
        if (env.USAGE_DB) {
             const current = await getUsage();
             if (current.neurons + cost > DAILY_LIMIT) {
                 return new Response(JSON.stringify({ 
                     success: false, 
                     error: `Daily limit reached. Needed: ${cost.toFixed(2)}, Remaining: ${(DAILY_LIMIT - current.neurons).toFixed(2)}` 
                 }), { status: 429, headers: corsHeaders });
             }
        }

        // 🚀 EXECUTE AI MODEL
        let response;
        if (isFlux2) {
             const formData = new FormData();
             formData.append("prompt", finalPrompt);
             formData.append("width", safeWidth.toString());
             formData.append("height", safeHeight.toString());
             if (Number.isInteger(seed)) formData.append("seed", seed.toString());

             const formResponse = new Response(formData);
             const formStream = formResponse.body;
             const formContentType = formResponse.headers.get("Content-Type");

             response = await env.AI.run(selectedModel, {
               multipart: { body: formStream, contentType: formContentType }
             });

        } else {
             const inputs = {
               prompt: finalPrompt,
               num_steps: 4,
               width: safeWidth,
               height: safeHeight
             };
             if (Number.isInteger(seed)) inputs.seed = seed;
             if (safety_tolerance) inputs.safety_tolerance = parseInt(safety_tolerance);

             response = await env.AI.run(selectedModel, inputs);
        }

        // 📝 UPDATE STATS (SYNC WAIT TO ENSURE DATA CONSISTENCY)
        // We await this now so the client gets the updated stats immediately after
        if (env.USAGE_DB) { 
            const today = new Date().toISOString().split('T')[0];
            let currentData = await env.USAGE_DB.get("usage_stats", { type: "json" });
            
            if (!currentData || currentData.date !== today) {
                currentData = { date: today, neurons: 0, count: 0 };
            }
            
            currentData.neurons += cost;
            currentData.count = (currentData.count || 0) + 1;

            await env.USAGE_DB.put("usage_stats", JSON.stringify(currentData));
        }
        
        // 📦 RESULT PACKAGING
        let base64Data, fileExt;

        if (response.image) {
          base64Data = response.image;
          fileExt = "jpg";
        } 
        else if (response instanceof ReadableStream || response.body instanceof ReadableStream) {
           const reader = (response.body || response).getReader();
           let chunks = [];
           while(true) { const {done, value} = await reader.read(); if(done) break; chunks.push(value); }
           let combined = new Uint8Array(chunks.reduce((acc, val) => acc + val.length, 0));
           
           const chunkSize = 8192;
           let binary = '';
           for (let i = 0; i < combined.length; i += chunkSize) {
               binary += String.fromCharCode.apply(null, combined.subarray(i, i + chunkSize));
           }
           base64Data = btoa(binary);
           fileExt = "png";
        } else {
           throw new Error("Unknown AI model response format");
        }

        return new Response(JSON.stringify({
             success: true,
             modelUsed: selectedModel,
             extension: fileExt,
             costNeurons: parseFloat(cost.toFixed(2)),
             imageData: `data:image/${fileExt === 'jpg' ? 'jpeg' : 'png'};base64,${base64Data}`
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};

/* ==================================================
   🖥️ UI CODE
   ================================================== */
function getHTML(usageCount, imgCount, dailyLimit, dbConnected) {
  // 1. Header Icon
  const headerIconSVG = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='url(%23gradient)' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cdefs%3E%3ClinearGradient id='gradient' x1='0' y1='0' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%236366f1' /%3E%3Cstop offset='50%25' stop-color='%23a855f7' /%3E%3Cstop offset='100%25' stop-color='%23ec4899' /%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath d='m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z'/%3E%3Cpath d='M5 3v4'/%3E%3Cpath d='M9 3v4'/%3E%3Cpath d='M3 5h4'/%3E%3Cpath d='M3 9h4'/%3E%3C/svg%3E`;

  // 2. Favicon
  const faviconSVG = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 24 24' fill='none' stroke='%23a855f7' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.55 2.5 2.5 0 0 1 0-4.84 3 3 0 0 1 2.82-3.5 2.5 2.5 0 0 1 2.94-3A2.5 2.5 0 0 1 9.5 2Z'%3E%3C/path%3E%3Cpath d='M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.55 2.5 2.5 0 0 0 0-4.84 3 3 0 0 0-2.82-3.5 2.5 2.5 0 0 0-2.94-3A2.5 2.5 0 0 0 14.5 2Z'%3E%3C/path%3E%3C/svg%3E`;

  // 3. Simple Copy Icon
  const copyIconSVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;

  function generateSizeOptions() {
    let options = "";
    for(let i=256; i<=1280; i+=64) {
      const label = i + "px";
      const sel = (i===768) ? "selected" : "";
      options += `<option value="${i}" ${sel}>${label}</option>`;
    }
    return options;
  }

  // Calculate Percentage for Progress Bar (SSR)
  const pct = Math.min((usageCount / dailyLimit) * 100, 100).toFixed(1);
  const remaining = Math.max(dailyLimit - usageCount, 0).toFixed(2);
  const usedFormatted = parseFloat(usageCount).toFixed(2);

  // Status HTML with IDs for AJAX updates
  let statusHtml = "";
  if(dbConnected) {
      statusHtml = `
      <div class="usage-badge">
        <div class="usage-row">
          <span>Neurons Used: <strong id="usage-val">${usedFormatted}</strong></span>
          <span id="reset-timer" class="reset-timer">--:--:--</span>
        </div>
        <div class="usage-track">
          <div id="usage-bar" class="usage-fill" style="width:${pct}%"></div>
        </div>
        <div class="usage-bottom">
          <span>Images: <strong id="img-count">${imgCount || 0}</strong></span>
          <span>Remaining: <strong id="remain-val" class="${remaining < 1000 ? 'stat-warn' : 'stat-ok'}">${remaining}</strong></span>
        </div>
      </div>`;
  } else {
      statusHtml = `<div class="db-warn">⚠ KV database not connected — add USAGE_DB binding in wrangler.toml</div>`;
  }

  // WAF BYPASS
  const curlCmd = "curl"; 

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Image Generator</title>
<link rel="icon" type="image/svg+xml" href="${faviconSVG}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  /* ── DESIGN TOKENS — Light Theme ───────────────────── */
  :root {
    --bg:        #f0f2f8;
    --card:      #ffffff;
    --card2:     #f8f9fd;
    --border:    #dde1f0;
    --border-hi: #c5cae0;
    --accent:    #5558e8;
    --accent2:   #7c3aed;
    --accent3:   #db2777;
    --text:      #111827;
    --text-m:    #4b5568;
    --text-d:    #9ca3af;
    --in-bg:     #f5f6fa;
    --in-border: #ced3e8;
    --err-bg:    #fef2f2;
    --err-text:  #dc2626;
    --code-bg:   #f1f3f9;
    --code-text: #374151;
  }

  /* ── RESET ─────────────────────────────────────────── */
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { font-size: 16px; }

  /* ── BASE ──────────────────────────────────────────── */
  body {
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    background: var(--bg);
    background-image:
      radial-gradient(ellipse 110% 55% at 50% -5%, rgba(99,102,241,0.08) 0%, transparent 65%),
      radial-gradient(ellipse 60% 40% at 90% 110%, rgba(124,58,237,0.05) 0%, transparent 55%);
    color: var(--text);
    min-height: 100vh;
    padding: 32px 20px 48px;
    display: flex;
    flex-direction: column;
    align-items: center;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  /* ── SCROLLBAR ─────────────────────────────────────── */
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #c5cae0; border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: #a0a8c8; }

  /* ── LAYOUT ────────────────────────────────────────── */
  .app-container { width: 100%; max-width: 1140px; display: grid; gap: 18px; flex: 1; }
  @media(min-width: 820px) { .app-container { grid-template-columns: 370px 1fr; align-items: start; } }

  /* ── PANEL ─────────────────────────────────────────── */
  .panel {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 22px;
    padding: 28px 26px;
    position: relative;
    overflow: hidden;
    box-shadow: 0 2px 16px rgba(99,102,241,0.07), 0 1px 4px rgba(0,0,0,0.05);
  }
  .panel::after {
    content: '';
    position: absolute;
    top: 0; left: 10%; right: 10%;
    height: 2px;
    background: linear-gradient(90deg, transparent, rgba(85,88,232,0.35), rgba(124,58,237,0.35), rgba(219,39,119,0.18), transparent);
    pointer-events: none;
  }

  /* ── APP HEADER ────────────────────────────────────── */
  .app-header { text-align: center; margin-bottom: 24px; }
  .app-header h1 {
    font-size: 1.5rem; font-weight: 800; letter-spacing: -0.025em;
    display: flex; align-items: center; justify-content: center; gap: 10px;
    margin-bottom: 5px;
  }
  .title-text {
    background: linear-gradient(135deg, #818cf8 0%, #a78bfa 45%, #e879f9 100%);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
  }
  .app-subtitle { font-size: 0.73rem; color: var(--text-d); letter-spacing: 0.05em; font-weight: 500; text-transform: uppercase; }
  .icon-img { width: 26px; height: 26px; flex-shrink: 0; }

  /* ── USAGE BADGE ───────────────────────────────────── */
  .usage-badge {
    background: rgba(85,88,232,0.04);
    border: 1px solid rgba(85,88,232,0.15);
    border-radius: 14px; padding: 14px 16px; margin-bottom: 24px;
  }
  .usage-row {
    display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 8px; font-size: 0.8rem; color: var(--text-m);
  }
  .usage-row strong { color: var(--text); font-weight: 600; }
  .reset-timer { font-family: 'Courier New', monospace; font-size: 0.73rem; color: var(--text-d); letter-spacing: 0.04em; }
  .usage-track { width: 100%; height: 4px; background: rgba(0,0,0,0.08); border-radius: 2px; overflow: hidden; }
  .usage-fill { height: 100%; background: linear-gradient(90deg, #6366f1, #a78bfa, #ec4899); border-radius: 2px; transition: width 0.7s ease; box-shadow: 0 0 10px rgba(99,102,241,0.5); }
  .usage-bottom { display: flex; justify-content: space-between; margin-top: 7px; font-size: 0.72rem; color: var(--text-d); }
  .usage-bottom strong { font-weight: 600; }
  .stat-ok  { color: #34d399; }
  .stat-warn { color: #f87171; }
  .db-warn { font-size: 0.8rem; color: #dc2626; text-align: center; border: 1px solid rgba(220,38,38,0.2); border-radius: 10px; padding: 12px; margin-bottom: 20px; background: rgba(220,38,38,0.05); }

  /* ── FIELD ─────────────────────────────────────────── */
  .field { margin-top: 18px; }
  .field-label {
    display: block; font-size: 0.7rem; font-weight: 700;
    color: var(--text-m); margin-bottom: 7px;
    text-transform: uppercase; letter-spacing: 0.08em;
  }
  input, select, textarea {
    width: 100%; background: var(--in-bg);
    border: 1px solid var(--in-border);
    color: var(--text); padding: 11px 14px;
    border-radius: 11px; outline: none;
    font-family: inherit; font-size: 0.88rem;
    transition: border-color 0.2s, box-shadow 0.2s;
    -webkit-appearance: none; appearance: none;
  }
  select {
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='11' height='11' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2.5'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 13px center;
    padding-right: 36px;
    cursor: pointer;
  }
  textarea { resize: vertical; min-height: 82px; line-height: 1.55; }
  input:focus, select:focus, textarea:focus {
    border-color: rgba(99,102,241,0.55);
    box-shadow: 0 0 0 3px rgba(99,102,241,0.09);
  }
  input::placeholder, textarea::placeholder { color: var(--text-d); }

  /* ── MODEL + COST (main view) ──────────────────────── */
  .model-cost-row { display: flex; align-items: center; gap: 12px; margin-top: 8px; }
  .cost-card {
    flex-shrink: 0; min-width: 96px;
    background: linear-gradient(145deg, rgba(85,88,232,0.07), rgba(124,58,237,0.04));
    border: 1px solid rgba(85,88,232,0.2);
    border-radius: 11px; padding: 10px 12px; text-align: center;
  }
  .cost-card-label { font-size: 0.62rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-d); margin-bottom: 4px; }
  .cost-card-val   { font-size: 1.1rem; font-weight: 800; color: var(--accent); font-family: 'Courier New', monospace; line-height: 1; }
  .cost-card-unit  { font-size: 0.6rem; color: var(--text-m); margin-top: 3px; font-weight: 500; letter-spacing: 0.04em; }

  /* ── MODEL HINT ────────────────────────────────────── */
  #model-desc {
    font-size: 0.71rem; color: var(--text-m); margin-top: 7px;
    padding: 5px 10px; background: rgba(85,88,232,0.04);
    border-radius: 6px; border-left: 2px solid rgba(85,88,232,0.35);
    line-height: 1.5;
  }

  /* ── CUSTOM DIMS ───────────────────────────────────── */
  .dims-row { display: flex; gap: 10px; margin-top: 10px; }
  .dims-row > div { flex: 1; }

  /* ── ADVANCED SETTINGS ─────────────────────────────── */
  .adv-details { margin-top: 18px; border: 1px solid var(--border); border-radius: 13px; overflow: hidden; }
  .adv-summary {
    list-style: none; display: flex; align-items: center; justify-content: space-between;
    padding: 11px 16px; cursor: pointer; user-select: none;
    font-size: 0.78rem; font-weight: 600; color: var(--text-m);
    transition: color 0.2s, background 0.2s;
  }
  .adv-summary::-webkit-details-marker { display: none; }
  .adv-summary:hover { color: var(--text); background: rgba(0,0,0,0.02); }
  .adv-chevron { font-size: 0.65rem; transition: transform 0.2s; opacity: 0.5; }
  .adv-details[open] .adv-chevron { transform: rotate(180deg); }
  .adv-details[open] .adv-summary { border-bottom: 1px solid var(--border); color: var(--text); }
  .adv-body { padding: 16px; background: rgba(0,0,0,0.02); }
  .two-col { display: flex; gap: 12px; }
  .two-col > div { flex: 1; }

  /* ── CHECKBOX ──────────────────────────────────────── */
  .checkbox-row {
    display: flex; align-items: center; gap: 10px;
    margin-top: 14px; padding: 10px 13px;
    background: rgba(85,88,232,0.03);
    border: 1px solid var(--border); border-radius: 9px; cursor: pointer;
  }
  .checkbox-row input[type=checkbox] { width: 15px; height: 15px; accent-color: var(--accent); cursor: pointer; flex-shrink: 0; }
  .checkbox-row label { font-size: 0.82rem; color: var(--text-m); cursor: pointer; line-height: 1.4; }

  /* ── ERROR ─────────────────────────────────────────── */
  #error-box {
    display: none; margin-top: 16px;
    background: var(--err-bg); color: var(--err-text);
    border: 1px solid rgba(248,113,113,0.18);
    padding: 12px 14px; border-radius: 11px; font-size: 0.84rem; line-height: 1.5;
  }

  /* ── BUTTONS ───────────────────────────────────────── */
  .btn {
    width: 100%; border: none; padding: 13px 20px;
    border-radius: 12px; font-weight: 700; cursor: pointer;
    display: flex; justify-content: center; align-items: center; gap: 8px;
    margin-top: 16px; transition: all 0.22s; font-size: 0.9rem;
    font-family: inherit; letter-spacing: 0.01em;
  }
  .btn-primary {
    background: linear-gradient(135deg, #5a5cf0 0%, #7c4df0 55%, #9333ea 100%);
    color: #fff;
    box-shadow: 0 4px 22px rgba(99,102,241,0.32), inset 0 1px 0 rgba(255,255,255,0.12);
  }
  .btn-primary:hover:not(:disabled) {
    box-shadow: 0 6px 32px rgba(99,102,241,0.52), inset 0 1px 0 rgba(255,255,255,0.12);
    transform: translateY(-1px);
  }
  .btn-primary:active:not(:disabled) { transform: translateY(0); box-shadow: 0 3px 14px rgba(99,102,241,0.35); }
  .btn-primary:disabled { opacity: 0.45; cursor: not-allowed; transform: none !important; box-shadow: none !important; }
  .btn-secondary {
    background: transparent; color: var(--text-m);
    border: 1px solid var(--border); margin-top: 10px; font-size: 0.82rem; font-weight: 600;
  }
  .btn-secondary:hover { border-color: var(--border-hi); color: var(--text); background: rgba(255,255,255,0.025); }

  /* ── RESULT PANEL ──────────────────────────────────── */
  .result-area {
    min-height: 480px; display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    background: var(--card2);
    text-align: center; position: relative; padding: 32px;
  }
  .result-area::before {
    content: '';
    position: absolute; inset: 0; border-radius: inherit;
    background: radial-gradient(ellipse 70% 50% at 50% 50%, rgba(85,88,232,0.04) 0%, transparent 70%);
    pointer-events: none;
  }

  /* ── PLACEHOLDER ───────────────────────────────────── */
  .placeholder-wrap { display: flex; flex-direction: column; align-items: center; gap: 18px; }
  .placeholder-wrap p { font-size: 0.83rem; color: var(--text-d); letter-spacing: 0.02em; }

  /* ── RESULT IMAGE ──────────────────────────────────── */
  #resultImg { max-width: 100%; max-height: 68vh; border-radius: 10px; display: none; box-shadow: 0 12px 50px rgba(0,0,0,0.75); }

  /* ── LOADER ────────────────────────────────────────── */
  .loader {
    width: 42px; height: 42px; border-radius: 50%;
    border: 2px solid rgba(99,102,241,0.12);
    border-top-color: #7c6ef8;
    animation: spin 0.75s linear infinite; display: none;
    box-shadow: 0 0 24px rgba(99,102,241,0.18);
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── RESULT META ───────────────────────────────────── */
  .result-meta {
    margin-top: 15px; display: none;
    font-size: 0.73rem; font-family: 'Courier New', monospace;
    color: var(--text-m); background: var(--card);
    padding: 6px 18px; border-radius: 20px;
    border: 1px solid var(--border); text-align: center;
  }
  .meta-model { color: var(--accent2); } .meta-cost { color: #b45309; }

  /* ── DOWNLOAD ──────────────────────────────────────── */
  .dl-btn {
    display: none; margin-top: 15px; padding: 10px 28px;
    background: rgba(85,88,232,0.08); border-radius: 10px;
    color: var(--accent); text-decoration: none;
    border: 1px solid rgba(85,88,232,0.25); font-size: 0.84rem;
    font-weight: 600; transition: all 0.2s; font-family: inherit;
  }
  .dl-btn:hover { background: rgba(85,88,232,0.15); border-color: var(--accent); color: var(--accent2); transform: translateY(-1px); }

  /* ── FOOTER ────────────────────────────────────────── */
  footer {
    margin-top: 36px; text-align: center; color: var(--text-m);
    font-size: 0.78rem; border-top: 1px solid var(--border);
    width: 100%; max-width: 1140px;
    padding: 22px 0; letter-spacing: 0.02em;
  }
  footer a {
    color: var(--accent); text-decoration: none; font-weight: 600;
    transition: color 0.2s;
  }
  footer a:hover { color: var(--accent2); text-decoration: underline; }
  .footer-sep { color: var(--text-d); margin: 0 8px; }

  /* ── MODAL ─────────────────────────────────────────── */
  .modal-overlay {
    display: none; position: fixed; inset: 0;
    background: rgba(0,0,0,0.88); z-index: 1000;
    justify-content: center; align-items: center;
    backdrop-filter: blur(10px);
  }
  /* ── MODAL: DARK THEME (independent of page light theme) ── */
  .modal-content {
    background: #0f0f1a !important; width: 92%; max-width: 820px;
    max-height: 88vh; border-radius: 22px;
    border: 1px solid #252538; padding: 0;
    display: flex; flex-direction: column;
    box-shadow: 0 30px 90px rgba(0,0,0,0.85); overflow: hidden;
  }
  .modal-header {
    padding: 20px 26px; border-bottom: 1px solid #252538;
    display: flex; justify-content: space-between; align-items: center;
    background: rgba(99,102,241,0.08) !important;
  }
  .modal-header h3 { color: #e8e8f8; font-size: 1rem; font-weight: 700; letter-spacing: -0.01em; }
  .close-btn {
    background: rgba(255,255,255,0.07); border: 1px solid #2e2e48;
    color: #7878a0; width: 30px; height: 30px; border-radius: 8px;
    cursor: pointer; font-size: 1.1rem; display: flex; align-items: center;
    justify-content: center; transition: all 0.2s; line-height: 1;
  }
  .close-btn:hover { background: rgba(255,255,255,0.13); color: #e8e8f8; }
  .modal-body {
    padding: 24px 26px; overflow-y: auto;
    background: #0f0f1a !important;
    scrollbar-width: thin; scrollbar-color: #2a2a42 transparent;
  }
  .modal-body::-webkit-scrollbar { width: 5px; }
  .modal-body::-webkit-scrollbar-track { background: transparent; }
  .modal-body::-webkit-scrollbar-thumb { background: #2a2a42; border-radius: 3px; }
  .modal-body p { margin-bottom: 12px; font-size: 0.87rem; color: #8888aa; line-height: 1.6; }
  .modal-body a { color: #818cf8; text-decoration: none; }
  .modal-body a:hover { text-decoration: underline; color: #a78bfa; }
  .modal-body code { background: rgba(99,102,241,0.12); padding: 2px 7px; border-radius: 4px; color: #a5b4fc; font-family: 'Courier New', monospace; font-size: 0.83em; border: 1px solid rgba(99,102,241,0.2); }

  /* ── PRICING TABLE (dark) ──────────────────────────── */
  .pricing-table { width: 100%; border-collapse: collapse; margin: 10px 0 22px; font-size: 0.81rem; }
  .pricing-table th { background: rgba(255,255,255,0.04); color: #7878a0; text-align: left; padding: 9px 14px; font-weight: 700; border-bottom: 1px solid #22223a; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; }
  .pricing-table td { padding: 10px 14px; border-bottom: 1px solid #1e1e32; color: #8888aa; vertical-align: top; line-height: 1.5; }
  .pricing-table tr:last-child td { border-bottom: none; }
  .pricing-table td:first-child { color: #e8e8f8; font-weight: 600; white-space: nowrap; }
  .pricing-table .rate { color: #fbbf24; font-family: 'Courier New', monospace; font-size: 0.77rem; display: block; margin-top: 2px; }

  /* ── MODAL SECTION HEADINGS (dark) ────────────────── */
  .modal-section { font-size: 0.68rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em; color: #818cf8; margin: 24px 0 10px; padding-bottom: 7px; border-bottom: 1px solid #22223a; }

  /* ── PARAM LIST (dark) ─────────────────────────────── */
  .param-list { list-style: none; padding: 0; margin-bottom: 20px; }
  .param-list li { font-size: 0.86rem; color: #8888aa; padding: 8px 0; border-bottom: 1px solid #1e1e32; line-height: 1.55; }
  .param-list li:last-child { border-bottom: none; }
  .param-list strong { color: #a5b4fc; font-weight: 600; font-family: 'Courier New', monospace; font-size: 0.84em; }

  /* ── CODE BLOCKS (dark) ────────────────────────────── */
  .code-wrapper { position: relative; margin: 12px 0 18px; border: 1px solid #22223a; border-radius: 11px; overflow: hidden; background: #0d0d18; }
  .copy-btn { position: absolute; top: 9px; right: 9px; width: 29px; height: 29px; background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.08); color: #7878a0; border-radius: 7px; cursor: pointer; display: flex; justify-content: center; align-items: center; transition: all 0.2s; z-index: 10; }
  .copy-btn:hover { background: rgba(255,255,255,0.14); color: #e8e8f8; }
  pre { margin: 0; padding: 20px 22px; overflow-x: auto; }
  code.language-json, code.language-bash { font-family: 'Courier New', Consolas, monospace; font-size: 0.82rem; color: #c0c0d8; line-height: 1.6; }
  .key { color: #f9a8d4; } .str { color: #86efac; } .bool { color: #93c5fd; } .num { color: #fde047; } .comment { color: #404060; }
</style>
</head>
<body>

<div class="app-container">

  <!-- ── LEFT PANEL: CONTROLS ──────────────────────── -->
  <div class="panel">

    <div class="app-header">
      <h1>
        <span class="title-text">AI Image Generator</span>
        <img src="${headerIconSVG}" class="icon-img" alt="" />
      </h1>
    </div>

    ${statusHtml}

    <div class="field">
      <label class="field-label" for="apikey">API Key</label>
      <input type="password" id="apikey" placeholder="Enter your secret key" autocomplete="current-password" />
    </div>

    <div class="field">
      <label class="field-label" for="prompt">Prompt</label>
      <textarea id="prompt" rows="3" placeholder="Describe the image you want to create..."></textarea>
    </div>

    <!-- Model selector + live cost card in main view -->
    <div class="field">
      <label class="field-label" for="model">Model</label>
      <div class="model-cost-row">
        <select id="model" onchange="estimateCost()" style="flex:1; min-width:0;">
          <option value="flux-2-klein-4b" selected>Flux-2 Klein 4B — High Quality</option>
          <option value="flux-2-klein-9b">Flux-2 Klein 9B — Highest Quality</option>
          <option value="flux-1-schnell">Flux-1 Schnell — Fastest</option>
        </select>
        <div class="cost-card">
          <div class="cost-card-label">Est. Cost</div>
          <div class="cost-card-val" id="est-neurons">—</div>
          <div class="cost-card-unit">neurons</div>
        </div>
      </div>
      <div id="model-desc"></div>
    </div>

    <div class="field">
      <label class="field-label" for="aspectRatio">Dimensions</label>
      <select id="aspectRatio" onchange="updateDims(); estimateCost();">
        <option value="1:1" selected>1:1 &nbsp; Square &nbsp;(768 × 768)</option>
        <option value="16:9">16:9 &nbsp; Landscape &nbsp;(1152 × 640)</option>
        <option value="9:16">9:16 &nbsp; Portrait &nbsp;(640 × 1152)</option>
        <option value="21:9">21:9 &nbsp; Ultrawide &nbsp;(1280 × 576)</option>
        <option value="custom">Custom</option>
      </select>
    </div>

    <div id="dims" style="display:none;">
      <div class="dims-row">
        <div><label class="field-label">Width</label><select id="width" onchange="estimateCost()">${generateSizeOptions()}</select></div>
        <div><label class="field-label">Height</label><select id="height" onchange="estimateCost()">${generateSizeOptions()}</select></div>
      </div>
    </div>

    <details class="adv-details">
      <summary class="adv-summary">Advanced Settings <span class="adv-chevron">▾</span></summary>
      <div class="adv-body">
        <div class="two-col">
          <div>
            <label class="field-label" for="seed">Seed</label>
            <input type="number" id="seed" placeholder="Random" />
          </div>
          <div>
            <label class="field-label" for="safety">Safety</label>
            <select id="safety">
              <option value="">Default</option>
              <option value="1">1 — Strict</option>
              <option value="2">2 — Medium</option>
              <option value="3">3 — Loose</option>
            </select>
          </div>
        </div>
        <div class="checkbox-row" onclick="document.getElementById('photoreal').click()">
          <input type="checkbox" id="photoreal" onclick="event.stopPropagation()" />
          <label for="photoreal">Photorealistic Enhancer — appends quality keywords to prompt</label>
        </div>
      </div>
    </details>

    <div id="error-box"></div>

    <button class="btn btn-primary" onclick="generate()" id="genBtn">Generate Image</button>
    <button class="btn btn-secondary" onclick="openModal()">API Documentation &amp; Pricing</button>

  </div>

  <!-- ── RIGHT PANEL: RESULT ───────────────────────── -->
  <div class="panel result-area">
    <div id="placeholder" class="placeholder-wrap">
      <svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <defs>
          <linearGradient id="pg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#6366f1" stop-opacity="0.35"/>
            <stop offset="100%" stop-color="#ec4899" stop-opacity="0.25"/>
          </linearGradient>
        </defs>
        <rect x="3" y="3" width="18" height="18" rx="3" stroke="url(#pg)" stroke-width="1.1"/>
        <circle cx="8.5" cy="8.5" r="1.5" stroke="url(#pg)" stroke-width="1.1"/>
        <path d="m21 15-5-5L5 21" stroke="url(#pg)" stroke-width="1.1"/>
      </svg>
      <p>Your generated artwork will appear here</p>
    </div>
    <div class="loader" id="loader"></div>
    <img id="resultImg" />
    <div id="resultMeta" class="result-meta"></div>
    <a id="dlBtn" class="dl-btn" href="#" download="image.png">⤓ Download Image</a>
  </div>

</div>

<div id="api-modal" class="modal-overlay" onclick="closeModal(event)">
    <div class="modal-content">
        <div class="modal-header">
            <h3>API Documentation &amp; Pricing</h3>
            <button class="close-btn" onclick="closeModal(event, true)">×</button>
        </div>
        <div class="modal-body">
            <p>A stateless RESTful API for AI image generation. All requests require authentication via the <code>X-API-KEY</code> header.</p>

            <p class="modal-section">Neuron Pricing (Cloudflare Workers AI)</p>
            <p style="font-size:0.82rem; margin-bottom:10px;">Costs are calculated exactly per <a href="https://developers.cloudflare.com/workers-ai/platform/pricing/" target="_blank" style="color:var(--accent);">Cloudflare's official pricing</a>. 1 neuron ≈ $0.000011.</p>
            <table class="pricing-table">
              <thead><tr><th>Model</th><th>Billing Unit</th><th>Rate</th><th>Example (768×768)</th></tr></thead>
              <tbody>
                <tr>
                  <td>Flux-1 Schnell</td>
                  <td>Per step + per 512×512 tile</td>
                  <td><span class="rate">9.6 / step + 4.8 / tile</span></td>
                  <td><span class="rate">~49.2 neurons</span></td>
                </tr>
                <tr>
                  <td>Flux-2 Klein 4B</td>
                  <td>Per output 512×512 tile</td>
                  <td><span class="rate">26.05 / tile</span></td>
                  <td><span class="rate">~58.6 neurons</span></td>
                </tr>
                <tr>
                  <td>Flux-2 Klein 9B</td>
                  <td>Tiered per megapixel (MP)</td>
                  <td><span class="rate">1363.64 / first MP<br>181.82 / extra MP</span></td>
                  <td><span class="rate">~804.4 neurons</span></td>
                </tr>
              </tbody>
            </table>

            <p class="modal-section">Endpoint</p>
            <p><code>POST /generate</code> &nbsp;·&nbsp; <code>GET /stats</code></p>

            <p class="modal-section">Request Parameters</p>
            <ul class="param-list">
                <li><strong>prompt</strong> <span style="color:#fca5a5">(required)</span>: Text description of the image to generate.</li>
                <li><strong>model</strong>: <code>flux-2-klein-4b</code> (default) · <code>flux-2-klein-9b</code> · <code>flux-1-schnell</code></li>
                <li><strong>width</strong> / <strong>height</strong>: Integer 256–1280, must be a multiple of 32. Default: 768.</li>
                <li><strong>photorealistic</strong>: <code>true</code> / <code>false</code>. Appends quality-enhancing prompt keywords.</li>
                <li><strong>seed</strong>: Integer. Omit for a random seed. Use the same seed to reproduce an image.</li>
                <li><strong>safety_tolerance</strong>: <code>1</code> Strict · <code>2</code> Medium · <code>3</code> Loose.</li>
            </ul>

            <p class="modal-section">Request Example</p>
            <div class="code-wrapper">
                <button class="copy-btn" onclick="copyCode(this)" title="Copy Code">${copyIconSVG}</button>
<pre><code class="language-json">{
  <span class="key">"prompt"</span>: <span class="str">"A robot astronaut in a neon flower garden"</span>,
  <span class="key">"model"</span>: <span class="str">"flux-2-klein-4b"</span>,
  <span class="key">"photorealistic"</span>: <span class="bool">true</span>,
  <span class="key">"width"</span>: <span class="num">1024</span>,
  <span class="key">"height"</span>: <span class="num">576</span>,
  <span class="key">"seed"</span>: <span class="num">42</span>,
  <span class="key">"safety_tolerance"</span>: <span class="num">2</span>
}</code></pre>
            </div>

            <p class="modal-section">cURL Example</p>
            <div class="code-wrapper">
                <button class="copy-btn" onclick="copyCode(this)" title="Copy Code">${copyIconSVG}</button>
<pre><code class="language-bash">${curlCmd} -X POST "https://your-worker.workers.dev/generate" \\
  -H "Content-Type: application/json" \\
  -H "X-API-KEY: YOUR_SECRET_KEY" \\
  -d '{
    "prompt": "A futuristic cityscape at sunset",
    "model": "flux-2-klein-9b",
    "photorealistic": true,
    "width": 1024,
    "height": 1024
  }'</code></pre>
            </div>

            <p class="modal-section">Response</p>
            <div class="code-wrapper">
                <button class="copy-btn" onclick="copyCode(this)" title="Copy Code">${copyIconSVG}</button>
<pre><code class="language-json">{
  <span class="key">"success"</span>: <span class="bool">true</span>,
  <span class="key">"modelUsed"</span>: <span class="str">"@cf/black-forest-labs/flux-2-klein-4b"</span>,
  <span class="key">"extension"</span>: <span class="str">"png"</span>,
  <span class="key">"costNeurons"</span>: <span class="num">58.61</span>, <span class="comment">// neurons consumed by this request</span>
  <span class="key">"imageData"</span>: <span class="str">"data:image/png;base64,iVBORw0KGgoAAA..."</span>
}</code></pre>
            </div>

            <p class="modal-section">Stats Endpoint</p>
            <div class="code-wrapper">
                <button class="copy-btn" onclick="copyCode(this)" title="Copy Code">${copyIconSVG}</button>
<pre><code class="language-json"><span class="comment">// GET /stats</span>
{
  <span class="key">"neurons"</span>: <span class="num">1842.30</span>,   <span class="comment">// neurons used today</span>
  <span class="key">"count"</span>: <span class="num">18</span>,          <span class="comment">// images generated today</span>
  <span class="key">"limit"</span>: <span class="num">10000</span>,       <span class="comment">// daily neuron budget</span>
  <span class="key">"db_connected"</span>: <span class="bool">true</span>
}</code></pre>
            </div>
        </div>
    </div>
</div>

<footer>
  <a href="https://technochat.in" target="_blank" rel="noopener noreferrer">TechnoChat.IN</a>™
  <span class="footer-sep">·</span>
  © iAmSaugata
</footer>

<script>
// ==========================================
// 💰 LIVE COST ESTIMATOR (mirrors server calculateCost exactly)
// ==========================================
const MODEL_DESCRIPTIONS = {
  'flux-2-klein-4b': '26.05 neurons per output 512×512 tile',
  'flux-2-klein-9b': '1363.64 neurons/first MP + 181.82 neurons/extra MP — high neuron usage',
  'flux-1-schnell':  '9.6 neurons/step + 4.8 neurons/output tile · 4 steps default'
};

function estimateCost() {
  const model = document.getElementById('model').value;
  const ar    = document.getElementById('aspectRatio').value;

  let w = 768, h = 768;
  if      (ar === '16:9')   { w = 1152; h = 640;  }
  else if (ar === '9:16')   { w = 640;  h = 1152; }
  else if (ar === '21:9')   { w = 1280; h = 576;  }
  else if (ar === 'custom') {
    w = parseInt(document.getElementById('width').value)  || 768;
    h = parseInt(document.getElementById('height').value) || 768;
  }

  const STEP = 32;
  w = Math.min(Math.max(Math.round(w / STEP) * STEP, 256), 1280);
  h = Math.min(Math.max(Math.round(h / STEP) * STEP, 256), 1280);

  const tiles = (w * h) / (512 * 512);
  const mp    = (w * h) / 1_000_000;

  let cost;
  if (model === 'flux-1-schnell') {
    cost = (4 * 9.6) + (tiles * 4.8);
  } else if (model === 'flux-2-klein-9b') {
    const firstMp = Math.min(mp, 1);
    const extraMp = Math.max(0, mp - 1);
    cost = (firstMp * 1363.64) + (extraMp * 181.82);
  } else {
    cost = tiles * 26.05;
  }

  const el = document.getElementById('est-neurons');
  if (el) el.innerText = cost.toFixed(2);

  const descEl = document.getElementById('model-desc');
  if (descEl) descEl.innerText = MODEL_DESCRIPTIONS[model] || '';
}

function updateDims() {
  const r = document.getElementById('aspectRatio').value;
  const dimDiv = document.getElementById('dims');
  const wSelect = document.getElementById('width');
  const hSelect = document.getElementById('height');

  let w = 768, h = 768;
  if (r === '16:9') { w=1152; h=640; }
  else if (r === '9:16') { w=640; h=1152; }
  else if (r === '21:9') { w=1280; h=576; }

  if (r === 'custom') {
    dimDiv.style.display = 'block';
  } else {
    dimDiv.style.display = 'none';
    wSelect.value = w;
    hSelect.value = h;
  }
}

// Modal Functions
function openModal() { document.getElementById('api-modal').style.display = 'flex'; }
function closeModal(e, force) { if (force || e.target.id === 'api-modal') { document.getElementById('api-modal').style.display = 'none'; } }
function showError(msg) { const box = document.getElementById('error-box'); box.innerText = "⚠️ " + msg; box.style.display = 'block'; }
function clearError() { document.getElementById('error-box').style.display = 'none'; }

async function copyCode(btn) {
    const codeBlock = btn.nextElementSibling;
    const text = codeBlock.innerText;
    try {
        await navigator.clipboard.writeText(text);
        const originalHtml = btn.innerHTML;
        btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#86efac" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
        setTimeout(() => { btn.innerHTML = originalHtml; }, 2000);
    } catch (err) { console.error('Failed to copy', err); }
}

// ==========================================
// 🕒 COUNTDOWN & AJAX STATS LOGIC
// ==========================================
function updateCountdown() {
    const now = new Date();
    const nextReset = new Date(now);
    nextReset.setUTCHours(24, 0, 0, 0); // Next midnight UTC
    
    const diff = nextReset - now;
    if(diff < 0) return;

    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);

    const fmt = n => n.toString().padStart(2, '0');
    const timerEl = document.getElementById('reset-timer');
    if(timerEl) timerEl.innerText = \`\${fmt(hours)}:\${fmt(minutes)}:\${fmt(seconds)}\`;
}

async function fetchStats() {
    try {
        const res = await fetch('/stats');
        const data = await res.json();
        if(data && data.db_connected) {
            // Update Text
            document.getElementById('usage-val').innerText = data.neurons.toFixed(2);
            const remaining = Math.max(data.limit - data.neurons, 0).toFixed(2);
            const remainEl = document.getElementById('remain-val');
            remainEl.innerText = remaining;
            remainEl.className = remaining < 1000 ? 'stat-warn' : 'stat-ok';
            
            // Update Count
            if(document.getElementById('img-count')) {
                document.getElementById('img-count').innerText = data.count || 0;
            }

            // Update Bar
            const pct = Math.min((data.neurons / data.limit) * 100, 100).toFixed(1);
            document.getElementById('usage-bar').style.width = pct + '%';
        }
    } catch(e) { console.error("Stats update failed", e); }
}

// Start Timer
setInterval(updateCountdown, 1000);
updateCountdown();
// ==========================================

async function generate() {
  const btn = document.getElementById('genBtn');
  const img = document.getElementById('resultImg');
  const meta = document.getElementById('resultMeta');
  const loader = document.getElementById('loader');
  const dlBtn = document.getElementById('dlBtn');
  const placeholder = document.getElementById('placeholder');

  const apiKey = document.getElementById('apikey').value;
  if(!apiKey) { showError("Please enter your API Key."); return; }

  clearError();
  btn.disabled=true;
  img.style.display='none';
  meta.style.display='none';
  dlBtn.style.display='none';
  placeholder.style.display='none';
  loader.style.display='block';

  const payload = {
    prompt: document.getElementById('prompt').value,
    width: parseInt(document.getElementById('width').value),
    height: parseInt(document.getElementById('height').value),
    model: document.getElementById('model').value,
    seed: document.getElementById('seed').value ? parseInt(document.getElementById('seed').value) : undefined,
    safety_tolerance: document.getElementById('safety').value ? parseInt(document.getElementById('safety').value) : undefined,
    photorealistic: document.getElementById('photoreal').checked
  };

  try {
    const res = await fetch('/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
      body: JSON.stringify(payload)
    });
    
    let data;
    try { data = await res.json(); } catch(e) { throw new Error("Invalid Server Response"); }

    if(!res.ok || !data.success) {
        throw new Error(data.error || "Unknown error occurred");
    }
    
    img.src = data.imageData;
    img.style.display='block';

    const niceModel = data.modelUsed.split("/").pop();
    const costStr   = data.costNeurons ? data.costNeurons + ' neurons' : '—';
    meta.innerHTML  = '<span class="meta-model">' + niceModel + '</span> &nbsp;·&nbsp; <span class="meta-cost">' + costStr + '</span>';
    meta.style.display='block';

    dlBtn.href     = data.imageData;
    dlBtn.download = "ai-image-" + Date.now() + "." + data.extension;
    dlBtn.style.display='inline-block';

    fetchStats();

  } catch(e) {
    showError(e.message);
    placeholder.style.display='block';
  } finally {
    btn.disabled=false; loader.style.display='none';
  }
}
updateDims();
estimateCost();
</script>
</body>
</html>`;
}
