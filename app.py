#!/usr/bin/env python3
import os
import json
import base64
import shutil
import subprocess
import urllib.request
import urllib.error
from io import BytesIO
from pathlib import Path
from PIL import Image
from flask import Flask, request, jsonify, send_from_directory, render_template
from werkzeug.utils import secure_filename

app = Flask(__name__)

BASE_DIR = Path(__file__).resolve().parent
ORIGINALS_DIR = BASE_DIR / "originals"
DATASET_DIR = BASE_DIR / "dataset"
MODELS_DIR = BASE_DIR / "models"
SCRIPTS_DIR = BASE_DIR / "scripts"
TAGS_FILE = BASE_DIR / "tags_config.json"
LOG_FILE = BASE_DIR / "training.log"
PID_FILE = BASE_DIR / "training.pid"
GEMINI_KEY_FILE = BASE_DIR / ".gemini_key"

for d in [ORIGINALS_DIR, DATASET_DIR, MODELS_DIR, SCRIPTS_DIR]:
    d.mkdir(parents=True, exist_ok=True)

ALLOWED_EXTS = {'.jpg', '.jpeg', '.png', '.webp'}

def is_running():
    if not PID_FILE.exists():
        return False
    try:
        pid = int(PID_FILE.read_text().strip())
        os.kill(pid, 0)
        return True
    except Exception:
        return False

def load_tags_config():
    if TAGS_FILE.exists():
        return json.loads(TAGS_FILE.read_text(encoding='utf-8'))
    return {}

def get_gemini_api_key():
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if key:
        return key
    if GEMINI_KEY_FILE.exists():
        return GEMINI_KEY_FILE.read_text(encoding='utf-8').strip()
    return ""

def split_subtags(tag_str):
    return [p.strip() for p in tag_str.split(',') if p.strip()]

def call_gemini_api(parts, response_schema=None, temperature=0.2):
    api_key = get_gemini_api_key()
    if not api_key:
        raise ValueError("Clé API Gemini manquante. Configurez-la via le bouton ⚙️ Clé API dans le Studio ou via la variable d'environnement GEMINI_API_KEY.")

    model = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"

    payload = {
        "contents": [{"parts": parts}],
        "generationConfig": {
            "temperature": temperature,
            "responseMimeType": "application/json"
        }
    }
    if response_schema:
        payload["generationConfig"]["responseSchema"] = response_schema

    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json'},
        method='POST'
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            res_data = json.loads(resp.read().decode('utf-8'))
            text_out = res_data["candidates"][0]["content"]["parts"][0]["text"]
            return json.loads(text_out)
    except urllib.error.HTTPError as e:
        err_body = e.read().decode('utf-8', errors='replace')
        raise RuntimeError(f"Erreur API Gemini ({e.code}) : {err_body}")

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/state')
def api_state():
    items = []
    for f in sorted(DATASET_DIR.iterdir()):
        if f.suffix.lower() in ALLOWED_EXTS:
            txt_file = f.with_suffix('.txt')
            caption = txt_file.read_text(encoding='utf-8').strip() if txt_file.exists() else ""
            has_orig = (ORIGINALS_DIR / f.name).exists()
            try:
                with Image.open(f) as im:
                    w, h = im.size
            except Exception:
                w, h = 0, 0
            items.append({
                "image": f.name,
                "caption": caption,
                "has_original": has_orig,
                "width": w,
                "height": h,
                "mtime": int(f.stat().st_mtime)
            })
    models = []
    for m in sorted(MODELS_DIR.glob("*.safetensors"), key=os.path.getmtime, reverse=True):
        models.append({
            "name": m.name,
            "size_mb": round(m.stat().st_size / (1024 * 1024), 1),
            "date": int(m.stat().st_mtime)
        })
    return jsonify({
        "dataset": items,
        "models": models,
        "tags_config": load_tags_config(),
        "has_gemini_key": bool(get_gemini_api_key())
    })

