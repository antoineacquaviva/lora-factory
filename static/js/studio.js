let appState = { dataset: [], models: [], tags_config: {}, has_gemini_key: false };
let currentModalIndex = -1;
let cropper = null;
let currentTargetW = 1024;
let currentTargetH = 1024;
let saveTimeout = null;
let lastAiSuggestions = []; // Garde en mÃ©moire les puces IA de l'image courante

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
    if (appState.has_gemini_key) {
        btn.innerText = 'ðŸ”‘ ClÃ© IA âœ“';
        btn.style.borderColor = '#16a34a';
    } else {
        btn.innerText = 'ðŸ”‘ ClÃ© IA ?';
        btn.style.borderColor = '#ca8a04';
    }
}

async function promptGeminiKey() {
    const msg = appState.has_gemini_key
        ? "Une clÃ© API Gemini est dÃ©jÃ  configurÃ©e sur le serveur.\nEntrez une nouvelle clÃ© pour la remplacer (ou laissez vide pour annuler) :"
        : "Entrez votre clÃ© API Google Gemini (AI Studio) :\nElle sera sauvegardÃ©e sur votre VM dans .gemini_key (ignorÃ© par Git).";
    const key = prompt(msg);
    if (key === null || key.trim() === '') return;
    const res = await fetch('api/gemini_key', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ api_key: key.trim() })
    });
    const data = await res.json();
    appState.has_gemini_key = data.has_gemini_key;
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
                <button class="btn danger sm" style="padding:2px 6px;" onclick="deleteImage('${item.image}')">âœ•</button>
            </div>
            <div class="thumb-wrap" onclick="openStudio(${idx})">
                <img src="img/dataset/${encodeURIComponent(item.image)}?t=${item.mtime}" loading="lazy">
                <span class="dim-tag">${item.width}Ã—${item.height}</span>
                <div class="studio-overlay">âœ‚ï¸ Ouvrir dans le Studio</div>
            </div>
            <div class="caption-preview" onclick="openStudio(${idx})" style="cursor:pointer;" title="${item.caption}">
                ${item.caption || '<em style="color:#64748b">Aucune lÃ©gende...</em>'}
            </div>
        </div>
    `).join('');
}

function renderModels() {
    const list = document.getElementById('modelsList');
    if (!appState.models.length) {
        list.innerHTML = '<p style="font-size:0.8rem; color:#64748b; margin:0;">Aucun filtre gÃ©nÃ©rÃ©.</p>';
        return;
    }
    list.innerHTML = appState.models.map(m => `
        <div class="model-row">
            <span>${m.name} (${m.size_mb} Mo)</span>
            <a href="models/${encodeURIComponent(m.name)}" download>TÃ©lÃ©charger</a>
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
    if (!cats.includes('PersonnalisÃ©')) cats.push('PersonnalisÃ©');
    sel.innerHTML = cats.map(c => `<option value="${c}">${c}</option>`).join('');
    if (prev && cats.includes(prev)) {
        sel.value = prev;
    } else if (cats.length > 1) {
        sel.value = cats[1]; // SÃ©lectionne par dÃ©faut "2. Sujets & Motifs Figuratifs"
    }
}

function selectAll(checked) {
    document.querySelectorAll('.img-check').forEach(cb => cb.checked = checked);
}

