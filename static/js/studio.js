let appState = {
    dataset: [],
    models: [],
    tags_config: {},
    has_gemini_key: false,
    gemini_model: "gemini-3.8-flash"
};
let currentModalIndex = -1;
let cropper = null;
let currentTargetW = 1024;
let currentTargetH = 1024;
let saveTimeout = null;
let lastAiSuggestions = [];

/* === ÉTAT DE L'ATELIER D'ISOLATION VISUELLE (CADRAGE vs DÉTOURAGE) === */
let studioToolMode = 'crop'; // 'crop' | 'cutout'
let cutoutSubTool = 'lasso'; // 'lasso' | 'magic' | 'brush_keep' | 'brush_erase'
let cutoutBgColor = 'white'; // 'white' | 'black' | 'grey'
let cutoutTolerance = 28;    // Tolérance Baguette Magique (5 - 90)
let cutoutBrushSize = 36;    // Taille du pinceau en pixels image (5 - 150)

let cutoutImgObj = null;     // Image HTML chargée pour le détourage
let cutoutImgData = null;    // ImageData original (RGBA) de l'image
let cutoutMask = null;       // Uint8Array (w * h) : 255 = conservé, 0 = exclu
let cutoutHistory = [];      // Pile d'historique Undo des masques (max 12)
let lassoPoints = [];        // Points [{x, y}] en coordonnées image
let isDrawingCutout = false; // Glisser en cours (pinceau ou lasso main levée)
let hasExcludedAnything = false; // Indique si un premier détourage a déjà été appliqué

const BG_HEX_MAP = {
    white: [255, 255, 255],
    black: [0, 0, 0],
    grey:  [128, 128, 128]
};

async function fetchState() {
    const res = await fetch('api/state');
    appState = await res.json();
    renderGrid();
    renderModels();
    populateBatchSelect();
    populateCustomCatSelect();
    updateGeminiKeyButton();
}

function updateGeminiKeyButton() {
    const btn = document.getElementById('btnGeminiKey');
    if (!btn) return;
    const modelShort = (appState.gemini_model || 'gemini-3.8-flash').replace('models/', '');
    if (appState.has_gemini_key) {
        btn.innerText = `🔑 IA (${modelShort}) ✓`;
        btn.style.borderColor = '#16a34a';
    } else {
        btn.innerText = `🔑 Clé IA ?`;
        btn.style.borderColor = '#ca8a04';
    }
}

async function promptGeminiKey() {
    const currentModel = appState.gemini_model || 'gemini-3.8-flash';
    const keyMsg = appState.has_gemini_key
        ? "Une clé API Gemini est déjà configurée sur le serveur.\nEntrez une nouvelle clé pour la remplacer, ou laissez VIDE pour conserver la clé actuelle :"
        : "Entrez votre clé API Google Gemini (AI Studio) :";
    const key = prompt(keyMsg);
    if (key === null) return;

    const model = prompt(
        "Modèle Gemini à utiliser (ex: gemini-3.8-flash) :",
        currentModel
    );
    if (model === null) return;

    const res = await fetch('api/gemini_key', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            api_key: key.trim(),
            model: model.trim() || 'gemini-3.8-flash'
        })
    });
    const data = await res.json();
    appState.has_gemini_key = data.has_gemini_key;
    appState.gemini_model = data.gemini_model;
    updateGeminiKeyButton();
}

function renderGrid() {
    document.getElementById('imgCount').innerText = appState.dataset.length;
    const grid = document.getElementById('datasetGrid');
    grid.innerHTML = appState.dataset.map((item, idx) => `
        <div class="card-item">
            <div class="card-top">
                <label style="margin:0; display:flex; align-items:center; gap:5px; cursor:pointer;">
                    <input type="checkbox" class="img-check" value="${item.image}">
                    <span title="${item.image}">${item.image.substring(0, 18)}</span>
                </label>
                <button class="btn danger sm" style="padding:2px 6px;" onclick="deleteImage('${item.image}')">✕</button>
            </div>
            <div class="thumb-wrap" onclick="openStudio(${idx})">
                <img src="img/dataset/${encodeURIComponent(item.image)}?t=${item.mtime}" loading="lazy">
                <span class="dim-tag">${item.width}×${item.height}</span>
                <div class="studio-overlay">✂️ Ouvrir dans le Studio</div>
            </div>
            <div class="caption-preview" onclick="openStudio(${idx})" style="cursor:pointer;" title="${item.caption}">
                ${item.caption || '<em style="color:#64748b">Aucune légende...</em>'}
            </div>
        </div>
    `).join('');
}

function renderModels() {
    const list = document.getElementById('modelsList');
    if (!appState.models.length) {
        list.innerHTML = '<p style="font-size:0.8rem; color:#64748b; margin:0;">Aucun filtre généré.</p>';
        return;
    }
    list.innerHTML = appState.models.map(m => `
        <div class="model-row">
            <span>${m.name} (${m.size_mb} Mo)</span>
            <a href="models/${encodeURIComponent(m.name)}" download>Télécharger</a>
        </div>
    `).join('');
}

function populateBatchSelect() {
    const sel = document.getElementById('batchTagSelect');
    const prev = sel.value;
    let html = '<option value="">-- Choisir un tag pour le lot --</option>';
    for (const [cat, tags] of Object.entries(appState.tags_config)) {
        html += `<optgroup label="${cat}">`;
        for (const t of tags) {
            html += `<option value="${t.en.replace(/"/g, '&quot;')}">${t.fr} (${t.en})</option>`;
        }
        html += `</optgroup>`;
    }
    sel.innerHTML = html;
    if (prev) sel.value = prev;
}