@app.route('/api/gemini_key', methods=['POST'])
def api_save_gemini_key():
    data = request.json or {}
    key = data.get('api_key', '').strip()
    if key:
        GEMINI_KEY_FILE.write_text(key, encoding='utf-8')
        os.chmod(GEMINI_KEY_FILE, 0o600)
    elif GEMINI_KEY_FILE.exists():
        GEMINI_KEY_FILE.unlink()
    return jsonify({"status": "ok", "has_gemini_key": bool(get_gemini_api_key())})

@app.route('/api/ai_copilot', methods=['POST'])
def api_ai_copilot():
    data = request.json or {}
    mode = data.get('mode', 'suggest') # 'suggest', 'audit', or 'translate'
    trigger = data.get('trigger', 'culturax_style').strip()

    try:
        if mode == 'translate':
            fr_text = data.get('text_fr', '').strip()
            if not fr_text:
                return jsonify({"error": "Texte français vide"}), 400
            prompt = f"""You are an expert Stable Diffusion XL (SDXL) dataset captioner for a style LoRA triggered by '{trigger}'.
Translate the following French subject/element description into concise, comma-separated English SDXL booru/natural tags describing ONLY the literal subject, object, anatomy, posture, or material/background mentioned.
CRITICAL RULE: Do NOT add generic style adjectives (like 'tribal', 'ethnic', 'geometric', 'abstract', 'artistic') so they don't bleed into the style trigger word.
French input: "{fr_text}"
Return a JSON object with:
- "tags": list of objects with "fr" (short French label) and "en" (concise English SDXL tag, without internal commas)
- "combined_en": single comma-separated string of all the English tags."""
            schema = {
                "type": "OBJECT",
                "properties": {
                    "tags": {
                        "type": "ARRAY",
                        "items": {
                            "type": "OBJECT",
                            "properties": {
                                "fr": {"type": "STRING"},
                                "en": {"type": "STRING"}
                            },
                            "required": ["fr", "en"]
                        }
                    },
                    "combined_en": {"type": "STRING"}
                },
                "required": ["tags", "combined_en"]
            }
            res = call_gemini_api([{"text": prompt}], response_schema=schema, temperature=0.1)
            return jsonify(res)

        # Modes 'suggest' and 'audit' require reading the image
        img_name = secure_filename(data.get('image', ''))
        img_path = DATASET_DIR / img_name
        if not img_path.exists():
            return jsonify({"error": "Image introuvable"}), 404

        current_caption = data.get('caption', '').strip()

        # Resize image in memory to max 768px to keep latency & token usage tiny
        with Image.open(img_path) as im:
            im = im.convert("RGB")
            im.thumbnail((768, 768), Image.Resampling.LANCZOS)
            buf = BytesIO()
            im.save(buf, format="JPEG", quality=85)
            b64_img = base64.b64encode(buf.getvalue()).decode('utf-8')

        img_part = {
            "inlineData": {
                "mimeType": "image/jpeg",
                "data": b64_img
            }
        }

        if mode == 'suggest':
            prompt = f"""Tu es un expert en création de datasets pour l'entraînement de LoRA de style graphique sur Stable Diffusion XL (SDXL).
Le mot-clé déclencheur du style est `{trigger}`.
Principe fondamental de dissociation (Disentanglement) :
- Tout ce qui est décrit dans la légende `.txt` sera dissocié du mot-clé `{trigger}`.
- Tout ce qui N'EST PAS décrit sera absorbé par `{trigger}`.
- Tu dois identifier les SUJETS FIGURATIFS SPÉCIFIQUES (ex: chat, oiseau, masque cornu, femme de profil, guerrier, serpent, poterie, collier...), les détails anatomiques/postures, le support matériel et le fond visibles sur cette image.
- INTERDICTION ABSOLUE de décrire le style graphique, les motifs géométriques, la symétrie artistique, le coup de pinceau ou l'esthétique culturelle (car c'est exactement ce que `{trigger}` doit apprendre).

Légende actuelle de l'image : "{current_caption}"

Propose entre 5 et 8 puces de tags pertinents (en privilégiant les sujets figuratifs spécifiques et les éléments visibles qui ne sont pas encore dans la légende actuelle).
Chaque puce doit avoir :
- "fr": nom court et clair en français (ex: "Chat assis", "Oiseau stylisé", "Cornes recourbées", "Vue de profil")
- "en": tag anglais précis pour SDXL, SANS virgule interne (ex: "sitting cat figure", "bird motif", "curved horns", "side profile view")
- "category": "sujet" (pour le sujet figuratif/anatomie) ou "support_fond" (pour le contenant, matériau, cadrage ou fond)."""

            schema = {
                "type": "OBJECT",
                "properties": {
                    "suggestions": {
                        "type": "ARRAY",
                        "items": {
                            "type": "OBJECT",
                            "properties": {
                                "fr": {"type": "STRING"},
                                "en": {"type": "STRING"},
                                "category": {"type": "STRING"}
                            },
                            "required": ["fr", "en", "category"]
                        }
                    },
                    "summary_fr": {"type": "STRING"}
                },
                "required": ["suggestions", "summary_fr"]
            }
            res = call_gemini_api([img_part, {"text": prompt}], response_schema=schema, temperature=0.2)
            return jsonify(res)

        elif mode == 'audit':
            prompt = f"""Tu es un auditeur expert de datasets LoRA de style pour Stable Diffusion XL (SDXL).
Le mot-clé déclencheur du style est `{trigger}`.
Examine attentivement l'image et sa légende actuelle : "{current_caption}"

Vérifie deux risques critiques :
1. FUITE DE SUJET / MATÉRIAU (Oublis) : Quels éléments figuratifs concrets (animal, objet, personne, posture, accessoire, matériau, fond) sont visibles dans l'image mais ABSENTS de la légende actuelle ? S'ils ne sont pas tagués, `{trigger}` va les mémoriser par erreur.
2. FUITE DE STYLE (Tags parasites) : Y a-t-il des mots dans la légende actuelle qui décrivent le style artistique/géométrique/culturel et qu'il faudrait RETIRER pour laisser `{trigger}` l'apprendre ?

Réponds en JSON avec :
- "score": note de qualité du label sur 10 (entier)
- "verdict_fr": diagnostic synthétique en français (1 à 2 phrases)
- "missing_tags": liste de puces {"fr", "en"} qu'il faut ajouter pour protéger `{trigger}` (sans virgule interne dans "en")
- "forbidden_tags": liste des tags anglais exacts présents dans la légende actuelle qui décrivent le style et devraient être supprimés (liste vide si aucun)."""

            schema = {
                "type": "OBJECT",
                "properties": {
                    "score": {"type": "INTEGER"},
                    "verdict_fr": {"type": "STRING"},
                    "missing_tags": {
                        "type": "ARRAY",
                        "items": {
                            "type": "OBJECT",
                            "properties": {
                                "fr": {"type": "STRING"},
                                "en": {"type": "STRING"}
                            },
                            "required": ["fr", "en"]
                        }
                    },
                    "forbidden_tags": {
                        "type": "ARRAY",
                        "items": {"type": "STRING"}
                    }
                },
                "required": ["score", "verdict_fr", "missing_tags", "forbidden_tags"]
            }
            res = call_gemini_api([img_part, {"text": prompt}], response_schema=schema, temperature=0.1)
            return jsonify(res)

    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/img/dataset/<path:filename>')
