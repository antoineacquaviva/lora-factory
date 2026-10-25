
let appState = { dataset: [], models: [], tags_config: {} };
let currentModalIndex = -1;
let cropper = null;
let currentTargetW = 1024;
let currentTargetH = 1024;
let saveTimeout = null;

async function fetchState() {
    const res = await fetch('/api/state');
    appState = await res.json();
    renderGrid();
    renderModels();
    populateBatchSelect();
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
                <img src="/img/dataset/${encodeURIComponent(item.image)}?t=${item.mtime}" loading="lazy">
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
            <a href="/models/${encodeURIComponent(m.name)}" download>Télécharger</a>
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
            html += `<option value="${t.en}">${t.fr} (${t.en})</option>`;
        }
        html += `</optgroup>`;
    }
    sel.innerHTML = html;
    if (prev) sel.value = prev;
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

    await fetch('/api/batch_caption', {
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
    await fetch('/api/upload', { method: 'POST', body: fd });
    input.value = '';
    await fetchState();
}

async function deleteImage(imgName) {
    if (!confirm(`Supprimer ${imgName} ?`)) return;
    await fetch('/api/delete/' + encodeURIComponent(imgName), { method: 'DELETE' });
    await fetchState();
}

/* === STUDIO MODAL (CROPPER + PILLS) === */
function openStudio(idx) {
    if (idx < 0 || idx >= appState.dataset.length) return;
    currentModalIndex = idx;
    const item = appState.dataset[idx];

    document.getElementById('studioModal').classList.remove('hidden');
    document.getElementById('modalTitle').innerText = `${idx + 1}/${appState.dataset.length} — ${item.image}`;
    document.getElementById('modalDims').innerText = `Actuel : ${item.width}×${item.height}`;
    document.getElementById('modalCaption').value = item.caption;

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

    const res = await fetch('/api/crop', {
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
    const res = await fetch('/api/reset_crop', {
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

/* === TAG BUILDER === */
function renderPills() {
    const container = document.getElementById('pillsContainer');
    let html = '';
    for (const [cat, tags] of Object.entries(appState.tags_config)) {
        html += `<div class="cat-block"><div class="cat-title">${cat}</div><div class="pills-wrap">`;
        for (const t of tags) {
            const safeEn = t.en.replace(/"/g, '&quot;');
            html += `<span class="tag-pill" data-en="${safeEn}" onclick="togglePill(this)">${t.fr}</span>`;
        }
        html += `</div></div>`;
    }
    container.innerHTML = html;
}

function getCaptionParts() {
    const raw = document.getElementById('modalCaption').value;
    return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function syncPillsWithTextarea() {
    const parts = getCaptionParts().map(p => p.toLowerCase());
    document.querySelectorAll('.tag-pill').forEach(pill => {
        const en = pill.getAttribute('data-en').toLowerCase();
        if (parts.includes(en)) {
            pill.classList.add('active');
        } else {
            pill.classList.remove('active');
        }
    });
}

function togglePill(pillEl) {
    const enTag = pillEl.getAttribute('data-en');
    const trigger = document.getElementById('triggerWord').value.trim();
    let parts = getCaptionParts();

    if (parts.length === 0 && trigger) {
        parts.push(trigger);
    }

    const existingIdx = parts.findIndex(p => p.toLowerCase() === enTag.toLowerCase());
    if (existingIdx !== -1) {
        parts.splice(existingIdx, 1);
    } else {
        parts.push(enTag);
    }

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
    await fetch('/api/caption', {
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

async function addCustomTag() {
    const fr = document.getElementById('customFr').value.trim();
    const en = document.getElementById('customEn').value.trim();
    if (!fr || !en) return alert("Remplissez le libellé FR et sa traduction EN.");
    const res = await fetch('/api/custom_tag', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ category: 'Personnalisé', fr: fr, en: en })
    });
    const data = await res.json();
    appState.tags_config = data.tags_config;
    document.getElementById('customFr').value = '';
    document.getElementById('customEn').value = '';
    renderPills();
    syncPillsWithTextarea();
    populateBatchSelect();
}

/* === RACCOURCIS CLAVIER === */
document.addEventListener('keydown', (e) => {
    const modalOpen = !document.getElementById('studioModal').classList.contains('hidden');
    if (!modalOpen) return;
    if (document.activeElement.tagName === 'TEXTAREA' || document.activeElement.tagName === 'INPUT') {
        if (e.key === 'Escape') closeModal();
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
    const res = await fetch('/api/train', {
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
    await fetch('/api/kill', { method: 'POST' });
    pollLogs();
}

async function pollLogs() {
    const res = await fetch('/api/logs');
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

fetchState();
pollLogs();
setInterval(pollLogs, 3500);