function populateCustomCatSelect() {
    const sel = document.getElementById('customCat');
    if (!sel) return;
    const prev = sel.value;
    const cats = Object.keys(appState.tags_config);
    if (!cats.includes('Personnalisé')) cats.push('Personnalisé');
    sel.innerHTML = cats.map(c => `<option value="${c}">${c}</option>`).join('');
    if (prev && cats.includes(prev)) {
        sel.value = prev;
    } else if (cats.length > 1) {
        sel.value = cats[1];
    }
}

function selectAll(checked) {
    document.querySelectorAll('.img-check').forEach(cb => cb.checked = checked);
}

async function applyBatchTag(action) {
    const tagEn = document.getElementById('batchTagSelect').value;
    if (!tagEn) return alert('Choisissez un tag dans la liste déroulante.');
    const checked = Array.from(document.querySelectorAll('.img-check:checked')).map(cb => cb.value);
    if (!checked.length) return alert('Cochez au moins une image dans la grille.');
    const trigger = document.getElementById('triggerWord').value.trim();

    await fetch('api/batch_caption', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ images: checked, tag_en: tagEn, action: action, trigger: trigger })
    });
    await fetchState();
}

async function uploadFiles() {
    const input = document.getElementById('fileInput');
    if (!input.files.length) return;
    const fd = new FormData();
    fd.append('trigger', document.getElementById('triggerWord').value.trim());
    for (const f of input.files) fd.append('files', f);
    await fetch('api/upload', { method: 'POST', body: fd });
    input.value = '';
    await fetchState();
}

async function deleteImage(imgName) {
    if (!confirm(`Supprimer ${imgName} ?`)) return;
    await fetch('api/delete/' + encodeURIComponent(imgName), { method: 'DELETE' });
    await fetchState();
}

/* === STUDIO MODAL : OUVERTURE & BASCULE DES OUTILS === */
function openStudio(idx) {
    if (idx < 0 || idx >= appState.dataset.length) return;
    currentModalIndex = idx;
    const item = appState.dataset[idx];

    document.getElementById('studioModal').classList.remove('hidden');
    document.getElementById('modalTitle').innerText = `${idx + 1}/${appState.dataset.length} — ${item.image}`;
    document.getElementById('modalDims').innerText = `Actuel : ${item.width}×${item.height}`;
    document.getElementById('modalCaption').value = item.caption;

    lastAiSuggestions = [];
    const drawer = document.getElementById('copilotDrawer');
    if (drawer) {
        drawer.classList.add('hidden');
        drawer.innerHTML = '';
    }

    renderPills();
    syncPillsWithTextarea();

    const imgUrl = `img/dataset/${encodeURIComponent(item.image)}?t=${Date.now()}`;
    loadStudioImage(imgUrl);
}

function loadStudioImage(imgUrl) {
    // 1. Charge pour Cropper.js
    const imgEl = document.getElementById('cropImage');
    if (cropper) {
        cropper.destroy();
        cropper = null;
    }
    imgEl.src = imgUrl;
    imgEl.onload = () => {
        if (studioToolMode === 'crop') {
            initCropperInstance();
        }
    };

    // 2. Prépare en parallèle les données pixel pour l'atelier de Détourage
    const rawImg = new Image();
    rawImg.crossOrigin = "anonymous";
    rawImg.onload = () => {
        cutoutImgObj = rawImg;
        const off = document.createElement('canvas');
        off.width = rawImg.naturalWidth;
        off.height = rawImg.naturalHeight;
        const ctx = off.getContext('2d');
        ctx.drawImage(rawImg, 0, 0);
        cutoutImgData = ctx.getImageData(0, 0, off.width, off.height);
        resetCutoutMask(false);
        if (studioToolMode === 'cutout') {
            renderCutoutCanvas();
        }
    };
    rawImg.src = imgUrl;
}

function initCropperInstance() {
    const imgEl = document.getElementById('cropImage');
    if (cropper) cropper.destroy();
    cropper = new Cropper(imgEl, {
        aspectRatio: currentTargetW / currentTargetH,
        viewMode: 1,
        autoCropArea: 0.95,
        background: true,
        responsive: true
    });
}

function switchStudioTool(mode) {
    studioToolMode = mode;
    document.getElementById('tabModeCrop').classList.toggle('active', mode === 'crop');
    document.getElementById('tabModeCutout').classList.toggle('active', mode === 'cutout');

    const cropperCont = document.getElementById('cropperContainer');
    const cutoutCont = document.getElementById('cutoutContainer');
    const cutoutToolbar = document.getElementById('cutoutToolbar');
    const btnReplace = document.getElementById('btnActionReplace');
    const btnExtract = document.getElementById('btnActionExtract');

    if (mode === 'crop') {
        cutoutToolbar.classList.add('hidden');
        cutoutCont.classList.add('hidden');
        cropperCont.classList.remove('hidden');
        btnReplace.innerHTML = '✂️ Recadrer et remplacer cette image';
        btnExtract.innerHTML = '➕ Extraire ce cadrage comme nouvelle image (Détail)';
        initCropperInstance();
    } else {
        if (cropper) {
            cropper.destroy();
            cropper = null;
        }
        cropperCont.classList.add('hidden');
        cutoutToolbar.classList.remove('hidden');
        cutoutCont.classList.remove('hidden');
        btnReplace.innerHTML = '🎭 Détourer et remplacer cette image';
        btnExtract.innerHTML = '➕ Extraire ce sujet détouré comme nouvelle image';
        renderCutoutCanvas();
    }
}