def serve_dataset_img(filename):
    return send_from_directory(DATASET_DIR, filename)

@app.route('/img/original/<path:filename>')
def serve_original_img(filename):
    orig = ORIGINALS_DIR / secure_filename(filename)
    if orig.exists():
        return send_from_directory(ORIGINALS_DIR, filename)
    return send_from_directory(DATASET_DIR, filename)

@app.route('/models/<path:filename>')
def download_model(filename):
    return send_from_directory(MODELS_DIR, filename, as_attachment=True)

@app.route('/api/upload', methods=['POST'])
def api_upload():
    trigger = request.form.get('trigger', 'culturax_style').strip()
    files = request.files.getlist('files')
    uploaded = 0
    for f in files:
        if f.filename:
            fname = secure_filename(f.filename)
            ext = Path(fname).suffix.lower()
            if ext in ALLOWED_EXTS:
                orig_path = ORIGINALS_DIR / fname
                data_path = DATASET_DIR / fname
                f.save(orig_path)
                shutil.copy2(orig_path, data_path)
                txt_path = data_path.with_suffix('.txt')
                if not txt_path.exists():
                    txt_path.write_text(f"{trigger}", encoding='utf-8')
                uploaded += 1
            elif ext == '.txt':
                f.save(DATASET_DIR / fname)
    return jsonify({"status": "ok", "uploaded": uploaded})