async function applyBatchTag(action) {
    const tagEn = document.getElementById('batchTagSelect').value;
    if (!tagEn) return alert('Choisissez un tag dans la liste dÃ©roulante.');
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

/* === STUDIO MODAL (CROPPER + PILLS + COPILOTE) === */
function openStudio(idx) {
    if (idx < 0 || idx >= appState.dataset.length) return;
    currentModalIndex = idx;
    const item = appState.dataset[idx];

    document.getElementById('studioModal').classList.remove('hidden');
    document.getElementById('modalTitle').innerText = `${idx + 1}/${appState.dataset.length} â€” ${item.image}`;
    document.getElementById('modalDims').innerText = `Actuel : ${item.width}Ã—${item.height}`;
    document.getElementById('modalCaption').value = item.caption;

    // RÃ©initialise le tiroir Copilote lors du changement d'image
    lastAiSuggestions = [];
    const drawer = document.getElementById('copilotDrawer');
    if (drawer) {
        drawer.classList.add('hidden');
        drawer.innerHTML = '';
    }

    renderPills();
    syncPillsWithTextarea();

    const imgEl = document.getElementById('cropImage');
    if (cropper) {
        cropper.destroy();
        cropper = null;
    }
    imgEl.src = `/img/dataset/${encodeURIComponent(item.image)}?t=${Date.now()}`;
    imgEl.onload = () => {
        cropper = new Cropper(imgEl, {
            aspectRatio: currentTargetW / currentTargetH,
            viewMode: 1,
            autoCropArea: 0.95,
            background: true,
            responsive: true
        });
    };
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
    document.querySelectorAll('.crop-toolbar .btn').forEach(b => b.classList.remove('active-ratio'));
    if (btnEl) btnEl.classList.add('active-ratio');
    if (cropper) cropper.setAspectRatio(ratio);
}

async function executeCrop(mode) {
    if (!cropper) return;
    const item = appState.dataset[currentModalIndex];
    const data = cropper.getData(true);

    const res = await fetch('api/crop', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            image: item.image,
            mode: mode,
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
    if (mode === 'replace') {
        openStudio(currentModalIndex);
    } else {
        const newIdx = appState.dataset.findIndex(x => x.image === ans.image);
        if (newIdx !== -1) openStudio(newIdx);
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
        alert("Aucun original distinct trouvÃ©.");
    }
}

/* === LOGIQUE MULTI-TAGS SANS DOUBLONS (AXE 1 & AXE 2) === */
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

    // 1. Synchronise les puces permanentes ET les puces IA du tiroir (supporte les tags contenant des virgules)
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

    // 2. Affiche les jetons actifs sous forme de badges cliquables
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
            return `<span class="token-chip trigger-chip" title="Mot-clÃ© dÃ©clencheur du style">ðŸ”’ ${p}</span>`;
        }
        return `<span class="token-chip" data-token="${safeP}" onclick="removeSingleToken(this.getAttribute('data-token'))" title="Cliquer pour retirer ce tag">${p} âœ•</span>`;
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

    // Si TOUS les sous-tags de la puce sont prÃ©sents -> on les retire tous
    const allPresent = subTagsLower.every(st => partsLowerSet.has(st));

    if (allPresent) {
        const toRemove = new Set(subTagsLower);
        parts = parts.filter(p => !toRemove.has(p.toLowerCase()));
    } else {
        // Sinon -> on ajoute uniquement les sous-tags manquants (zÃ©ro doublon)
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
    const cat = customCategory || document.getElementById('customCat').value || 'PersonnalisÃ©';
    const fr = (frVal !== null) ? frVal : document.getElementById('customFr').value.trim();
    const en = (enVal !== null) ? enVal : document.getElementById('customEn').value.trim();
    if (!fr || !en) return alert("Remplissez le libellÃ© FR et sa traduction EN.");

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

/* === AXE 3 : COPILOTE IA GEMINI VISION (SUGGESTIONS, AUDIT, TRADUCTION) === */
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
        if (!textFr) return alert("DÃ©crivez d'abord le sujet en franÃ§ais (ex: chat assis, masque Ã  cornes...).");
        payload.text_fr = textFr;
    }

    drawer.classList.remove('hidden');
    drawer.innerHTML = `<div style="color:#38bdf8;">â³ Analyse Gemini en cours (${mode})...</div>`;

    try {
        const res = await fetch('api/ai_copilot', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (!res.ok || data.error) {
            drawer.innerHTML = `<div style="color:#f87171;">âš ï¸ ${data.error || 'Erreur API'}</div>`;
            if ((data.error || '').includes('ClÃ© API')) {
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
            // Ajoute directement les tags traduits au .txt et affiche aussi les puces pour pouvoir les Ã©pingler
            if (data.combined_en) {
                toggleTagString(data.combined_en);
            }
            renderTranslateDrawer(data);
        }
        syncPillsWithTextarea();
    } catch (err) {
        drawer.innerHTML = `<div style="color:#f87171;">âš ï¸ Erreur rÃ©seau : ${err.message}</div>`;
    }
}

function renderSuggestDrawer(data) {
    const drawer = document.getElementById('copilotDrawer');
    const list = data.suggestions || [];
    let html = `
        <div class="copilot-drawer-header">
            <span>ðŸ” <strong>Suggestions IA :</strong> ${data.summary_fr || 'Cliquez pour ajouter au .txt (ðŸ“Œ pour sauver en puce permanente)'}</span>
            <button class="btn secondary sm" style="padding:2px 6px;" onclick="document.getElementById('copilotDrawer').classList.add('hidden')">âœ•</button>
        </div>
        <div class="pills-wrap">
    `;
    for (const s of list) {
        const safeEn = s.en.replace(/"/g, '&quot;');
        const safeFr = s.fr.replace(/"/g, '&quot;');
        html += `
            <span class="ai-pill" data-en="${safeEn}" title="Tag EN : ${safeEn}" onclick="togglePill(this)">
                <span>${s.fr} <small style="opacity:0.75;">(${s.en})</small></span>
                <span class="pin-btn" title="Ã‰pingler dÃ©finitivement dans mes puces Sujets" onclick="event.stopPropagation(); pinAiTag('${safeFr}', '${safeEn}')">ðŸ“Œ</span>
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
            <span>ðŸ›¡ï¸ <strong>Audit Dissociation : <span style="color:${scoreColor}">${data.score}/10</span></strong> â€” ${data.verdict_fr}</span>
            <button class="btn secondary sm" style="padding:2px 6px;" onclick="document.getElementById('copilotDrawer').classList.add('hidden')">âœ•</button>
        </div>
    `;

    if (missing.length > 0) {
        html += `<div style="margin-top:4px; margin-bottom:4px; color:#94a3b8;">âž• <strong>Oublis dÃ©tectÃ©s</strong> (cliquez pour ajouter et Ã©viter qu'ils ne polluent le style) :</div><div class="pills-wrap">`;
        for (const m of missing) {
            const safeEn = m.en.replace(/"/g, '&quot;');
            const safeFr = m.fr.replace(/"/g, '&quot;');
            html += `
                <span class="ai-pill" data-en="${safeEn}" onclick="togglePill(this)">
                    <span>+ ${m.fr} <small style="opacity:0.75;">(${m.en})</small></span>
                    <span class="pin-btn" title="Ã‰pingler dans mes puces" onclick="event.stopPropagation(); pinAiTag('${safeFr}', '${safeEn}')">ðŸ“Œ</span>
                </span>
            `;
        }
        html += `</div>`;
    }

    if (forbidden.length > 0) {
        html += `<div style="margin-top:6px; margin-bottom:4px; color:#fca5a5;">âš ï¸ <strong>Tags de style parasites Ã  retirer</strong> (cliquez pour supprimer) :</div><div class="pills-wrap">`;
        for (const f of forbidden) {
            const safeEn = f.replace(/"/g, '&quot;');
            html += `<span class="ai-pill danger-pill" data-en="${safeEn}" onclick="removeSingleToken('${safeEn}')">ðŸ—‘ï¸ Retirer "${f}"</span>`;
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
            <span>ðŸŒ <strong>AjoutÃ© au label :</strong> <code>${data.combined_en}</code> (cliquez sur ðŸ“Œ pour conserver une puce)</span>
            <button class="btn secondary sm" style="padding:2px 6px;" onclick="document.getElementById('copilotDrawer').classList.add('hidden')">âœ•</button>
        </div>
        <div class="pills-wrap">
    `;
    for (const t of tags) {
        const safeEn = t.en.replace(/"/g, '&quot;');
        const safeFr = t.fr.replace(/"/g, '&quot;');
        html += `
            <span class="ai-pill active" data-en="${safeEn}" onclick="togglePill(this)">
                <span>${t.fr} (${t.en})</span>
                <span class="pin-btn" title="Ã‰pingler dans mes puces Sujets" onclick="event.stopPropagation(); pinAiTag('${safeFr}', '${safeEn}')">ðŸ“Œ</span>
            </span>
        `;
    }
    html += `</div>`;
    drawer.innerHTML = html;
}

async function pinAiTag(fr, en) {
    const defaultCat = Object.keys(appState.tags_config)[1] || '2. Sujets & Motifs Figuratifs (Le Contenu Ã  dissocier)';
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
    if (e.key === 'ArrowRight') navigateModal(1);
    if (e.key === 'ArrowLeft') navigateModal(-1);
    if (e.key === 'Escape') closeModal();
});

/* === TRAINING & LOGS === */
async function startTraining() {
    if (!confirm("Lancer le provisionnement de la VM GPU A10 et dÃ©marrer l'apprentissage ?")) return;
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
    if (!confirm("Forcer la destruction immÃ©diate de toute instance GPU en cours ?")) return;
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
        badge.innerText = 'ENTRAÃŽNEMENT GPU EN COURS...';
        btn.disabled = true;
    } else {
        badge.className = 'badge idle';
        badge.innerText = 'VEILLE / PRÃŠT';
        btn.disabled = false;
    }
}

fetchState();
pollLogs();
setInterval(pollLogs, 3500);