function closeModal() {
    document.getElementById('studioModal').classList.add('hidden');
    if (cropper) {
        cropper.destroy();
        cropper = null;
    }
    fetchState();
}

function navigateModal(delta) {
    const nextIdx = currentModalIndex + delta;
    if (nextIdx >= 0 && nextIdx < appState.dataset.length) {
        openStudio(nextIdx);
    }
}

function setRatio(ratio, w, h, btnEl) {
    currentTargetW = w;
    currentTargetH = h;
    document.querySelectorAll('.ratio-group .btn').forEach(b => b.classList.remove('active-ratio'));
    if (btnEl) btnEl.classList.add('active-ratio');
    if (studioToolMode === 'crop' && cropper) {
        cropper.setAspectRatio(ratio);
    } else if (studioToolMode === 'cutout') {
        renderCutoutCanvas();
    }
}

/* === MOTEUR DE DÉTOURAGE INTERACTIF (LASSO, BAGUETTE MAGIQUE, PINCEAUX) === */
function setCutoutSubTool(subTool) {
    cutoutSubTool = subTool;
    lassoPoints = [];
    document.getElementById('btnSubLasso').classList.toggle('active', subTool === 'lasso');
    document.getElementById('btnSubMagic').classList.toggle('active', subTool === 'magic');
    document.getElementById('btnSubKeep').classList.toggle('active', subTool === 'brush_keep');
    document.getElementById('btnSubErase').classList.toggle('active', subTool === 'brush_erase');

    const slider = document.getElementById('cutoutParamSlider');
    const label = document.getElementById('sliderParamLabel');
    const hint = document.getElementById('cutoutHintBar');

    if (subTool === 'lasso') {
        label.innerHTML = `Lissage : <span id="sliderParamVal">Polygone</span>`;
        slider.style.display = 'none';
        hint.innerHTML = `✒️ <strong>Lasso :</strong> Cliquez point par point (ou glissez à main levée) autour de la partie signifiante, puis <strong>double-cliquez</strong> (ou cliquez sur le 1er point) pour exclure le reste.`;
    } else if (subTool === 'magic') {
        slider.style.display = 'inline-block';
        slider.min = 5;
        slider.max = 90;
        slider.value = cutoutTolerance;
        label.innerHTML = `Tolérance couleur : <span id="sliderParamVal">${cutoutTolerance}</span>`;
        hint.innerHTML = `🪄 <strong>Baguette Magique :</strong> Cliquez sur une zone de fond ou de bruit pour l'exclure d'un coup. (Astuce : <strong>Shift + Clic</strong> pour restaurer une zone).`;
    } else {
        slider.style.display = 'inline-block';
        slider.min = 5;
        slider.max = 140;
        slider.value = cutoutBrushSize;
        const actionTxt = subTool === 'brush_keep' ? 'CONSERVER / RESTAURER' : 'EFFACER / EXCLURE';
        label.innerHTML = `Taille pinceau : <span id="sliderParamVal">${cutoutBrushSize}px</span>`;
        hint.innerHTML = `🖌️ <strong>Pinceau (${actionTxt}) :</strong> Peignez directement sur l'image pour affiner les contours du sujet.`;
    }
    renderCutoutCanvas();
}

function onCutoutSliderInput(val) {
    const v = parseInt(val, 10);
    const span = document.getElementById('sliderParamVal');
    if (span) span.innerText = (cutoutSubTool === 'magic') ? v : `${v}px`;
    if (cutoutSubTool === 'magic') {
        cutoutTolerance = v;
    } else {
        cutoutBrushSize = v;
    }
}