@app.route('/api/caption', methods=['POST'])
def api_caption():
    data = request.json
    img_name = secure_filename(data['image'])
    txt_path = (DATASET_DIR / img_name).with_suffix('.txt')
    txt_path.write_text(data['caption'].strip(), encoding='utf-8')
    return jsonify({"status": "saved"})

@app.route('/api/batch_caption', methods=['POST'])
def api_batch_caption():
    data = request.json
    images = data.get('images', [])
    tag_en = data.get('tag_en', '').strip()
    action = data.get('action', 'add') # 'add' or 'remove'
    trigger = data.get('trigger', 'culturax_style').strip()

    sub_tags = split_subtags(tag_en)
    sub_tags_lower = [s.lower() for s in sub_tags]

    for img in images:
        txt_path = (DATASET_DIR / secure_filename(img)).with_suffix('.txt')
        current = txt_path.read_text(encoding='utf-8').strip() if txt_path.exists() else trigger
        parts = split_subtags(current)
        if not parts and trigger:
            parts = [trigger]

        parts_lower = [p.lower() for p in parts]

        if action == 'add':
            for st, st_l in zip(sub_tags, sub_tags_lower):
                if st_l not in parts_lower:
                    parts.append(st)
                    parts_lower.append(st_l)
        elif action == 'remove':
            parts = [p for p in parts if p.lower() not in sub_tags_lower]

        txt_path.write_text(", ".join(parts), encoding='utf-8')

    return jsonify({"status": "ok"})

@app.route('/api/custom_tag', methods=['POST'])
def api_custom_tag():
    data = request.json
    category = data.get('category', '2. Sujets & Motifs Figuratifs (Le Contenu à dissocier)').strip()
    fr_label = data.get('fr', '').strip()
    en_tag = data.get('en', '').strip()
    if not fr_label or not en_tag:
        return jsonify({"error": "Champs requis"}), 400
    cfg = load_tags_config()
    if category not in cfg:
        cfg[category] = []
    # Avoid duplicate in same category
    if not any(t['en'].lower() == en_tag.lower() for t in cfg[category]):
        cfg[category].append({"fr": fr_label, "en": en_tag})
        TAGS_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding='utf-8')
    return jsonify({"status": "ok", "tags_config": cfg})

