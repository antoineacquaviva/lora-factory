#!/usr/bin/env python3
import os
import json
import shutil
import subprocess
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
        "tags_config": load_tags_config()
    })

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

    for img in images:
        txt_path = (DATASET_DIR / secure_filename(img)).with_suffix('.txt')
        current = txt_path.read_text(encoding='utf-8').strip() if txt_path.exists() else trigger
        parts = [p.strip() for p in current.split(',') if p.strip()]
        if not parts:
            parts = [trigger]
        if action == 'add' and tag_en not in parts:
            parts.append(tag_en)
        elif action == 'remove' and tag_en in parts:
            parts.remove(tag_en)
        txt_path.write_text(", ".join(parts), encoding='utf-8')

    return jsonify({"status": "ok"})

@app.route('/api/custom_tag', methods=['POST'])
def api_custom_tag():
    data = request.json
    category = data.get('category', 'Personnalisé').strip()
    fr_label = data.get('fr', '').strip()
    en_tag = data.get('en', '').strip()
    if not fr_label or not en_tag:
        return jsonify({"error": "Champs requis"}), 400
    cfg = load_tags_config()
    if category not in cfg:
        cfg[category] = []
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