function setCutoutBg(bgKey, btnEl) {
    cutoutBgColor = bgKey;
    document.querySelectorAll('.bg-swatch').forEach(b => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
    renderCutoutCanvas();
}

function saveMaskToHistory() {
    if (!cutoutMask) return;
    cutoutHistory.push(new Uint8Array(cutoutMask));
    if (cutoutHistory.length > 12) cutoutHistory.shift();
}

function undoCutoutStep() {
    if (lassoPoints.length > 0) {
        lassoPoints.pop();
        renderCutoutCanvas();
        return;
    }
    if (cutoutHistory.length > 0) {
        cutoutMask = cutoutHistory.pop();
        renderCutoutCanvas();
    }
}

function resetCutoutMask(recordHistory = true) {
    if (!cutoutImgData) return;
    if (recordHistory) saveMaskToHistory();
    cutoutMask = new Uint8Array(cutoutImgData.width * cutoutImgData.height);
    cutoutMask.fill(255);
    lassoPoints = [];
    hasExcludedAnything = false;
    renderCutoutCanvas();
}

function invertCutoutMask() {
    if (!cutoutMask) return;
    saveMaskToHistory();
    for (let i = 0; i < cutoutMask.length; i++) {
        cutoutMask[i] = cutoutMask[i] > 127 ? 0 : 255;
    }
    hasExcludedAnything = true;
    renderCutoutCanvas();
}

function getBoundingBoxOfKeptMask() {
    if (!cutoutMask || !cutoutImgData) return null;
    const w = cutoutImgData.width;
    const h = cutoutImgData.height;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
        const rowOffset = y * w;
        for (let x = 0; x < w; x++) {
            if (cutoutMask[rowOffset + x] > 127) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }
    if (maxX < minX || maxY < minY) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function renderCutoutCanvas() {
    const canvas = document.getElementById('cutoutCanvas');
    if (!canvas || !cutoutImgData || !cutoutMask) return;
    const w = cutoutImgData.width;
    const h = cutoutImgData.height;
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    const outData = ctx.createImageData(w, h);
    const src = cutoutImgData.data;
    const dst = outData.data;

    const previewSolid = document.getElementById('chkPreviewSolid')?.checked;
    const bgRgb = BG_HEX_MAP[cutoutBgColor] || [255, 255, 255];

    for (let i = 0; i < cutoutMask.length; i++) {
        const p = i * 4;
        if (cutoutMask[i] > 127) {
            dst[p] = src[p];
            dst[p + 1] = src[p + 1];
            dst[p + 2] = src[p + 2];
            dst[p + 3] = 255;
        } else {
            if (previewSolid) {
                dst[p] = bgRgb[0];
                dst[p + 1] = bgRgb[1];
                dst[p + 2] = bgRgb[2];
                dst[p + 3] = 255;
            } else {
                // Voile rouge/sombre semi-transparent permettant de voir ce qu'on a exclu pour pouvoir le corriger au pinceau
                dst[p] = Math.round(src[p] * 0.22 + 50);
                dst[p + 1] = Math.round(src[p + 1] * 0.15 + 10);
                dst[p + 2] = Math.round(src[p + 2] * 0.18 + 18);
                dst[p + 3] = 255;
            }
        }
    }
    ctx.putImageData(outData, 0, 0);

    // Si "Recadrer & centrer auto" est activé et qu'une zone est détourée, afficher en pointillés verts la boîte englobante détectée
    const autoFit = document.getElementById('chkAutoFit')?.checked;
    if (autoFit && hasExcludedAnything && !previewSolid) {
        const bbox = getBoundingBoxOfKeptMask();
        if (bbox) {
            ctx.save();
            ctx.strokeStyle = '#38bdf8';
            ctx.lineWidth = Math.max(2, Math.round(w / 350));
            ctx.setLineDash([8, 6]);
            ctx.strokeRect(bbox.x, bbox.y, bbox.w, bbox.h);
            ctx.restore();
        }
    }

    // Dessiner le polygone du Lasso en cours de tracé
    if (cutoutSubTool === 'lasso' && lassoPoints.length > 0) {
        ctx.save();
        ctx.lineWidth = Math.max(2.5, Math.round(w / 300));
        ctx.strokeStyle = '#fde047';
        ctx.fillStyle = 'rgba(56, 189, 248, 0.20)';
        ctx.beginPath();
        ctx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
        for (let i = 1; i < lassoPoints.length; i++) {
            ctx.lineTo(lassoPoints[i].x, lassoPoints[i].y);
        }
        ctx.stroke();

        // Points d'ancrage
        const r = Math.max(4, Math.round(w / 160));
        for (let i = 0; i < lassoPoints.length; i++) {
            ctx.beginPath();
            ctx.arc(lassoPoints[i].x, lassoPoints[i].y, i === 0 ? r * 1.35 : r, 0, Math.PI * 2);
            ctx.fillStyle = i === 0 ? '#22c55e' : '#fde047';
            ctx.fill();
            ctx.strokeStyle = '#0f172a';
            ctx.lineWidth = 1.5;
            ctx.stroke();
        }
        ctx.restore();
    }
}

function getCanvasImageCoords(evt) {
    const canvas = document.getElementById('cutoutCanvas');
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
        x: Math.max(0, Math.min(canvas.width - 1, Math.round((evt.clientX - rect.left) * scaleX))),
        y: Math.max(0, Math.min(canvas.height - 1, Math.round((evt.clientY - rect.top) * scaleY)))
    };
}

function applyPolygonLasso() {
    if (lassoPoints.length < 3 || !cutoutImgData) return;
    saveMaskToHistory();
    const w = cutoutImgData.width;
    const h = cutoutImgData.height;

    const polyCanvas = document.createElement('canvas');
    polyCanvas.width = w;
    polyCanvas.height = h;
    const pCtx = polyCanvas.getContext('2d');
    pCtx.fillStyle = '#ffffff';
    pCtx.beginPath();
    pCtx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
    for (let i = 1; i < lassoPoints.length; i++) {
        pCtx.lineTo(lassoPoints[i].x, lassoPoints[i].y);
    }
    pCtx.closePath();
    pCtx.fill();

    const pData = pCtx.getImageData(0, 0, w, h).data;
    // Si aucune exclusion n'avait encore été faite, le lasso définit la zone à GARDER et exclut tout l'extérieur.
    // Si un détourage existait déjà, le lasso ajoute/garde la zone entourée.
    const firstCut = !hasExcludedAnything;
    for (let i = 0; i < cutoutMask.length; i++) {
        const inside = pData[i * 4 + 3] > 127;
        if (firstCut) {
            cutoutMask[i] = inside ? 255 : 0;
        } else if (inside) {
            cutoutMask[i] = 255;
        }
    }
    hasExcludedAnything = true;
    lassoPoints = [];
    renderCutoutCanvas();
}

function applyMagicWandFloodFill(startX, startY, targetKeepVal) {
    if (!cutoutImgData || !cutoutMask) return;
    saveMaskToHistory();
    const w = cutoutImgData.width;
    const h = cutoutImgData.height;
    const src = cutoutImgData.data;

    const startIdx = (startY * w + startX) * 4;
    const r0 = src[startIdx];
    const g0 = src[startIdx + 1];
    const b0 = src[startIdx + 2];

    // Seuil de distance couleur quadratique
    const maxDistSq = (cutoutTolerance * 1.85) * (cutoutTolerance * 1.85) * 3;
    const visited = new Uint8Array(w * h);
    const stack = [startY * w + startX];
    visited[startY * w + startX] = 1;

    while (stack.length > 0) {
        const idx = stack.pop();
        cutoutMask[idx] = targetKeepVal;

        const x = idx % w;
        const y = (idx - x) / w;

        const neighbors = [];
        if (x > 0) neighbors.push(idx - 1);
        if (x < w - 1) neighbors.push(idx + 1);
        if (y > 0) neighbors.push(idx - w);
        if (y < h - 1) neighbors.push(idx + w);

        for (let n = 0; n < neighbors.length; n++) {
            const nIdx = neighbors[n];
            if (visited[nIdx]) continue;
            visited[nIdx] = 1;
            const p = nIdx * 4;
            const dr = src[p] - r0;
            const dg = src[p + 1] - g0;
            const db = src[p + 2] - b0;
            if (dr * dr + dg * dg + db * db <= maxDistSq) {
                stack.push(nIdx);
            }
        }
    }
    hasExcludedAnything = true;
    renderCutoutCanvas();
}

function paintMaskCircle(cx, cy, radius, val) {
    if (!cutoutMask || !cutoutImgData) return;
    const w = cutoutImgData.width;
    const h = cutoutImgData.height;
    const rSq = radius * radius;
    const minX = Math.max(0, Math.floor(cx - radius));
    const maxX = Math.min(w - 1, Math.ceil(cx + radius));
    const minY = Math.max(0, Math.floor(cy - radius));
    const maxY = Math.min(h - 1, Math.ceil(cy + radius));

    for (let y = minY; y <= maxY; y++) {
        const dy = y - cy;
        const rowOffset = y * w;
        for (let x = minX; x <= maxX; x++) {
            const dx = x - cx;
            if (dx * dx + dy * dy <= rSq) {
                cutoutMask[rowOffset + x] = val;
            }
        }
    }
    hasExcludedAnything = true;
}

function initCutoutCanvasEvents() {
    const canvas = document.getElementById('cutoutCanvas');
    if (!canvas) return;

    canvas.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || !cutoutImgData) return;
        const pt = getCanvasImageCoords(e);

        if (cutoutSubTool === 'lasso') {
            // Si on clique tout près du 1er point avec au moins 3 points, on ferme le polygone
            if (lassoPoints.length >= 3) {
                const dx = pt.x - lassoPoints[0].x;
                const dy = pt.y - lassoPoints[0].y;
                const closeRadius = Math.max(12, cutoutImgData.width / 60);
                if (Math.hypot(dx, dy) <= closeRadius) {
                    applyPolygonLasso();
                    return;
                }
            }
            lassoPoints.push(pt);
            isDrawingCutout = true;
            renderCutoutCanvas();
        } else if (cutoutSubTool === 'magic') {
            // Clic normal = exclure le fond (0) ; Shift+Clic = restaurer (255)
            const targetVal = e.shiftKey ? 255 : 0;
            applyMagicWandFloodFill(pt.x, pt.y, targetVal);
        } else if (cutoutSubTool === 'brush_keep' || cutoutSubTool === 'brush_erase') {
            saveMaskToHistory();
            isDrawingCutout = true;
            const val = (cutoutSubTool === 'brush_keep') ? 255 : 0;
            paintMaskCircle(pt.x, pt.y, cutoutBrushSize, val);
            renderCutoutCanvas();
        }
    });

    canvas.addEventListener('mousemove', (e) => {
        if (!isDrawingCutout || !cutoutImgData) return;
        const pt = getCanvasImageCoords(e);
        if (cutoutSubTool === 'lasso') {
            const last = lassoPoints[lassoPoints.length - 1];
            if (!last || Math.hypot(pt.x - last.x, pt.y - last.y) > Math.max(6, cutoutImgData.width / 150)) {
                lassoPoints.push(pt);
                renderCutoutCanvas();
            }
        } else if (cutoutSubTool === 'brush_keep' || cutoutSubTool === 'brush_erase') {
            const val = (cutoutSubTool === 'brush_keep') ? 255 : 0;
            paintMaskCircle(pt.x, pt.y, cutoutBrushSize, val);
            renderCutoutCanvas();
        }
    });

    window.addEventListener('mouseup', () => {
        if (isDrawingCutout) {
            isDrawingCutout = false;
        }
    });

    canvas.addEventListener('dblclick', (e) => {
        if (cutoutSubTool === 'lasso' && lassoPoints.length >= 3) {
            e.preventDefault();
            applyPolygonLasso();
        }
    });
}