@app.route('/api/crop', methods=['POST'])
def api_crop():
    data = request.json
    img_name = secure_filename(data['image'])
    mode = data.get('mode', 'replace') # 'replace' or 'extract'
    x = float(data['x'])
    y = float(data['y'])
    w = float(data['w'])
    h = float(data['h'])
    target_w = int(data.get('target_w', 1024))
    target_h = int(data.get('target_h', 1024))
    source_type = data.get('source', 'original') # 'original' or 'dataset'

    src_path = ORIGINALS_DIR / img_name if (source_type == 'original' and (ORIGINALS_DIR / img_name).exists()) else DATASET_DIR / img_name
    if not src_path.exists():
        return jsonify({"error": "Image introuvable"}), 404

    with Image.open(src_path) as im:
        im = im.convert("RGB")
        crop_box = (int(max(0, x)), int(max(0, y)), int(min(im.width, x + w)), int(min(im.height, y + h)))
        cropped = im.crop(crop_box)
        resized = cropped.resize((target_w, target_h), Image.Resampling.LANCZOS)

        if mode == 'replace':
            dest_name = img_name
            dest_path = DATASET_DIR / dest_name
            resized.save(dest_path, quality=95)
        else:
            stem = Path(img_name).stem
            ext = Path(img_name).suffix
            idx = 1
            while (DATASET_DIR / f"{stem}_crop{idx}{ext}").exists():
                idx += 1
            dest_name = f"{stem}_crop{idx}{ext}"
            dest_path = DATASET_DIR / dest_name
            resized.save(dest_path, quality=95)
            shutil.copy2(src_path, ORIGINALS_DIR / dest_name)
            src_txt = (DATASET_DIR / img_name).with_suffix('.txt')
            dest_txt = dest_path.with_suffix('.txt')
            if src_txt.exists():
                shutil.copy2(src_txt, dest_txt)
            else:
                dest_txt.write_text("culturax_style", encoding='utf-8')

    return jsonify({"status": "ok", "image": dest_name})

@app.route('/api/reset_crop', methods=['POST'])
def api_reset_crop():
    data = request.json
    img_name = secure_filename(data['image'])
    orig_path = ORIGINALS_DIR / img_name
    dest_path = DATASET_DIR / img_name
    if orig_path.exists():
        shutil.copy2(orig_path, dest_path)
        return jsonify({"status": "ok"})
    return jsonify({"error": "Aucun original sauvegardé pour cette image"}), 404

@app.route('/api/delete/<path:filename>', methods=['DELETE'])
def api_delete(filename):
    fname = secure_filename(filename)
    for folder in [DATASET_DIR, ORIGINALS_DIR]:
        p = folder / fname
        if p.exists():
            p.unlink()
        txt = p.with_suffix('.txt')
        if txt.exists():
            txt.unlink()
    return jsonify({"status": "deleted"})

@app.route('/api/train', methods=['POST'])
def api_train():
    if is_running():
        return jsonify({"error": "Un entraînement est déjà en cours !"}), 400
    data = request.json or {}
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["LORA_STEPS"] = str(int(data.get("steps", 1200)))
    env["LORA_LR"] = str(data.get("lr", "1e-4"))
    env["LORA_DIM"] = str(int(data.get("dim", 32)))
    env["LORA_TRIGGER"] = str(data.get("trigger", "culturax_style")).strip()

    log_f = open(LOG_FILE, "w", encoding="utf-8")
    proc = subprocess.Popen(
        ["/usr/bin/python3", "-u", str(SCRIPTS_DIR / "orchestrate.py")],
        stdout=log_f, stderr=subprocess.STDOUT, env=env
    )
    PID_FILE.write_text(str(proc.pid))
    return jsonify({"status": "started", "pid": proc.pid})

@app.route('/api/kill', methods=['POST'])
def api_kill():
    if is_running():
        try:
            pid = int(PID_FILE.read_text().strip())
            os.kill(pid, 9)
        except Exception:
            pass
    with open(LOG_FILE, "a", encoding="utf-8") as log_f:
        log_f.write("\n[!] COUPE-CIRCUIT D'URGENCE ACTIVÉ DEPUIS LE STUDIO WEB...\n")
        subprocess.run(["/usr/bin/python3", str(SCRIPTS_DIR / "kill_switch.py")], stdout=log_f, stderr=subprocess.STDOUT)
    return jsonify({"status": "killed"})

@app.route('/api/logs')
def api_logs():
    logs = LOG_FILE.read_text(encoding='utf-8', errors='replace')[-18000:] if LOG_FILE.exists() else ""
    return jsonify({"running": is_running(), "logs": logs})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5050)
