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
    // 🧠 NEURON CALCULATOR (Precise Float Version)
    // ==================================================
    function calculateCost(model, width, height, steps) {
      // 1. Calculate number of 512x512 tiles (exact fraction)
      const tiles = (width * height) / (512 * 512);

      // 2. Pricing Logic (Floats kept for accuracy)
      if (model.includes("schnell")) {
        // Flux-1 Schnell: ~9.6 neurons/step + ~4.8 neurons/tile
        const stepCost = 9.6;
        const tileCost = 4.8;
        const numSteps = steps || 4;
        return (numSteps * stepCost) + (tiles * tileCost);
      }
      else if (model.includes("9b")) {
        // Flux-2 Klein 9B: ~58.61 neurons per output tile (larger model, ~2.25x cost of 4B)
        const tileCost = 58.61;
        return tiles * tileCost;
      }
      else {
        // Flux-2 Klein 4B: ~26.05 neurons per output tile
        const tileCost = 26.05;
        return tiles * tileCost;
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
      <div style="flex:1">
        <div style="display:flex; justify-content:space-between; margin-bottom:5px; font-size:0.85rem;">
            <span>Used: <strong id="usage-val" style="color:#fff">${usedFormatted}</strong> Neurons</span>
            <span>Reset in: <strong id="reset-timer" style="color:#a1a1aa; font-family:monospace;">Calculating...</strong></span>
        </div>
        <div style="width:100%; height:6px; background:#333; border-radius:3px; overflow:hidden;">
            <div id="usage-bar" style="width:${pct}%; height:100%; background:linear-gradient(90deg, #6366f1, #ec4899); transition: width 0.5s ease;"></div>
        </div>
        <div style="display:flex; justify-content:space-between; margin-top:4px; font-size:0.75rem; opacity:0.7;">
            <span>Total Images: <strong id="img-count" style="color:#fff">${imgCount || 0}</strong></span>
            <span>Remaining: <strong id="remain-val" style="color:${remaining < 1000 ? '#fca5a5' : '#86efac'}">${remaining}</strong></span>
        </div>
        <div id="cost-display" style="display:none; margin-top:2px; font-size:0.75rem; text-align:right; opacity:0.7;">
            Last Image Cost: <strong id="last-cost" style="color:#fbbf24">0</strong> Neurons
        </div>
      </div>`;
  } else {
      statusHtml = `<span style="color:#fca5a5; font-size:0.9rem;">⚠️ Database Not Connected (KV 'USAGE_DB' missing)</span>`;
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
<style>
  :root { --bg: #09090b; --card: #18181b; --border: #27272a; --accent: #6366f1; --accent-hover: #4f46e5; --text: #e4e4e7; --text-muted: #a1a1aa; --input-bg: #27272a; --error-bg: #450a0a; --error-text: #fca5a5; --code-bg: #111; --code-text: #ccc; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', system-ui, sans-serif; background: var(--bg); color: var(--text); display: flex; flex-direction: column; min-height: 100vh; padding: 20px; align-items: center; }
  
  /* --- CUSTOM SCROLLBAR --- */
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: var(--bg); }
  ::-webkit-scrollbar-thumb { background: #3f3f46; border-radius: 5px; border: 2px solid var(--bg); }
  ::-webkit-scrollbar-thumb:hover { background: #52525b; }
  
  .app-container { width: 100%; max-width: 1100px; display: grid; gap: 2rem; flex: 1; }
  @media(min-width: 800px) { .app-container { grid-template-columns: 350px 1fr; align-items: start; } }
  
  .panel { background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 24px; position: relative; }
  
  /* --- HEADER & USAGE STYLING --- */
  h1 { font-size: 1.65rem; font-weight: 800; color: #fff; display: flex; align-items: center; justify-content: center; gap: 12px; margin-bottom: 0.5rem; white-space: nowrap; }
  .icon-img { width: 26px; height: 26px; display: inline-block; vertical-align: middle; }
  .title-text { background: linear-gradient(to right, #6366f1, #a855f7, #ec4899); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
  
  .usage-badge { 
      background: rgba(255,255,255,0.05); 
      border: 1px solid var(--border); 
      border-radius: 8px; 
      padding: 12px 16px; 
      margin-bottom: 1.5rem; 
      color: var(--text-muted); 
      display: flex; 
      align-items: center;
      gap: 15px;
  }
  
  label { display: block; font-size: 0.85rem; font-weight: 500; color: var(--text-muted); margin: 16px 0 6px 0; }
  input, select, textarea { width: 100%; max-width: 100%; background: var(--input-bg); border: 1px solid var(--border); color: white; padding: 10px; border-radius: 8px; outline: none; transition: border 0.2s; }
  textarea { resize: vertical; } 
  input:focus, select:focus, textarea:focus { border-color: var(--accent); }
  
  .btn { width: 100%; border: none; padding: 12px; border-radius: 8px; font-weight: 600; cursor: pointer; display: flex; justify-content: center; gap: 8px; margin-top: 24px; transition: all 0.2s; }
  .btn-primary { background: var(--accent); color: white; }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-secondary { background: transparent; border: 1px solid var(--border); color: var(--text-muted); margin-top: 10px; }
  .btn-secondary:hover { border-color: var(--accent); color: #fff; background: rgba(255,255,255,0.05); }

  .result-area { min-height: 400px; display: flex; flex-direction: column; align-items: center; justify-content: center; background: #000; border-radius: 12px; padding: 20px; text-align: center; position: relative; }
  img { max-width: 100%; max-height: 70vh; border-radius: 4px; display: none; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
  .caption { margin-top: 15px; color: var(--text-muted); font-size: 0.8rem; font-family: monospace; display: none; background: #111; padding: 6px 12px; border-radius: 20px; border: 1px solid #333; }
  .caption span { color: var(--accent); font-weight: bold; }

  .loader { border: 3px solid rgba(255,255,255,0.1); border-top-color: var(--accent); border-radius: 50%; width: 40px; height: 40px; animation: spin 1s infinite; display: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  
  #error-box { display: none; background: var(--error-bg); color: var(--error-text); border: 1px solid #7f1d1d; padding: 12px; border-radius: 8px; margin-top: 20px; font-size: 0.9rem; text-align: left; }
  
  .checkbox-group { display: flex; align-items: center; gap: 8px; margin-top: 16px; }
  .checkbox-group input { width: auto; }
  
  footer { margin-top: 40px; text-align: center; color: var(--text-muted); font-size: 0.8rem; border-top: 1px solid var(--border); width: 100%; max-width: 1100px; padding-top: 20px; padding-bottom: 20px; }

  /* --- MODAL STYLES --- */
  .modal-overlay {
      display: none;
      position: fixed;
      top: 0; left: 0;
      width: 100%; height: 100%;
      background: rgba(0, 0, 0, 0.8);
      z-index: 1000;
      justify-content: center;
      align-items: center;
      backdrop-filter: blur(5px);
  }
  .modal-content {
      background: var(--card);
      width: 90%;
      max-width: 800px;
      max-height: 90vh;
      border-radius: 16px;
      border: 1px solid var(--border);
      padding: 0;
      display: flex;
      flex-direction: column;
      box-shadow: 0 10px 40px rgba(0,0,0,0.5);
  }
  .modal-header {
      padding: 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
  }
  .modal-header h3 { color: #fff; margin: 0; font-size: 1.2rem; }
  .close-btn { background: none; border: none; color: var(--text-muted); font-size: 1.5rem; cursor: pointer; padding: 0 8px; }
  .close-btn:hover { color: #fff; }
  
  .modal-body {
      padding: 20px;
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: #3f3f46 var(--card);
  }
  .modal-body::-webkit-scrollbar { width: 8px; }
  .modal-body::-webkit-scrollbar-track { background: var(--card); }
  .modal-body::-webkit-scrollbar-thumb { background: #3f3f46; border-radius: 4px; }
  .modal-body::-webkit-scrollbar-thumb:hover { background: #52525b; }

  .modal-body p { margin-bottom: 12px; font-size: 0.9rem; color: var(--text-muted); line-height: 1.5; }
  .modal-body code { background: var(--input-bg); padding: 2px 6px; border-radius: 4px; color: var(--accent); font-family: monospace; }
  
  .param-list { list-style: disc; padding-left: 20px; margin-bottom: 20px; color: var(--text-muted); font-size: 0.9rem; line-height: 1.6; }
  .param-list li { margin-bottom: 6px; }
  .param-list strong { color: #e4e4e7; font-weight: 600; color: var(--accent); }

  /* --- CODE BLOCK STYLES --- */
  .code-wrapper { position: relative; margin-top: 15px; margin-bottom: 20px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--code-bg); }
  .copy-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      width: 32px;
      height: 32px;
      background: rgba(255,255,255,0.1);
      border: none;
      color: #aaa;
      border-radius: 6px;
      cursor: pointer;
      display: flex;
      justify-content: center;
      align-items: center;
      transition: all 0.2s;
      z-index: 10;
  }
  .copy-btn:hover { background: rgba(255,255,255,0.2); color: white; }
  
  pre { margin: 0; padding: 20px; overflow-x: auto; }
  code.language-json, code.language-bash { font-family: 'Fira Code', Consolas, monospace; font-size: 0.85rem; color: var(--code-text); }
  .key { color: #fca5a5; } .str { color: #86efac; } .bool { color: #93c5fd; } .num { color: #fde047; } .comment { color: #6b7280; }
</style>
</head>
<body>

<div class="app-container">
  <div class="panel">
    <h1>
      <span class="title-text">AI Image Generator</span>
      <img src="${headerIconSVG}" class="icon-img" alt="Magic" /> 
    </h1>
    
    <div class="usage-badge">
       ${statusHtml}
    </div>
    
    <label>API Key</label>
    <input type="password" id="apikey" placeholder="Enter Secret Key" />
    
    <label>Prompt</label>
    <textarea id="prompt" rows="3" placeholder="A futuristic city with flying cars..."></textarea>
    
    <label>Dimensions</label>
    <select id="aspectRatio" onchange="updateDims()">
      <option value="1:1" selected>1:1 Square (768x768)</option>
      <option value="16:9">16:9 Landscape</option>
      <option value="9:16">9:16 Portrait</option>
      <option value="21:9">21:9 Ultrawide</option>
      <option value="custom">Custom</option>
    </select>

    <div id="dims" style="display:none; margin-top: 10px; background: #222; padding: 10px; border-radius: 8px;">
       <div style="display:flex; gap:10px">
         <div style="flex:1"><label>Width</label><select id="width">${generateSizeOptions()}</select></div>
         <div style="flex:1"><label>Height</label><select id="height">${generateSizeOptions()}</select></div>
       </div>
    </div>
    
    <details style="margin-top:20px; color:#aaa; cursor:pointer;">
      <summary>Advanced Settings</summary>
      <div style="padding-top:10px;">
        <label>Model</label>
        <select id="model">
          <option value="flux-2-klein-4b" selected>Flux-2 Klein 4B (High Quality Default)</option>
          <option value="flux-2-klein-9b">Flux-2 Klein 9B (Highest Quality)</option>
          <option value="flux-1-schnell">Flux-1 Schnell (Faster)</option>
        </select>
        
        <div style="display: flex; gap: 10px;">
             <div style="flex:1">
                <label>Seed</label><input type="number" id="seed" placeholder="Random">
             </div>
             <div style="flex:1">
                <label>Safety Tolerance</label>
                <select id="safety">
                  <option value="">Default</option>
                  <option value="1">Strict (1)</option>
                  <option value="2">Medium (2)</option>
                  <option value="3">Loose (3)</option>
                </select>
             </div>
        </div>

        <div class="checkbox-group">
            <input type="checkbox" id="photoreal">
            <span>Enable Photorealistic Enhancer</span>
        </div>
      </div>
    </details>

    <div id="error-box"></div>

    <button class="btn btn-primary" onclick="generate()" id="genBtn">🚀 Generate Image</button>
    <button class="btn btn-secondary" onclick="openModal()">🛠️ Developer API Documentation</button>
  </div>

  <div class="panel result-area">
    <div id="placeholder" style="color:#666">Your generated artwork will appear here</div>
    <div class="loader" id="loader"></div>
    
    <img id="resultImg" />
    <p id="resultCaption" class="caption"></p>
    
    <a id="dlBtn" style="display:none; margin-top:15px; padding: 10px 20px; background: #222; border-radius: 6px; color:var(--text); text-decoration: none; border:1px solid var(--border);" href="#" download="image.jpg">Download High Res ⤓</a>
  </div>
</div>

<div id="api-modal" class="modal-overlay" onclick="closeModal(event)">
    <div class="modal-content">
        <div class="modal-header">
            <h3>🔌 API Integration Guide</h3>
            <button class="close-btn" onclick="closeModal(event, true)">×</button>
        </div>
        <div class="modal-body">
            <p>Integrate our AI image generation capabilities directly into your applications. The API is stateless and RESTful.</p>
            
            <p><strong>Endpoint:</strong> <code>POST /generate</code></p>
            <p><strong>Authentication:</strong> Include your secret API key in the <code>X-API-KEY</code> header.</p>
            
            <p><strong>Request Parameters:</strong></p>
            <ul class="param-list">
                <li><strong>prompt</strong> (Required): Text description of the image to generate.</li>
                <li><strong>model</strong>: <code>flux-2-klein-4b</code> (Default), <code>flux-2-klein-9b</code> (Highest Quality), or <code>flux-1-schnell</code> (Faster).</li>
                <li><strong>photorealistic</strong>: <code>true</code> or <code>false</code>. Appends quality-enhancing keywords.</li>
                <li><strong>width</strong> / <strong>height</strong>: Integer (256-1280). Must be a multiple of 32.</li>
                <li><strong>seed</strong>: Integer. Use for reproducible results. Defaults to random.</li>
                <li><strong>safety_tolerance</strong>: Integer. 1 (Strict), 2 (Medium), 3 (Loose).</li>
            </ul>

            <p><strong>Request Body (JSON):</strong></p>
            <div class="code-wrapper">
                <button class="copy-btn" onclick="copyCode(this)" title="Copy Code">${copyIconSVG}</button>
<pre><code class="language-json">{
  <span class="key">"prompt"</span>: <span class="str">"A cute robot astronaut in a flower garden"</span>,
  <span class="key">"model"</span>: <span class="str">"flux-2-klein-4b"</span>,
  <span class="key">"photorealistic"</span>: <span class="bool">true</span>,
  <span class="key">"width"</span>: <span class="num">1024</span>,
  <span class="key">"height"</span>: <span class="num">576</span>,
  <span class="key">"seed"</span>: <span class="num">123456</span>,
  <span class="key">"safety_tolerance"</span>: <span class="num">2</span>
}</code></pre>
            </div>

            <p><strong>Example cURL Command:</strong></p>
            <div class="code-wrapper">
                <button class="copy-btn" onclick="copyCode(this)" title="Copy Code">${copyIconSVG}</button>
<pre><code class="language-bash">${curlCmd} -X POST "https://your-worker-url.workers.dev/generate" \\
     -H "Content-Type: application/json" \\
     -H "X-API-KEY: YOUR_SECRET_KEY" \\
     -d '{
            "prompt": "A futuristic cityscape at sunset",
            "model": "flux-2-klein-4b",
            "photorealistic": true,
            "width": 1024,
            "height": 576
          }'</code></pre>
            </div>

            <p><strong>Response (JSON):</strong></p>
            <div class="code-wrapper">
                <button class="copy-btn" onclick="copyCode(this)" title="Copy Code">${copyIconSVG}</button>
<pre><code class="language-json">{
  <span class="key">"success"</span>: <span class="bool">true</span>,
  <span class="key">"modelUsed"</span>: <span class="str">"@cf/black-forest-labs/flux-2-klein-4b"</span>,
  <span class="key">"extension"</span>: <span class="str">"png"</span>,
  <span class="key">"imageData"</span>: <span class="str">"data:image/png;base64,iVBORw0KGgoAAA..."</span>
}</code></pre>
            </div>
        </div>
    </div>
</div>

<footer>
    TechnoChat.IN™ | © iAmSAugata
</footer>

<script>
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
            remainEl.style.color = remaining < 1000 ? '#fca5a5' : '#86efac';
            
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
  const caption = document.getElementById('resultCaption');
  const loader = document.getElementById('loader');
  const dlBtn = document.getElementById('dlBtn');
  const placeholder = document.getElementById('placeholder');
  
  const apiKey = document.getElementById('apikey').value;
  if(!apiKey) { showError("Please enter your API Key."); return; }
  
  clearError();
  btn.disabled=true; 
  img.style.display='none'; 
  caption.style.display='none';
  dlBtn.style.display='none'; 
  placeholder.style.display='none';
  loader.style.display='block';
  document.getElementById('cost-display').style.display='none';

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
    
    const niceModelName = data.modelUsed.split("/").pop(); 
    caption.innerHTML = "Generated with <span>" + niceModelName + "</span>";
    caption.style.display='block';

    dlBtn.href = data.imageData;
    dlBtn.download = "technochat-ai-" + Date.now() + "." + data.extension;
    dlBtn.style.display='inline-block';
    
    // ✨ UPDATE STATS & COST
    fetchStats();
    if(data.costNeurons) {
        document.getElementById('last-cost').innerText = data.costNeurons;
        document.getElementById('cost-display').style.display = 'block';
    }

  } catch(e) {
    showError(e.message);
    placeholder.style.display='block';
  } finally {
    btn.disabled=false; loader.style.display='none';
  }
}
updateDims();
</script>
</body>
</html>`;
}