/* === EXÉCUTION UNIFIÉE : REMPLACER OU EXTRAIRE COMME NOUVELLE IMAGE === */
async function executeVisualIsolation(actionMode) {
    if (currentModalIndex < 0) return;
    const item = appState.dataset[currentModalIndex];

    if (studioToolMode === 'crop') {
        if (!cropper) return;
        const data = cropper.getData(true);
        const res = await fetch('api/crop', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                image: item.image,
                mode: actionMode,
                source: 'dataset',
                x: data.x,
                y: data.y,
                w: data.width,
                h: data.height,
                target_w: currentTargetW,
                target_h: currentTargetH
            })
        });
        const ans = await res.json();
        await fetchState();
        if (actionMode === 'replace') {
            openStudio(currentModalIndex);
        } else {
            const newIdx = appState.dataset.findIndex(x => x.image === ans.image);
            if (newIdx !== -1) openStudio(newIdx);
        }
    } else {
        // Mode Détourage : si un polygone lasso est ouvert et non validé, on l'applique d'abord
        if (lassoPoints.length >= 3) {
            applyPolygonLasso();
        }
        const bbox = getBoundingBoxOfKeptMask();
        if (!bbox) {
            return alert("Attention : toute l'image est actuellement exclue ! Gardez au moins une partie signifiante avant de valider.");
        }

        // Génère un PNG RGBA transparent côté client avec uniquement la zone conservée
        const w = cutoutImgData.width;
        const h = cutoutImgData.height;
        const off = document.createElement('canvas');
        off.width = w;
        off.height = h;
        const ctx = off.getContext('2d');
        const rgbaOut = ctx.createImageData(w, h);
        const src = cutoutImgData.data;
        const dst = rgbaOut.data;
        for (let i = 0; i < cutoutMask.length; i++) {
            const p = i * 4;
            dst[p] = src[p];
            dst[p + 1] = src[p + 1];
            dst[p + 2] = src[p + 2];
            dst[p + 3] = cutoutMask[i] > 127 ? 255 : 0;
        }
        ctx.putImageData(rgbaOut, 0, 0);
        const b64Png = off.toDataURL('image/png');

        const autoFit = document.getElementById('chkAutoFit')?.checked ?? true;
        const autoTagBg = document.getElementById('chkAutoTagBg')?.checked ?? true;
        const trigger = document.getElementById('triggerWord').value.trim();

        const res = await fetch('api/cutout', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                image: item.image,
                mode: actionMode,
                bg_color: cutoutBgColor,
                auto_fit: autoFit,
                auto_tag_bg: autoTagBg,
                target_w: currentTargetW,
                target_h: currentTargetH,
                trigger: trigger,
                image_b64: b64Png,
                bbox: bbox
            })
        });
        const ans = await res.json();
        if (ans.error) return alert(ans.error);

        await fetchState();
        if (actionMode === 'replace') {
            openStudio(currentModalIndex);
        } else {
            const newIdx = appState.dataset.findIndex(x => x.image === ans.image);
            if (newIdx !== -1) openStudio(newIdx);
        }
    }
}

async function resetOriginal() {
    const item = appState.dataset[currentModalIndex];
    const res = await fetch('api/reset_crop', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ image: item.image })
    });
    if (res.ok) {
        await fetchState();
        openStudio(currentModalIndex);
    } else {
        alert("Aucun original distinct trouvé.");
    }
}

/* === LOGIQUE MULTI-TAGS SANS DOUBLONS === */
function parseTagList(str) {
    return (str || '').split(',').map(s => s.trim()).filter(Boolean);
}

function getCaptionParts() {
    return parseTagList(document.getElementById('modalCaption').value);
}

function renderPills() {
    const container = document.getElementById('pillsContainer');
    let html = '';
    for (const [cat, tags] of Object.entries(appState.tags_config)) {
        html += `<div class="cat-block"><div class="cat-title">${cat}</div><div class="pills-wrap">`;
        for (const t of tags) {
            const safeEn = t.en.replace(/"/g, '&quot;');
            html += `<span class="tag-pill" data-en="${safeEn}" title="${safeEn}" onclick="togglePill(this)">${t.fr}</span>`;
        }
        html += `</div></div>`;
    }
    container.innerHTML = html;
}

function syncPillsWithTextarea() {
    const parts = getCaptionParts();
    const partsLowerSet = new Set(parts.map(p => p.toLowerCase()));

    document.querySelectorAll('.tag-pill, .ai-pill[data-en]').forEach(pill => {
        const subTags = parseTagList(pill.getAttribute('data-en')).map(s => s.toLowerCase());
        if (!subTags.length) return;

        const matchCount = subTags.filter(st => partsLowerSet.has(st)).length;
        pill.classList.remove('active', 'partial');
        if (matchCount === subTags.length) {
            pill.classList.add('active');
        } else if (matchCount > 0) {
            pill.classList.add('partial');
        }
    });

    renderActiveTokensBar(parts);
}

function renderActiveTokensBar(parts) {
    const bar = document.getElementById('activeTokensBar');
    if (!bar) return;
    const trigger = document.getElementById('triggerWord').value.trim().toLowerCase();

    if (!parts.length) {
        bar.innerHTML = '<span style="color:#64748b; font-size:0.74rem;">Aucun tag actif</span>';
        return;
    }

    bar.innerHTML = parts.map(p => {
        const isTrigger = (p.toLowerCase() === trigger);
        const safeP = p.replace(/"/g, '&quot;');
        if (isTrigger) {
            return `<span class="token-chip trigger-chip" title="Mot-clé déclencheur du style">🔒 ${p}</span>`;
        }
        return `<span class="token-chip" data-token="${safeP}" onclick="removeSingleToken(this.getAttribute('data-token'))" title="Cliquer pour retirer ce tag">${p} ✕</span>`;
    }).join('');
}

function toggleTagString(enTagString) {
    const subTags = parseTagList(enTagString);
    if (!subTags.length) return;

    const trigger = document.getElementById('triggerWord').value.trim();
    let parts = getCaptionParts();
    if (parts.length === 0 && trigger) {
        parts.push(trigger);
    }

    const partsLowerSet = new Set(parts.map(p => p.toLowerCase()));
    const subTagsLower = subTags.map(s => s.toLowerCase());

    const allPresent = subTagsLower.every(st => partsLowerSet.has(st));

    if (allPresent) {
        const toRemove = new Set(subTagsLower);
        parts = parts.filter(p => !toRemove.has(p.toLowerCase()));
    } else {
        for (const st of subTags) {
            if (!partsLowerSet.has(st.toLowerCase())) {
                parts.push(st);
                partsLowerSet.add(st.toLowerCase());
            }
        }
    }

    document.getElementById('modalCaption').value = parts.join(', ');
    syncPillsWithTextarea();
    saveCurrentModalCaption();
}

function togglePill(pillEl) {
    const enTag = pillEl.getAttribute('data-en');
    toggleTagString(enTag);
}

function removeSingleToken(tokenStr) {
    let parts = getCaptionParts();
    const target = tokenStr.trim().toLowerCase();
    parts = parts.filter(p => p.toLowerCase() !== target);
    document.getElementById('modalCaption').value = parts.join(', ');
    syncPillsWithTextarea();
    saveCurrentModalCaption();
}

function onModalCaptionInput() {
    syncPillsWithTextarea();
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveCurrentModalCaption, 400);
}

async function saveCurrentModalCaption() {
    if (currentModalIndex < 0) return;
    const item = appState.dataset[currentModalIndex];
    const val = document.getElementById('modalCaption').value.trim();
    item.caption = val;
    await fetch('api/caption', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ image: item.image, caption: val })
    });
    const ind = document.getElementById('saveIndicator');
    ind.style.opacity = 1;
    setTimeout(() => ind.style.opacity = 0, 1200);
}

function copyPrevCaption() {
    if (currentModalIndex > 0) {
        const prev = appState.dataset[currentModalIndex - 1].caption;
        document.getElementById('modalCaption').value = prev;
        syncPillsWithTextarea();
        saveCurrentModalCaption();
    }
}

async function addCustomTag(customCategory = null, frVal = null, enVal = null) {
    const cat = customCategory || document.getElementById('customCat').value || 'Personnalisé';
    const fr = (frVal !== null) ? frVal : document.getElementById('customFr').value.trim();
    const en = (enVal !== null) ? enVal : document.getElementById('customEn').value.trim();
    if (!fr || !en) return alert("Remplissez le libellé FR et sa traduction EN.");

    const res = await fetch('api/custom_tag', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ category: cat, fr: fr, en: en })
    });
    const data = await res.json();
    appState.tags_config = data.tags_config;
    if (frVal === null) {
        document.getElementById('customFr').value = '';
        document.getElementById('customEn').value = '';
    }
    renderPills();
    syncPillsWithTextarea();
    populateBatchSelect();
}

/* === COPILOTE IA GEMINI VISION (SUGGESTIONS, AUDIT, TRADUCTION) === */
async function runAiCopilot(mode) {
    if (currentModalIndex < 0) return;
    const item = appState.dataset[currentModalIndex];
    const trigger = document.getElementById('triggerWord').value.trim();
    const currentCaption = document.getElementById('modalCaption').value.trim();
    const drawer = document.getElementById('copilotDrawer');

    let payload = {
        mode: mode,
        image: item.image,
        caption: currentCaption,
        trigger: trigger
    };

    if (mode === 'translate') {
        const inputEl = document.getElementById('quickFrInput');
        const textFr = inputEl.value.trim();
        if (!textFr) return alert("Décrivez d'abord le sujet en français (ex: chat assis, masque à cornes...).");
        payload.text_fr = textFr;
    }

    drawer.classList.remove('hidden');
    drawer.innerHTML = `<div style="color:#38bdf8;">⏳ Analyse Gemini (${appState.gemini_model || 'gemini-3.8-flash'}) en cours...</div>`;

    try {
        const res = await fetch('api/ai_copilot', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (!res.ok || data.error) {
            drawer.innerHTML = `<div style="color:#f87171;">⚠️ ${data.error || 'Erreur API'}</div>`;
            if ((data.error || '').includes('Clé API')) {
                promptGeminiKey();
            }
            return;
        }

        if (mode === 'suggest') {
            renderSuggestDrawer(data);
        } else if (mode === 'audit') {
            renderAuditDrawer(data);
        } else if (mode === 'translate') {
            document.getElementById('quickFrInput').value = '';
            if (data.combined_en) {
                toggleTagString(data.combined_en);
            }
            renderTranslateDrawer(data);
        }
        syncPillsWithTextarea();
    } catch (err) {
        drawer.innerHTML = `<div style="color:#f87171;">⚠️ Erreur réseau : ${err.message}</div>`;
    }
}

function renderSuggestDrawer(data) {
    const drawer = document.getElementById('copilotDrawer');
    const list = data.suggestions || [];
    let html = `
        <div class="copilot-drawer-header">
            <span>🔍 <strong>Suggestions IA :</strong> ${data.summary_fr || 'Cliquez pour ajouter au .txt (📌 pour sauver en puce permanente)'}</span>
            <button class="btn secondary sm" style="padding:2px 6px;" onclick="document.getElementById('copilotDrawer').classList.add('hidden')">✕</button>
        </div>
        <div class="pills-wrap">
    `;
    for (const s of list) {
        const safeEn = s.en.replace(/"/g, '&quot;');
        const safeFr = s.fr.replace(/"/g, '&quot;');
        html += `
            <span class="ai-pill" data-en="${safeEn}" title="Tag EN : ${safeEn}" onclick="togglePill(this)">
                <span>${s.fr} <small style="opacity:0.75;">(${s.en})</small></span>
                <span class="pin-btn" title="Épingler définitivement dans mes puces Sujets" onclick="event.stopPropagation(); pinAiTag('${safeFr}', '${safeEn}')">📌</span>
            </span>
        `;
    }
    html += `</div>`;
    drawer.innerHTML = html;
}

function renderAuditDrawer(data) {
    const drawer = document.getElementById('copilotDrawer');
    const scoreColor = data.score >= 8 ? '#4ade80' : (data.score >= 5 ? '#facc15' : '#f87171');
    const missing = data.missing_tags || [];
    const forbidden = data.forbidden_tags || [];

    let html = `
        <div class="copilot-drawer-header">
            <span>🛡️ <strong>Audit Dissociation : <span style="color:${scoreColor}">${data.score}/10</span></strong> — ${data.verdict_fr}</span>
            <button class="btn secondary sm" style="padding:2px 6px;" onclick="document.getElementById('copilotDrawer').classList.add('hidden')">✕</button>
        </div>
    `;

    if (missing.length > 0) {
        html += `<div style="margin-top:4px; margin-bottom:4px; color:#94a3b8;">➕ <strong>Oublis détectés</strong> (cliquez pour ajouter et éviter qu'ils ne polluent le style) :</div><div class="pills-wrap">`;
        for (const m of missing) {
            const safeEn = m.en.replace(/"/g, '&quot;');
            const safeFr = m.fr.replace(/"/g, '&quot;');
            html += `
                <span class="ai-pill" data-en="${safeEn}" onclick="togglePill(this)">
                    <span>+ ${m.fr} <small style="opacity:0.75;">(${m.en})</small></span>
                    <span class="pin-btn" title="Épingler dans mes puces" onclick="event.stopPropagation(); pinAiTag('${safeFr}', '${safeEn}')">📌</span>
                </span>
            `;
        }
        html += `</div>`;
    }

    if (forbidden.length > 0) {
        html += `<div style="margin-top:6px; margin-bottom:4px; color:#fca5a5;">⚠️ <strong>Tags de style parasites à retirer</strong> (cliquez pour supprimer) :</div><div class="pills-wrap">`;
        for (const f of forbidden) {
            const safeEn = f.replace(/"/g, '&quot;');
            html += `<span class="ai-pill danger-pill" data-en="${safeEn}" onclick="removeSingleToken('${safeEn}')">🗑️ Retirer "${f}"</span>`;
        }
        html += `</div>`;
    }

    drawer.innerHTML = html;
}

function renderTranslateDrawer(data) {
    const drawer = document.getElementById('copilotDrawer');
    const tags = data.tags || [];
    let html = `
        <div class="copilot-drawer-header">
            <span>🌐 <strong>Ajouté au label :</strong> <code>${data.combined_en}</code> (cliquez sur 📌 pour conserver une puce)</span>
            <button class="btn secondary sm" style="padding:2px 6px;" onclick="document.getElementById('copilotDrawer').classList.add('hidden')">✕</button>
        </div>
        <div class="pills-wrap">
    `;
    for (const t of tags) {
        const safeEn = t.en.replace(/"/g, '&quot;');
        const safeFr = t.fr.replace(/"/g, '&quot;');
        html += `
            <span class="ai-pill active" data-en="${safeEn}" onclick="togglePill(this)">
                <span>${t.fr} (${t.en})</span>
                <span class="pin-btn" title="Épingler dans mes puces Sujets" onclick="event.stopPropagation(); pinAiTag('${safeFr}', '${safeEn}')">📌</span>
            </span>
        `;
    }
    html += `</div>`;
    drawer.innerHTML = html;
}

async function pinAiTag(fr, en) {
    const defaultCat = Object.keys(appState.tags_config)[1] || '2. Sujets & Motifs Figuratifs (Le Contenu à dissocier)';
    await addCustomTag(defaultCat, fr, en);
}

/* === RACCOURCIS CLAVIER === */
document.addEventListener('keydown', (e) => {
    const modalOpen = !document.getElementById('studioModal').classList.contains('hidden');
    if (!modalOpen) return;
    if (document.activeElement.tagName === 'TEXTAREA' || document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT') {
        if (e.key === 'Escape') closeModal();
        return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && studioToolMode === 'cutout') {
        e.preventDefault();
        undoCutoutStep();
        return;
    }
    if (e.key === 'Enter' && studioToolMode === 'cutout' && cutoutSubTool === 'lasso' && lassoPoints.length >= 3) {
        e.preventDefault();
        applyPolygonLasso();
        return;
    }
    if (e.key === 'ArrowRight') navigateModal(1);
    if (e.key === 'ArrowLeft') navigateModal(-1);
    if (e.key === 'Escape') closeModal();
});

/* === TRAINING & LOGS === */
async function startTraining() {
    if (!confirm("Lancer le provisionnement de la VM GPU A10 et démarrer l'apprentissage ?")) return;
    const payload = {
        trigger: document.getElementById('triggerWord').value,
        steps: document.getElementById('stepsInput').value,
        lr: document.getElementById('lrInput').value,
        dim: document.getElementById('dimInput').value
    };
    const res = await fetch('api/train', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
    });
    const ans = await res.json();
    if (ans.error) alert(ans.error);
    pollLogs();
}

async function emergencyKill() {
    if (!confirm("Forcer la destruction immédiate de toute instance GPU en cours ?")) return;
    await fetch('api/kill', { method: 'POST' });
    pollLogs();
}

async function pollLogs() {
    const res = await fetch('api/logs');
    const data = await res.json();
    const box = document.getElementById('logsBox');
    box.textContent = data.logs || "En attente de lancement...";
    box.scrollTop = box.scrollHeight;

    const badge = document.getElementById('statusBadge');
    const btn = document.getElementById('trainBtn');
    if (data.running) {
        badge.className = 'badge running';
        badge.innerText = 'ENTRAÎNEMENT GPU EN COURS...';
        btn.disabled = true;
    } else {
        badge.className = 'badge idle';
        badge.innerText = 'VEILLE / PRÊT';
        btn.disabled = false;
    }
}

initCutoutCanvasEvents();
fetchState();
pollLogs();
setInterval(pollLogs, 3500);
