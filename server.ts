import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn, spawnSync } from 'child_process';
import express, { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { GoogleGenAI, Type } from '@google/genai';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const BASE_DIR = process.cwd();
const ORIGINALS_DIR = path.join(BASE_DIR, 'originals');
const DATASET_DIR = path.join(BASE_DIR, 'dataset');
const MODELS_DIR = path.join(BASE_DIR, 'models');
const SCRIPTS_DIR = path.join(BASE_DIR, 'scripts');
const TAGS_FILE = path.join(BASE_DIR, 'tags_config.json');
const LOG_FILE = path.join(BASE_DIR, 'training.log');
const PID_FILE = path.join(BASE_DIR, 'training.pid');
const GEMINI_KEY_FILE = path.join(BASE_DIR, '.gemini_key');
const GEMINI_MODEL_FILE = path.join(BASE_DIR, '.gemini_model');
const RUNPOD_KEY_FILE = path.join(BASE_DIR, '.runpod_key');
const RUNPOD_GPU_FILE = path.join(BASE_DIR, '.runpod_gpu');
const COLAB_TOKEN_FILE = path.join(BASE_DIR, '.colab_token');
const COLAB_JOB_FILE = path.join(BASE_DIR, 'colab_job.json');



for (const dir of [ORIGINALS_DIR, DATASET_DIR, MODELS_DIR, SCRIPTS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const ALLOWED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const BG_PRESETS: Record<string, { rgb: { r: number; g: number; b: number }; tag: string }> = {
  white: { rgb: { r: 255, g: 255, b: 255 }, tag: 'isolated on pure white background' },
  black: { rgb: { r: 0, g: 0, b: 0 }, tag: 'solid black background, studio lighting' },
  grey: { rgb: { r: 128, g: 128, b: 128 }, tag: 'neutral grey background' },
  green: { rgb: { r: 0, g: 255, b: 0 }, tag: 'solid green screen background' },
};

// RÈGLE 2 : Compatibilité double (Racine `/` dans AI Studio ET sous-chemin `/lora/` sur la VM Oracle)
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.url === '/lora') {
    req.url = '/';
  } else if (req.url.startsWith('/lora/')) {
    req.url = req.url.slice(5) || '/';
  }
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/static', express.static(path.join(BASE_DIR, 'static')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const modelDiskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
    cb(null, MODELS_DIR);
  },
  filename: (_req, file, cb) => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
    const orig = secureFilename(file.originalname || '');
    const finalName = orig.endsWith('.safetensors') && !orig.includes('filtre_culturel_v1')
      ? orig
      : `filtre_culturel_colab_${ts}.safetensors`;
    cb(null, finalName);
  },
});
const modelUpload = multer({
  storage: modelDiskStorage,
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 Go max pour les .safetensors SDXL
});

interface ColabJobState {
  jobId: string;
  status: 'IDLE' | 'WAITING_FOR_COLAB' | 'RUNNING_ON_COLAB' | 'COMPLETED' | 'ABORTED';
  steps: number;
  lr: string;
  dim: number;
  trigger: string;
  lowVram: boolean;
  createdAt: number;
  updatedAt: number;
  abortRequested: boolean;
}

function getColabJobState(): ColabJobState {
  if (fs.existsSync(COLAB_JOB_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(COLAB_JOB_FILE, 'utf-8'));
    } catch {
      // ignore
    }
  }
  return {
    jobId: '',
    status: 'IDLE',
    steps: 1200,
    lr: '1e-4',
    dim: 32,
    trigger: 'culturax_style',
    lowVram: true,
    createdAt: 0,
    updatedAt: 0,
    abortRequested: false,
  };
}

function saveColabJobState(state: ColabJobState): void {
  state.updatedAt = Date.now();
  fs.writeFileSync(COLAB_JOB_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

function getOrCreateColabToken(forceRegenerate = false): string {
  if (!forceRegenerate) {
    const envTok = (process.env.COLAB_BRIDGE_TOKEN || '').trim();
    if (envTok) return envTok;
    if (fs.existsSync(COLAB_TOKEN_FILE)) {
      const saved = fs.readFileSync(COLAB_TOKEN_FILE, 'utf-8').trim();
      if (saved) return saved;
    }
  }
  const newToken = `cb_${crypto.randomBytes(20).toString('hex')}`;
  fs.writeFileSync(COLAB_TOKEN_FILE, newToken, { encoding: 'utf-8', mode: 0o600 });
  return newToken;
}

function secureFilename(filename: string): string {
  const base = path.basename(filename || '');
  return base.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function isLocalPidRunning(): boolean {
  if (!fs.existsSync(PID_FILE)) return false;
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    if (isNaN(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isRunning(): boolean {
  if (isLocalPidRunning()) return true;
  const colabJob = getColabJobState();
  return colabJob.status === 'WAITING_FOR_COLAB' || colabJob.status === 'RUNNING_ON_COLAB';
}

function loadTagsConfig(): Record<string, Array<{ fr: string; en: string }>> {
  if (fs.existsSync(TAGS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(TAGS_FILE, 'utf-8'));
    } catch {
      return {};
    }
  }
  return {};
}

function getGeminiApiKey(): string {
  if (fs.existsSync(GEMINI_KEY_FILE)) {
    const fileKey = fs.readFileSync(GEMINI_KEY_FILE, 'utf-8').trim();
    if (fileKey) return fileKey;
  }
  const envKey = (process.env.GEMINI_API_KEY || '').trim();
  if (envKey) return envKey;
  return '';
}

function getGeminiModel(): string {
  if (fs.existsSync(GEMINI_MODEL_FILE)) {
    const m = fs.readFileSync(GEMINI_MODEL_FILE, 'utf-8').trim();
    if (m) return m;
  }
  return (process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim();
}

function getRunpodApiKey(): string {
  if (fs.existsSync(RUNPOD_KEY_FILE)) {
    const fileKey = fs.readFileSync(RUNPOD_KEY_FILE, 'utf-8').trim();
    if (fileKey) return fileKey;
  }
  const envKey = (process.env.RUNPOD_API_KEY || '').trim();
  if (envKey) return envKey;
  return '';
}

function getRunpodGpu(): string {
  if (fs.existsSync(RUNPOD_GPU_FILE)) {
    const g = fs.readFileSync(RUNPOD_GPU_FILE, 'utf-8').trim();
    if (g) return g;
  }
  return (process.env.RUNPOD_GPU || 'AUTO').trim();
}

function splitSubtags(tagStr: string): string[] {
  return (tagStr || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

function normalizeTagForComparison(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/['"`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fusionne et dédoublonne les nouveaux tags IA avec la légende existante du fichier .txt
 * sans jamais écraser les tags déjà présents et en garantissant le trigger word en tête.
 */
function mergeAndDeduplicateTags(
  existingCaption: string,
  newTagsRaw: string[],
  trigger: string = 'culturax_style'
): {
  finalCaption: string;
  addedTags: string[];
  skippedDuplicates: string[];
  existingCount: number;
} {
  const cleanTrigger = trigger.trim();
  const rawExistingParts = splitSubtags(existingCaption);

  const finalParts: string[] = [];
  const seenNormalized = new Set<string>();

  if (cleanTrigger) {
    finalParts.push(cleanTrigger);
    seenNormalized.add(normalizeTagForComparison(cleanTrigger));
  }

  // 1. Conserver les tags existants (tout en éliminant d'éventuels doublons internes existants)
  for (const part of rawExistingParts) {
    const norm = normalizeTagForComparison(part);
    if (!norm || seenNormalized.has(norm)) continue;
    finalParts.push(part);
    seenNormalized.add(norm);
  }

  const existingCount = finalParts.length;
  const addedTags: string[] = [];
  const skippedDuplicates: string[] = [];

  // 2. Décomposer et filtrer chaque nouveau tag proposé par l'IA
  const candidateSubtags: string[] = [];
  for (const raw of newTagsRaw) {
    for (const st of splitSubtags(raw)) {
      candidateSubtags.push(st);
    }
  }

  for (const candidate of candidateSubtags) {
    const norm = normalizeTagForComparison(candidate);
    if (!norm) continue;

    // Vérification exacte (insensible à la casse et aux espaces) ou pluriel/singulier trivial
    const singularNorm = norm.endsWith('s') && norm.length > 4 ? norm.slice(0, -1) : norm;
    const pluralNorm = !norm.endsWith('s') ? `${norm}s` : norm;

    const isDuplicate =
      seenNormalized.has(norm) ||
      seenNormalized.has(singularNorm) ||
      seenNormalized.has(pluralNorm);

    if (isDuplicate) {
      if (norm !== normalizeTagForComparison(cleanTrigger)) {
        skippedDuplicates.push(candidate);
      }
      continue;
    }

    finalParts.push(candidate);
    seenNormalized.add(norm);
    addedTags.push(candidate);
  }

  return {
    finalCaption: finalParts.join(', '),
    addedTags,
    skippedDuplicates,
    existingCount,
  };
}

function updateCaptionBgTag(txtPath: string, newBgTag: string, trigger = 'culturax_style'): void {
  const allBgSubtags = new Set<string>();
  for (const preset of Object.values(BG_PRESETS)) {
    for (const st of splitSubtags(preset.tag)) {
      allBgSubtags.add(st.toLowerCase());
    }
  }

  const current = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, 'utf-8').trim() : trigger;
  let parts = splitSubtags(current);
  if (parts.length === 0 && trigger) {
    parts = [trigger];
  }

  parts = parts.filter((p) => !allBgSubtags.has(p.toLowerCase()));
  const partsLower = new Set(parts.map((p) => p.toLowerCase()));

  for (const st of splitSubtags(newBgTag)) {
    if (!partsLower.has(st.toLowerCase())) {
      parts.push(st);
      partsLower.add(st.toLowerCase());
    }
  }

  fs.writeFileSync(txtPath, parts.join(', '), 'utf-8');
}

async function callGeminiApi(
  parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>,
  responseSchema?: any
): Promise<any> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error(
      "Clé API Gemini manquante. Configurez-la via le bouton 🔑 Clé IA dans le Studio ou via la variable d'environnement GEMINI_API_KEY."
    );
  }

  const primaryModel = getGeminiModel();
  const fallbackModels = [
    primaryModel,
    'gemini-3.8-flash',
    'gemini-flash-latest',
    'gemini-3.1-flash-lite',
  ];
  const modelsToTry = Array.from(new Set(fallbackModels.filter(Boolean)));

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  let lastErr: string | null = null;
  for (const model of modelsToTry) {
    try {
      const config: Record<string, any> = {
        responseMimeType: 'application/json',
      };
      if (responseSchema) {
        config.responseSchema = responseSchema;
      }

      const response = await ai.models.generateContent({
        model,
        contents: { parts },
        config,
      });

      const textOut = response.text || '{}';
      if (model !== primaryModel) {
        try {
          fs.writeFileSync(GEMINI_MODEL_FILE, model, 'utf-8');
        } catch {
          // ignore write error
        }
      }
      return JSON.parse(textOut);
    } catch (err: any) {
      const msg = err?.message || String(err);
      lastErr = `Erreur API Gemini (sur ${model}) : ${msg}`;
      if (msg.includes('404') || msg.includes('NOT_FOUND') || msg.includes('not found')) {
        continue;
      }
      throw new Error(lastErr);
    }
  }

  throw new Error(lastErr || 'Impossible de joindre un modèle Gemini valide.');
}

async function encodeDatasetImageForGemini(imgPath: string): Promise<string> {
  const resizedBuffer = await sharp(imgPath)
    .rotate()
    .resize(768, 768, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  return resizedBuffer.toString('base64');
}

// Tarification de référence (USD par million de jetons) pour l'estimation préalable de coût par lot
function getModelPricingPerMillion(modelName: string): { inputUsd: number; outputUsd: number; label: string } {
  const m = (modelName || '').toLowerCase();
  if (m.includes('lite')) {
    return { inputUsd: 0.075, outputUsd: 0.30, label: 'Flash-Lite (Économique)' };
  }
  if (m.includes('pro') || m.includes('argon') || m.includes('gemini-4')) {
    return { inputUsd: 1.25, outputUsd: 5.00, label: 'Pro / Argon (Haute précision)' };
  }
  return { inputUsd: 0.15, outputUsd: 0.60, label: 'Flash (Rapide & Équilibré)' };
}

// ================= ROUTES =================

app.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(BASE_DIR, 'templates', 'index.html'));
});

app.get('/api/state', async (_req: Request, res: Response) => {
  try {
    const files = fs.existsSync(DATASET_DIR) ? fs.readdirSync(DATASET_DIR).sort() : [];
    const items = [];

    for (const fname of files) {
      const ext = path.extname(fname).toLowerCase();
      if (!ALLOWED_EXTS.has(ext)) continue;

      const fPath = path.join(DATASET_DIR, fname);
      const stat = fs.statSync(fPath);
      const txtFile = path.join(DATASET_DIR, `${path.parse(fname).name}.txt`);
      const caption = fs.existsSync(txtFile) ? fs.readFileSync(txtFile, 'utf-8').trim() : '';
      const hasOrig = fs.existsSync(path.join(ORIGINALS_DIR, fname));

      let width = 0;
      let height = 0;
      try {
        const meta = await sharp(fPath).metadata();
        width = meta.width || 0;
        height = meta.height || 0;
      } catch {
        width = 0;
        height = 0;
      }

      items.push({
        image: fname,
        caption,
        has_original: hasOrig,
        width,
        height,
        mtime: Math.floor(stat.mtimeMs / 1000),
      });
    }

    const modelFiles = fs.existsSync(MODELS_DIR)
      ? fs
          .readdirSync(MODELS_DIR)
          .filter((f) => f.endsWith('.safetensors'))
          .map((f) => {
            const st = fs.statSync(path.join(MODELS_DIR, f));
            return {
              name: f,
              size_mb: Math.round((st.size / (1024 * 1024)) * 10) / 10,
              date: Math.floor(st.mtimeMs / 1000),
              mtimeMs: st.mtimeMs,
            };
          })
          .sort((a, b) => b.mtimeMs - a.mtimeMs)
          .map(({ name, size_mb, date }) => ({ name, size_mb, date }))
      : [];

    const colabJob = getColabJobState();

    res.json({
      dataset: items,
      models: modelFiles,
      tags_config: loadTagsConfig(),
      has_gemini_key: Boolean(getGeminiApiKey()),
      gemini_model: getGeminiModel(),
      has_runpod_key: Boolean(getRunpodApiKey()),
      runpod_gpu: getRunpodGpu(),
      colab_token: getOrCreateColabToken(),
      colab_job: colabJob,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post('/api/gemini_key', (req: Request, res: Response) => {
  const data = req.body || {};
  const key = (data.api_key || '').trim();
  const model = (data.model || '').trim();

  if (key) {
    fs.writeFileSync(GEMINI_KEY_FILE, key, { encoding: 'utf-8', mode: 0o600 });
  } else if (data.clear_key && fs.existsSync(GEMINI_KEY_FILE)) {
    fs.unlinkSync(GEMINI_KEY_FILE);
  }

  if (model) {
    fs.writeFileSync(GEMINI_MODEL_FILE, model, 'utf-8');
  }

  res.json({
    status: 'ok',
    has_gemini_key: Boolean(getGeminiApiKey()),
    gemini_model: getGeminiModel(),
  });
});

app.post('/api/runpod_key', (req: Request, res: Response) => {
  const data = req.body || {};
  const key = (data.api_key || '').trim();
  const gpu = (data.gpu || '').trim();

  if (key) {
    fs.writeFileSync(RUNPOD_KEY_FILE, key, { encoding: 'utf-8', mode: 0o600 });
  } else if (data.clear_key && fs.existsSync(RUNPOD_KEY_FILE)) {
    fs.unlinkSync(RUNPOD_KEY_FILE);
  }

  if (gpu) {
    fs.writeFileSync(RUNPOD_GPU_FILE, gpu, 'utf-8');
  }

  res.json({
    status: 'ok',
    has_runpod_key: Boolean(getRunpodApiKey()),
    runpod_gpu: getRunpodGpu(),
  });
});

app.post('/api/ai_copilot', async (req: Request, res: Response) => {
  const data = req.body || {};
  const mode = data.mode || 'suggest';
  const trigger = (data.trigger || 'culturax_style').trim();

  try {
    if (mode === 'translate') {
      const frText = (data.text_fr || '').trim();
      if (!frText) {
        return res.status(400).json({ error: 'Texte français vide' });
      }
      const prompt = `You are an expert Stable Diffusion XL (SDXL) dataset captioner for a style LoRA triggered by '${trigger}'.
Translate the following French subject/element description into concise, comma-separated English SDXL booru/natural tags describing ONLY the literal subject, object, anatomy, posture, or material/background mentioned.
CRITICAL RULE: Do NOT add generic style adjectives (like 'tribal', 'ethnic', 'geometric', 'abstract', 'artistic') so they don't bleed into the style trigger word.
French input: "${frText}"
Return a JSON object with:
- "tags": list of objects with "fr" (short French label) and "en" (concise English SDXL tag, without internal commas)
- "combined_en": single comma-separated string of all the English tags.`;

      const schema = {
        type: Type.OBJECT,
        properties: {
          tags: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                fr: { type: Type.STRING },
                en: { type: Type.STRING },
              },
              required: ['fr', 'en'],
            },
          },
          combined_en: { type: Type.STRING },
        },
        required: ['tags', 'combined_en'],
      };

      const result = await callGeminiApi([{ text: prompt }], schema);
      return res.json(result);
    }

    const imgName = secureFilename(data.image || '');
    const imgPath = path.join(DATASET_DIR, imgName);
    if (!imgName || !fs.existsSync(imgPath)) {
      return res.status(404).json({ error: 'Image introuvable' });
    }

    const currentCaption = (data.caption || '').trim();
    const b64Img = await encodeDatasetImageForGemini(imgPath);
    const imgPart = {
      inlineData: {
        mimeType: 'image/jpeg',
        data: b64Img,
      },
    };

    if (mode === 'suggest') {
      const prompt = `Tu es un expert en création de datasets pour l'entraînement de LoRA de style graphique sur Stable Diffusion XL (SDXL).
Le mot-clé déclencheur du style est \`${trigger}\`.
Principe fondamental de dissociation (Disentanglement) :
- Tout ce qui est décrit dans la légende \`.txt\` sera dissocié du mot-clé \`${trigger}\`.
- Tout ce qui N'EST PAS décrit sera absorbé par \`${trigger}\`.
- Tu dois identifier les SUJETS FIGURATIFS SPÉCIFIQUES (ex: chat, oiseau, masque cornu, femme de profil, guerrier, serpent, poterie, collier...), les détails anatomiques/postures, le support matériel et le fond visibles sur cette image.
- INTERDICTION ABSOLUE de décrire le style graphique, les motifs géométriques, la symétrie artistique, le coup de pinceau ou l'esthétique culturelle (car c'est exactement ce que \`${trigger}\` doit apprendre).

Légende actuelle de l'image : "${currentCaption}"

Propose entre 5 et 8 puces de tags pertinents (en privilégiant les sujets figuratifs spécifiques et les éléments visibles qui ne sont pas encore dans la légende actuelle).
Chaque puce doit avoir :
- "fr": nom court et clair en français (ex: "Chat assis", "Oiseau stylisé", "Cornes recourbées", "Vue de profil")
- "en": tag anglais précis pour SDXL, SANS virgule interne (ex: "sitting cat figure", "bird motif", "curved horns", "side profile view")
- "category": "sujet" (pour le sujet figuratif/anatomie) ou "support_fond" (pour le contenant, matériau, cadrage ou fond).`;

      const schema = {
        type: Type.OBJECT,
        properties: {
          suggestions: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                fr: { type: Type.STRING },
                en: { type: Type.STRING },
                category: { type: Type.STRING },
              },
              required: ['fr', 'en', 'category'],
            },
          },
          summary_fr: { type: Type.STRING },
        },
        required: ['suggestions', 'summary_fr'],
      };

      const result = await callGeminiApi([imgPart, { text: prompt }], schema);
      return res.json(result);
    } else if (mode === 'audit') {
      const prompt = `Tu es un auditeur expert de datasets LoRA de style pour Stable Diffusion XL (SDXL).
Le mot-clé déclencheur du style est \`${trigger}\`.
Examine attentivement l'image et sa légende actuelle : "${currentCaption}"

Vérifie deux risques critiques :
1. FUITE DE SUJET / MATÉRIAU (Oublis) : Quels éléments figuratifs concrets (animal, objet, personne, posture, accessoire, matériau, fond) sont visibles dans l'image mais ABSENTS de la légende actuelle ? S'ils ne sont pas tagués, \`${trigger}\` va les mémoriser par erreur.
2. FUITE DE STYLE (Tags parasites) : Y a-t-il des mots dans la légende actuelle qui décrivent le style artistique/géométrique/culturel et qu'il faudrait RETIRER pour laisser \`${trigger}\` l'apprendre ?

Réponds en JSON avec :
- "score": note de qualité du label sur 10 (entier)
- "verdict_fr": diagnostic synthétique en français (1 à 2 phrases)
- "missing_tags": liste de puces {"fr", "en"} qu'il faut ajouter pour protéger \`${trigger}\` (sans virgule interne dans "en")
- "forbidden_tags": liste des tags anglais exacts présents dans la légende actuelle qui décrivent le style et devraient être supprimés (liste vide si aucun).`;

      const schema = {
        type: Type.OBJECT,
        properties: {
          score: { type: Type.INTEGER },
          verdict_fr: { type: Type.STRING },
          missing_tags: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                fr: { type: Type.STRING },
                en: { type: Type.STRING },
              },
              required: ['fr', 'en'],
            },
          },
          forbidden_tags: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: ['score', 'verdict_fr', 'missing_tags', 'forbidden_tags'],
      };

      const result = await callGeminiApi([imgPart, { text: prompt }], schema);
      return res.json(result);
    }

    return res.status(400).json({ error: 'Mode inconnu' });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * RÈGLE 5 (Partie 1) : Estimation préalable du coût d'analyse IA par lot
 */
app.post('/api/ai_batch_estimate', (req: Request, res: Response) => {
  try {
    const data = req.body || {};
    const scope: string = data.scope || 'all'; // 'all' | 'selected' | 'untagged'
    const selectedImages: string[] = Array.isArray(data.images) ? data.images : [];
    const trigger = (data.trigger || 'culturax_style').trim().toLowerCase();

    const allFiles = fs.existsSync(DATASET_DIR)
      ? fs
          .readdirSync(DATASET_DIR)
          .sort()
          .filter((f) => ALLOWED_EXTS.has(path.extname(f).toLowerCase()))
      : [];

    const selectedSet = new Set(selectedImages.map((s) => secureFilename(s)));

    let targetImages: string[] = [];
    let alreadyTaggedCount = 0;
    let untaggedCount = 0;
    let totalExistingTags = 0;

    for (const fname of allFiles) {
      if (scope === 'selected' && !selectedSet.has(fname)) {
        continue;
      }

      const txtPath = path.join(DATASET_DIR, `${path.parse(fname).name}.txt`);
      const caption = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, 'utf-8').trim() : '';
      const parts = splitSubtags(caption);
      const descriptiveParts = parts.filter((p) => p.toLowerCase() !== trigger);
      const hasDescriptiveTags = descriptiveParts.length > 0;

      if (scope === 'untagged' && hasDescriptiveTags) {
        continue;
      }

      targetImages.push(fname);
      totalExistingTags += parts.length;
      if (hasDescriptiveTags) {
        alreadyTaggedCount++;
      } else {
        untaggedCount++;
      }
    }

    const model = getGeminiModel();
    const pricing = getModelPricingPerMillion(model);

    // Estimation réaliste des jetons :
    // - Image redimensionnée <= 768x768 : 258 tokens Vision
    // - Prompt système + règles de dissociation + dictionnaire de référence + tags existants : ~380 tokens
    // - Réponse JSON structurée (5 à 7 tags EN/FR) : ~135 tokens
    const inputTokensPerImage = 638;
    const outputTokensPerImage = 135;

    const totalInputTokens = targetImages.length * inputTokensPerImage;
    const totalOutputTokens = targetImages.length * outputTokensPerImage;
    const totalTokens = totalInputTokens + totalOutputTokens;

    const costUsd =
      (totalInputTokens / 1_000_000) * pricing.inputUsd +
      (totalOutputTokens / 1_000_000) * pricing.outputUsd;
    const eurRate = 0.92;
    const costEur = costUsd * eurRate;
    const costPerImageEur = targetImages.length > 0 ? costEur / targetImages.length : 0;

    res.json({
      status: 'ok',
      scope,
      model,
      model_tier_label: pricing.label,
      pricing_per_1m_usd: {
        input: pricing.inputUsd,
        output: pricing.outputUsd,
      },
      image_count: targetImages.length,
      total_dataset_count: allFiles.length,
      already_tagged_count: alreadyTaggedCount,
      untagged_count: untaggedCount,
      total_existing_tags: totalExistingTags,
      estimated_input_tokens: totalInputTokens,
      estimated_output_tokens: totalOutputTokens,
      estimated_total_tokens: totalTokens,
      estimated_cost_usd: Number(costUsd.toFixed(6)),
      estimated_cost_eur: Number(costEur.toFixed(6)),
      cost_per_image_eur: Number(costPerImageEur.toFixed(6)),
      estimated_duration_sec: Math.ceil(targetImages.length * 2.2),
      has_gemini_key: Boolean(getGeminiApiKey()),
      target_images: targetImages,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * RÈGLE 5 (Partie 2) : Pose de labels IA sur une ou plusieurs images avec dédoublonnage strict
 */
app.post('/api/ai_batch_label', async (req: Request, res: Response) => {
  try {
    const data = req.body || {};
    const trigger = (data.trigger || 'culturax_style').trim();
    const maxNewTags = Math.min(12, Math.max(2, Number(data.max_new_tags) || 6));

    const requestedImages: string[] = [];
    if (typeof data.image === 'string' && data.image.trim()) {
      requestedImages.push(secureFilename(data.image.trim()));
    } else if (Array.isArray(data.images)) {
      for (const img of data.images) {
        if (typeof img === 'string' && img.trim()) {
          requestedImages.push(secureFilename(img.trim()));
        }
      }
    }

    if (requestedImages.length === 0) {
      return res.status(400).json({ error: 'Aucune image spécifiée pour le lot IA.' });
    }

    // Construire un extrait compact des tags connus dans tags_config.json pour favoriser un vocabulaire homogène
    const cfg = loadTagsConfig();
    const knownEnTags: string[] = [];
    for (const list of Object.values(cfg)) {
      for (const item of list) {
        if (item.en) knownEnTags.push(item.en);
      }
    }
    const vocabHint =
      knownEnTags.length > 0
        ? `Vocabulaire de référence du Studio (utilise ces formulations exactes si elles correspondent à ce qui est visible, et complète avec des tags précis pour les sujets spécifiques) : ${knownEnTags.join(' | ')}`
        : '';

    const schema = {
      type: Type.OBJECT,
      properties: {
        tags: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              fr: { type: Type.STRING },
              en: { type: Type.STRING },
            },
            required: ['fr', 'en'],
          },
        },
      },
      required: ['tags'],
    };

    const results = [];

    for (const imgName of requestedImages) {
      const imgPath = path.join(DATASET_DIR, imgName);
      if (!fs.existsSync(imgPath)) {
        results.push({
          image: imgName,
          status: 'error',
          error: 'Image introuvable',
        });
        continue;
      }

      const txtPath = path.join(DATASET_DIR, `${path.parse(imgName).name}.txt`);
      const existingCaption = fs.existsSync(txtPath)
        ? fs.readFileSync(txtPath, 'utf-8').trim()
        : trigger;
      const existingParts = splitSubtags(existingCaption);

      try {
        const b64Img = await encodeDatasetImageForGemini(imgPath);
        const imgPart = {
          inlineData: {
            mimeType: 'image/jpeg',
            data: b64Img,
          },
        };

        const prompt = `Tu es un expert en étiquetage automatique de datasets pour l'entraînement de LoRA de style sur Stable Diffusion XL (SDXL).
Le mot-clé déclencheur du style est \`${trigger}\`.

RÈGLE D'OR DE DISSOCIATION (DISENTANGLEMENT) :
- Décris UNIQUEMENT ce qu'il faut dissocier du style :
  1. Le support / médium (ex: sculpture bois, masque, peinture corporelle, bijou, poterie, tracé 2D...)
  2. Les sujets figuratifs concrets et détails anatomiques/postures (ex: figure humaine, visage, oiseau, félin, serpent, cornes, coiffe...)
  3. Le matériau et la texture physique (ex: bois sculpté, perles, raphia, métal, peau...)
  4. Le cadrage / prise de vue (ex: vue de face, profil, gros plan, objet entier...)
  5. Le fond et l'éclairage (ex: fond blanc isolé, fond noir studio, fond flou...)
- INTERDICTION ABSOLUE de décrire le style artistique, les motifs géométriques, l'esthétique culturelle ou tribale, ou d'inclure le mot-clé \`${trigger}\`.

TAGS DÉJÀ PRÉSENTS SUR CETTE IMAGE (ne pas les répéter) :
${existingParts.length > 0 ? existingParts.join(', ') : '(aucun)'}

${vocabHint}

Propose jusqu'à ${maxNewTags} tags anglais concis et pertinents (sans virgule interne dans chaque tag "en", sauf s'il s'agit d'une expression standard du vocabulaire de référence) qui complètent les tags déjà présents sans doublon.`;

        const aiData = await callGeminiApi([imgPart, { text: prompt }], schema);
        const aiTagsList: Array<{ fr: string; en: string }> = Array.isArray(aiData?.tags)
          ? aiData.tags
          : [];
        const rawEnTags = aiTagsList.map((t) => t.en).filter(Boolean);

        const merged = mergeAndDeduplicateTags(existingCaption, rawEnTags, trigger);
        fs.writeFileSync(txtPath, merged.finalCaption, 'utf-8');

        results.push({
          image: imgName,
          status: 'ok',
          previous_caption: existingCaption,
          final_caption: merged.finalCaption,
          added_tags: merged.addedTags,
          skipped_duplicates: merged.skippedDuplicates,
          ai_suggestions: aiTagsList,
        });
      } catch (imgErr: any) {
        results.push({
          image: imgName,
          status: 'error',
          error: imgErr?.message || String(imgErr),
          previous_caption: existingCaption,
        });
      }
    }

    return res.json({
      status: 'ok',
      processed: results.length,
      results,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

app.get('/img/dataset/:filename', (req: Request, res: Response) => {
  const fname = secureFilename(String(req.params.filename || ''));
  const filePath = path.join(DATASET_DIR, fname);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Not found');
  }
  res.sendFile(filePath);
});

app.get('/img/original/:filename', (req: Request, res: Response) => {
  const fname = secureFilename(String(req.params.filename || ''));
  const origPath = path.join(ORIGINALS_DIR, fname);
  if (fs.existsSync(origPath)) {
    return res.sendFile(origPath);
  }
  const datasetPath = path.join(DATASET_DIR, fname);
  if (fs.existsSync(datasetPath)) {
    return res.sendFile(datasetPath);
  }
  res.status(404).send('Not found');
});

app.get('/models/:filename', (req: Request, res: Response) => {
  const fname = secureFilename(String(req.params.filename || ''));
  const filePath = path.join(MODELS_DIR, fname);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Not found');
  }
  res.download(filePath, fname);
});

app.post('/api/upload', upload.array('files'), (req: Request, res: Response) => {
  try {
    const trigger = ((req.body?.trigger as string) || 'culturax_style').trim();
    const files = (req.files as Express.Multer.File[]) || [];
    let uploaded = 0;

    for (const f of files) {
      if (!f.originalname) continue;
      const fname = secureFilename(f.originalname);
      const ext = path.extname(fname).toLowerCase();

      if (ALLOWED_EXTS.has(ext)) {
        const origPath = path.join(ORIGINALS_DIR, fname);
        const dataPath = path.join(DATASET_DIR, fname);
        fs.writeFileSync(origPath, f.buffer);
        fs.copyFileSync(origPath, dataPath);

        const txtPath = path.join(DATASET_DIR, `${path.parse(fname).name}.txt`);
        if (!fs.existsSync(txtPath)) {
          fs.writeFileSync(txtPath, trigger, 'utf-8');
        }
        uploaded++;
      } else if (ext === '.txt') {
        fs.writeFileSync(path.join(DATASET_DIR, fname), f.buffer);
      }
    }

    res.json({ status: 'ok', uploaded });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post('/api/caption', (req: Request, res: Response) => {
  const data = req.body || {};
  const imgName = secureFilename(data.image || '');
  if (!imgName) return res.status(400).json({ error: 'Image manquante' });

  const txtPath = path.join(DATASET_DIR, `${path.parse(imgName).name}.txt`);
  fs.writeFileSync(txtPath, String(data.caption || '').trim(), 'utf-8');
  res.json({ status: 'saved' });
});

app.post('/api/batch_caption', (req: Request, res: Response) => {
  const data = req.body || {};
  const images: string[] = Array.isArray(data.images) ? data.images : [];
  const tagEn = String(data.tag_en || '').trim();
  const action = data.action || 'add';
  const trigger = String(data.trigger || 'culturax_style').trim();

  const subTags = splitSubtags(tagEn);
  const subTagsLower = subTags.map((s) => s.toLowerCase());

  for (const img of images) {
    const fname = secureFilename(img);
    const txtPath = path.join(DATASET_DIR, `${path.parse(fname).name}.txt`);
    const current = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, 'utf-8').trim() : trigger;
    let parts = splitSubtags(current);
    if (parts.length === 0 && trigger) {
      parts = [trigger];
    }

    const partsLower = new Set(parts.map((p) => p.toLowerCase()));

    if (action === 'add') {
      for (let i = 0; i < subTags.length; i++) {
        if (!partsLower.has(subTagsLower[i])) {
          parts.push(subTags[i]);
          partsLower.add(subTagsLower[i]);
        }
      }
    } else if (action === 'remove') {
      const removeSet = new Set(subTagsLower);
      parts = parts.filter((p) => !removeSet.has(p.toLowerCase()));
    }

    fs.writeFileSync(txtPath, parts.join(', '), 'utf-8');
  }

  res.json({ status: 'ok' });
});

app.post('/api/custom_tag', (req: Request, res: Response) => {
  const data = req.body || {};
  const category = String(
    data.category || '2. Sujets & Motifs Figuratifs (Le Contenu à dissocier)'
  ).trim();
  const frLabel = String(data.fr || '').trim();
  const enTag = String(data.en || '').trim();

  if (!frLabel || !enTag) {
    return res.status(400).json({ error: 'Champs requis' });
  }

  const cfg = loadTagsConfig();
  if (!cfg[category]) {
    cfg[category] = [];
  }
  if (!cfg[category].some((t) => t.en.toLowerCase() === enTag.toLowerCase())) {
    cfg[category].push({ fr: frLabel, en: enTag });
    fs.writeFileSync(TAGS_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
  }

  res.json({ status: 'ok', tags_config: cfg });
});

async function saveProcessedImage(
  imgBuffer: Buffer,
  imgName: string,
  mode: string,
  suffixTag = 'crop',
  bgPresetKey?: string,
  autoTagBg = false,
  trigger = 'culturax_style'
): Promise<string> {
  const ext = path.extname(imgName).toLowerCase() || '.jpg';
  const stem = path.parse(imgName).name;

  let formattedBuffer: Buffer;
  if (ext === '.png') {
    formattedBuffer = await sharp(imgBuffer).png({ quality: 95 }).toBuffer();
  } else if (ext === '.webp') {
    formattedBuffer = await sharp(imgBuffer).webp({ quality: 95 }).toBuffer();
  } else {
    formattedBuffer = await sharp(imgBuffer).jpeg({ quality: 95 }).toBuffer();
  }

  let destName: string;
  let destTxt: string;

  if (mode === 'replace') {
    destName = imgName;
    const destPath = path.join(DATASET_DIR, destName);
    fs.writeFileSync(destPath, formattedBuffer);
    destTxt = path.join(DATASET_DIR, `${stem}.txt`);
  } else {
    let idx = 1;
    while (fs.existsSync(path.join(DATASET_DIR, `${stem}_${suffixTag}${idx}${ext}`))) {
      idx++;
    }
    destName = `${stem}_${suffixTag}${idx}${ext}`;
    const destPath = path.join(DATASET_DIR, destName);
    fs.writeFileSync(destPath, formattedBuffer);
    fs.copyFileSync(destPath, path.join(ORIGINALS_DIR, destName));

    const srcTxt = path.join(DATASET_DIR, `${stem}.txt`);
    destTxt = path.join(DATASET_DIR, `${path.parse(destName).name}.txt`);
    if (fs.existsSync(srcTxt)) {
      fs.copyFileSync(srcTxt, destTxt);
    } else {
      fs.writeFileSync(destTxt, trigger, 'utf-8');
    }
  }

  if (autoTagBg && bgPresetKey && BG_PRESETS[bgPresetKey]) {
    updateCaptionBgTag(destTxt, BG_PRESETS[bgPresetKey].tag, trigger);
  }

  return destName;
}

app.post('/api/crop', async (req: Request, res: Response) => {
  try {
    const data = req.body || {};
    const imgName = secureFilename(data.image || '');
    const mode = data.mode || 'replace';
    const x = Number(data.x) || 0;
    const y = Number(data.y) || 0;
    const w = Number(data.w) || 100;
    const h = Number(data.h) || 100;
    const targetW = parseInt(String(data.target_w || 1024), 10);
    const targetH = parseInt(String(data.target_h || 1024), 10);
    const sourceType = data.source || 'dataset';

    const origCandidate = path.join(ORIGINALS_DIR, imgName);
    const srcPath =
      sourceType === 'original' && fs.existsSync(origCandidate)
        ? origCandidate
        : path.join(DATASET_DIR, imgName);

    if (!imgName || !fs.existsSync(srcPath)) {
      return res.status(404).json({ error: 'Image introuvable' });
    }

    const meta = await sharp(srcPath).metadata();
    const imgW = meta.width || targetW;
    const imgH = meta.height || targetH;

    const left = Math.max(0, Math.min(imgW - 1, Math.floor(x)));
    const top = Math.max(0, Math.min(imgH - 1, Math.floor(y)));
    const width = Math.max(1, Math.min(imgW - left, Math.floor(w)));
    const height = Math.max(1, Math.min(imgH - top, Math.floor(h)));

    const processedBuf = await sharp(srcPath)
      .extract({ left, top, width, height })
      .resize(targetW, targetH, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
      .removeAlpha()
      .toBuffer();

    const destName = await saveProcessedImage(processedBuf, imgName, mode, 'crop');
    res.json({ status: 'ok', image: destName });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post('/api/cutout', async (req: Request, res: Response) => {
  try {
    const data = req.body || {};
    const imgName = secureFilename(data.image || '');
    const mode = data.mode || 'replace';
    const bgColor = data.bg_color || 'white';
    const autoFit = data.auto_fit !== undefined ? Boolean(data.auto_fit) : true;
    const autoTagBg = data.auto_tag_bg !== undefined ? Boolean(data.auto_tag_bg) : true;
    const targetW = parseInt(String(data.target_w || 1024), 10);
    const targetH = parseInt(String(data.target_h || 1024), 10);
    const trigger = String(data.trigger || 'culturax_style').trim();
    let imageB64 = String(data.image_b64 || '');
    const bbox = data.bbox;

    const srcPath = path.join(DATASET_DIR, imgName);
    if (!imgName || !fs.existsSync(srcPath)) {
      return res.status(404).json({ error: 'Image introuvable' });
    }

    if (!imageB64) {
      return res.status(400).json({ error: 'Données de masque manquantes' });
    }

    if (imageB64.includes(',')) {
      imageB64 = imageB64.split(',', 2)[1];
    }
    const rawBytes = Buffer.from(imageB64, 'base64');
    const bgRgb = (BG_PRESETS[bgColor] || BG_PRESETS.white).rgb;

    const uploadedMeta = await sharp(rawBytes).metadata();
    const upW = uploadedMeta.width || targetW;
    const upH = uploadedMeta.height || targetH;

    let finalBuffer: Buffer;

    if (autoFit && bbox && Number(bbox.w) > 10 && Number(bbox.h) > 10) {
      const bx = Math.max(0, Math.min(upW - 1, Math.floor(Number(bbox.x))));
      const by = Math.max(0, Math.min(upH - 1, Math.floor(Number(bbox.y))));
      const bw = Math.max(1, Math.min(upW - bx, Math.floor(Number(bbox.w))));
      const bh = Math.max(1, Math.min(upH - by, Math.floor(Number(bbox.h))));

      const pad = 0.88;
      const scale = Math.min((targetW * pad) / Math.max(1, bw), (targetH * pad) / Math.max(1, bh));
      const newW = Math.max(1, Math.floor(bw * scale));
      const newH = Math.max(1, Math.floor(bh * scale));

      const subjectResized = await sharp(rawBytes)
        .ensureAlpha()
        .extract({ left: bx, top: by, width: bw, height: bh })
        .resize(newW, newH, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
        .png()
        .toBuffer();

      const pasteX = Math.floor((targetW - newW) / 2);
      const pasteY = Math.floor((targetH - newH) / 2);

      finalBuffer = await sharp({
        create: {
          width: targetW,
          height: targetH,
          channels: 3,
          background: bgRgb,
        },
      })
        .composite([{ input: subjectResized, left: pasteX, top: pasteY }])
        .png()
        .toBuffer();
    } else {
      finalBuffer = await sharp(rawBytes)
        .flatten({ background: bgRgb })
        .png()
        .toBuffer();
    }

    const destName = await saveProcessedImage(
      finalBuffer,
      imgName,
      mode,
      'cut',
      bgColor,
      autoTagBg,
      trigger
    );

    res.json({ status: 'ok', image: destName });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post('/api/reset_crop', (req: Request, res: Response) => {
  const data = req.body || {};
  const imgName = secureFilename(data.image || '');
  const origPath = path.join(ORIGINALS_DIR, imgName);
  const destPath = path.join(DATASET_DIR, imgName);

  if (imgName && fs.existsSync(origPath)) {
    fs.copyFileSync(origPath, destPath);
    return res.json({ status: 'ok' });
  }
  res.status(404).json({ error: 'Aucun original sauvegardé pour cette image' });
});

app.delete('/api/delete/:filename', (req: Request, res: Response) => {
  const fname = secureFilename(String(req.params.filename || ''));
  if (fname) {
    for (const folder of [DATASET_DIR, ORIGINALS_DIR]) {
      const p = path.join(folder, fname);
      if (fs.existsSync(p)) fs.unlinkSync(p);
      const txt = path.join(folder, `${path.parse(fname).name}.txt`);
      if (fs.existsSync(txt)) fs.unlinkSync(txt);
    }
  }
  res.json({ status: 'deleted' });
});

function createFlatDatasetZip(outZipPath = '/tmp/dataset.zip'): number {
  const pyScript = `
import zipfile
from pathlib import Path
src = Path(${JSON.stringify(DATASET_DIR)})
out = Path(${JSON.stringify(outZipPath)})
files = [f for f in sorted(src.iterdir()) if f.is_file()]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
    for f in files:
        zf.write(f, arcname=f.name)
print(len(files))
`;
  const r = spawnSync('/usr/bin/python3', ['-c', pyScript], { encoding: 'utf-8' });
  if (r.status !== 0 || !fs.existsSync(outZipPath)) {
    throw new Error(`Échec de compression de ${outZipPath}: ${r.stderr || ''}`);
  }
  return parseInt((r.stdout || '0').trim(), 10) || 0;
}

// Middleware d'authentification Bearer pour le pont Google Colab
function requireColabAuth(req: Request, res: Response, next: NextFunction) {
  const expectedToken = getOrCreateColabToken();
  const authHeader = String(req.headers.authorization || '').trim();
  let providedToken = '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    providedToken = authHeader.slice(7).trim();
  } else if (typeof req.query.token === 'string') {
    providedToken = req.query.token.trim();
  }

  if (!providedToken || providedToken !== expectedToken) {
    return res.status(401).json({ error: 'Jeton COLAB_BRIDGE_TOKEN invalide ou manquant.' });
  }
  next();
}

app.post('/api/colab/regenerate_token', (_req: Request, res: Response) => {
  const tok = getOrCreateColabToken(true);
  res.json({ status: 'ok', colab_token: tok });
});

// 1. Poll du job en attente par Google Colab
app.get('/api/colab/poll', requireColabAuth, (_req: Request, res: Response) => {
  const job = getColabJobState();
  const waiting = job.status === 'WAITING_FOR_COLAB' && !job.abortRequested;
  res.json({
    waiting,
    status: job.status,
    job_id: job.jobId,
    steps: job.steps,
    lr: job.lr,
    dim: job.dim,
    trigger: job.trigger,
    low_vram: true,
    abort: Boolean(job.abortRequested || job.status === 'ABORTED'),
  });
});

// 2. Téléchargement du dataset.zip par Google Colab
app.get('/api/colab/dataset.zip', requireColabAuth, (_req: Request, res: Response) => {
  try {
    const zipPath = '/tmp/dataset.zip';
    if (!fs.existsSync(zipPath)) {
      createFlatDatasetZip(zipPath);
    }
    const job = getColabJobState();
    if (job.status === 'WAITING_FOR_COLAB') {
      job.status = 'RUNNING_ON_COLAB';
      saveColabJobState(job);
      fs.appendFileSync(
        LOG_FILE,
        `\n[+] Worker Google Colab (Tesla T4) connecté ! Téléchargement de dataset.zip en cours...\n`,
        'utf-8'
      );
    }
    res.download(zipPath, 'dataset.zip');
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// 3. Téléchargement du script gpu_worker_run.sh configuré Low-VRAM T4
app.get('/api/colab/worker_script.sh', requireColabAuth, (_req: Request, res: Response) => {
  const scriptPath = path.join(SCRIPTS_DIR, 'gpu_worker_run.sh');
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).send('Script gpu_worker_run.sh introuvable');
  }
  const content = fs.readFileSync(scriptPath, 'utf-8').replace(/\r\n/g, '\n');
  res.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8');
  res.send(content);
});

// 4. Réception des logs en streaming depuis Google Colab + réponse coupe-circuit (abort)
app.post('/api/colab/logs', requireColabAuth, (req: Request, res: Response) => {
  const data = req.body || {};
  let textToAppend = '';
  if (Array.isArray(data.logs)) {
    textToAppend = data.logs.join('\n') + '\n';
  } else if (typeof data.logs === 'string' && data.logs) {
    textToAppend = data.logs.endsWith('\n') ? data.logs : data.logs + '\n';
  } else if (typeof data.line === 'string' && data.line) {
    textToAppend = data.line.endsWith('\n') ? data.line : data.line + '\n';
  }

  if (textToAppend) {
    fs.appendFileSync(LOG_FILE, textToAppend, 'utf-8');
  }

  const job = getColabJobState();
  const shouldAbort = Boolean(job.abortRequested || job.status === 'ABORTED');

  // Si le script sur Colab a échoué (hors coupe-circuit), on remet le job en WAITING_FOR_COLAB
  // afin que l'utilisateur puisse relancer la Cellule 3 immédiatement sans perdre le job
  if (data.failed === true && !shouldAbort) {
    job.status = 'WAITING_FOR_COLAB';
    saveColabJobState(job);
  }

  res.json({ status: 'ok', abort: shouldAbort });
});

// 5. Réception du fichier .safetensors final envoyé par Google Colab
app.post(
  '/api/colab/upload_model',
  requireColabAuth,
  modelUpload.single('file'),
  (req: Request, res: Response) => {
    try {
      const uploadedFile = req.file;
      if (!uploadedFile) {
        return res.status(400).json({ error: 'Aucun fichier .safetensors reçu' });
      }
      const sizeMb = Math.round((uploadedFile.size / (1024 * 1024)) * 10) / 10;
      const job = getColabJobState();
      job.status = 'COMPLETED';
      job.abortRequested = false;
      saveColabJobState(job);

      fs.appendFileSync(
        LOG_FILE,
        `\n[+] SUCCÈS TOTAL (Google Colab Tesla T4) ! Modèle LoRA reçu et sauvegardé : ${uploadedFile.filename} (${sizeMb} Mo)\n`,
        'utf-8'
      );

      res.json({
        status: 'ok',
        model: uploadedFile.filename,
        size_mb: sizeMb,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  }
);

// 6. Génération dynamique du Notebook lora_studio_colab_worker.ipynb
app.get('/api/colab/notebook', (req: Request, res: Response) => {
  const token = getOrCreateColabToken();
  const rawStudioUrl = String(req.query.studio_url || '').trim().replace(/\/+$/, '');
  const fallbackOrigin = `${req.protocol}://${req.get('host') || 'localhost:3000'}`;
  const studioUrl = rawStudioUrl || fallbackOrigin;

  const cell1Source = [
    '# === CELLULE 1 : Vérification du GPU Tesla T4 (15 Go VRAM) ===\n',
    '!nvidia-smi\n',
    'import subprocess, sys\n',
    'res = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"], capture_output=True, text=True)\n',
    'if res.returncode != 0 or not res.stdout.strip():\n',
    '    raise RuntimeError("❌ Aucun GPU détecté ! Dans Google Colab, allez dans Exécution > Modifier le type d\'exécution > Accélérateur matériel : T4 GPU.")\n',
    'print(f"✅ GPU actif et prêt pour SDXL Low-VRAM : {res.stdout.strip()}")\n',
  ];

  const cell2Source = [
    '# === CELLULE 2 : Pré-installation rapide et mise en cache de Kohya sd-scripts (Compatible CUDA 12 Colab) ===\n',
    'import os, subprocess\n',
    'os.makedirs("/tmp/lora_work", exist_ok=True)\n',
    'if not os.path.exists("/tmp/lora_work/sd-scripts"):\n',
    '    print("⏳ Clonage de Kohya sd-scripts...")\n',
    '    subprocess.run(["git", "clone", "--depth", "1", "-q", "https://github.com/kohya-ss/sd-scripts.git", "/tmp/lora_work/sd-scripts"], check=True)\n',
    'print("⏳ Installation des dépendances Kohya compatibles avec le PyTorch CUDA de Colab (~45s)...")\n',
    'subprocess.run(["pip", "install", "-q", "accelerate", "transformers", "diffusers", "safetensors", "bitsandbytes", "dadaptation", "prodigyopt", "lion-pytorch", "toml", "voluptuous", "imagesize", "huggingface_hub"], check=True)\n',
    'subprocess.run(["pip", "install", "-q", "-r", "/tmp/lora_work/sd-scripts/requirements.txt"], check=False)\n',
    'print("✅ Environnement Kohya SDXL prêt !")\n',
  ];

  const cell3Source = [
    '# === CELLULE 3 : Pont Worker Colab <-> LoRA Factory Studio ===\n',
    'import os, sys, time, json, signal, subprocess, urllib.request, urllib.error\n',
    '\n',
    `STUDIO_URL = ${JSON.stringify(studioUrl)}\n`,
    `COLAB_BRIDGE_TOKEN = ${JSON.stringify(token)}\n`,
    '\n',
    'HEADERS = {\n',
    '    "Authorization": f"Bearer {COLAB_BRIDGE_TOKEN}",\n',
    '    "User-Agent": "LoRA-Factory-Colab-Worker/1.1"\n',
    '}\n',
    '\n',
    'def api_get_json(endpoint):\n',
    '    req = urllib.request.Request(f"{STUDIO_URL}/{endpoint.lstrip(\'/\')}", headers=HEADERS)\n',
    '    with urllib.request.urlopen(req, timeout=30) as r:\n',
    '        return json.loads(r.read().decode("utf-8"))\n',
    '\n',
    'def api_download(endpoint, dest_path):\n',
    '    req = urllib.request.Request(f"{STUDIO_URL}/{endpoint.lstrip(\'/\')}", headers=HEADERS)\n',
    '    with urllib.request.urlopen(req, timeout=120) as r, open(dest_path, "wb") as f:\n',
    '        while True:\n',
    '            chunk = r.read(65536)\n',
    '            if not chunk:\n',
    '                break\n',
    '            f.write(chunk)\n',
    '\n',
    'def api_send_logs(lines, failed=False):\n',
    '    if not lines and not failed:\n',
    '        return False\n',
    '    payload = {"logs": lines}\n',
    '    if failed:\n',
    '        payload["failed"] = True\n',
    '    data = json.dumps(payload).encode("utf-8")\n',
    '    hdrs = {**HEADERS, "Content-Type": "application/json"}\n',
    '    req = urllib.request.Request(f"{STUDIO_URL}/api/colab/logs", data=data, headers=hdrs, method="POST")\n',
    '    try:\n',
    '        with urllib.request.urlopen(req, timeout=15) as r:\n',
    '            ans = json.loads(r.read().decode("utf-8"))\n',
    '            return bool(ans.get("abort"))\n',
    '    except Exception as e:\n',
    '        print(f"[Warn log push] {e}")\n',
    '        return False\n',
    '\n',
    'def upload_safetensors(filepath):\n',
    '    boundary = "----LoRAStudioColabBoundary987654321"\n',
    '    filename = os.path.basename(filepath)\n',
    '    with open(filepath, "rb") as f:\n',
    '        file_bytes = f.read()\n',
    '    head = (\n',
    '        f"--{boundary}\\r\\n"\n',
    '        f"Content-Disposition: form-data; name=\\"file\\"; filename=\\"{filename}\\"\\r\\n"\n',
    '        f"Content-Type: application/octet-stream\\r\\n\\r\\n"\n',
    '    ).encode("utf-8")\n',
    '    tail = f"\\r\\n--{boundary}--\\r\\n".encode("utf-8")\n',
    '    body = head + file_bytes + tail\n',
    '    hdrs = {**HEADERS, "Content-Type": f"multipart/form-data; boundary={boundary}", "Content-Length": str(len(body))}\n',
    '    req = urllib.request.Request(f"{STUDIO_URL}/api/colab/upload_model", data=body, headers=hdrs, method="POST")\n',
    '    with urllib.request.urlopen(req, timeout=300) as r:\n',
    '        return json.loads(r.read().decode("utf-8"))\n',
    '\n',
    'print(f"🔌 Connexion au Studio : {STUDIO_URL}")\n',
    'print("⏳ Attente d\'un job d\'entraînement en état WAITING_FOR_COLAB (cliquez sur \'Lancer l\'entraînement GPU\' dans le Studio)...")\n',
    '\n',
    'job = None\n',
    'while True:\n',
    '    try:\n',
    '        state = api_get_json("api/colab/poll")\n',
    '        if state.get("waiting"):\n',
    '            job = state\n',
    '            break\n',
    '        time.sleep(4)\n',
    '    except KeyboardInterrupt:\n',
    '        raise\n',
    '    except Exception as e:\n',
    '        print(f"⚠️ Erreur de connexion au Studio ({e}), nouvelle tentative dans 6s...")\n',
    '        time.sleep(6)\n',
    '\n',
    'steps = str(job.get("steps", 1200))\n',
    'lr = str(job.get("lr", "1e-4"))\n',
    'dim = str(job.get("dim", 32))\n',
    'trigger = str(job.get("trigger", "culturax_style"))\n',
    'print(f"🚀 Job détecté ! Trigger={trigger} | Steps={steps} | LR={lr} | Dim={dim}")\n',
    '\n',
    'print("📥 Téléchargement de dataset.zip et du script Low-VRAM T4...")\n',
    'api_download("api/colab/dataset.zip", "/tmp/dataset.zip")\n',
    'api_download("api/colab/worker_script.sh", "/tmp/gpu_worker_run.sh")\n',
    'os.chmod("/tmp/gpu_worker_run.sh", 0o755)\n',
    '\n',
    'cmd = ["/bin/bash", "/tmp/gpu_worker_run.sh", steps, lr, dim, trigger, "--low-vram"]\n',
    'proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, preexec_fn=os.setsid)\n',
    '\n',
    'buffer = []\n',
    'last_Send = time.time()\n',
    'aborted = False\n',
    '\n',
    'for line in iter(proc.stdout.readline, ""):\n',
    '    sys.stdout.write(line)\n',
    '    sys.stdout.flush()\n',
    '    buffer.append(line.rstrip("\\r\\n"))\n',
    '    if len(buffer) >= 8 or (time.time() - last_Send) > 1.5:\n',
    '        if api_send_logs(buffer):\n',
    '            print("\\n🛑 COUPE-CIRCUIT (Kill Switch) reçu depuis le Studio ! Arrêt immédiat...")\n',
    '            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)\n',
    '            aborted = True\n',
    '            break\n',
    '        buffer = []\n',
    '        last_Send = time.time()\n',
    '\n',
    'if buffer and not aborted:\n',
    '    api_send_logs(buffer)\n',
    '\n',
    'ret = proc.wait()\n',
    'output_model = "/tmp/lora_work/output/filtre_culturel_v1.safetensors"\n',
    '\n',
    'if not aborted and ret == 0 and os.path.exists(output_model):\n',
    '    print("📤 Envoi du modèle .safetensors vers votre LoRA Factory Studio...")\n',
    '    api_send_logs(["[*] Entraînement terminé sur Colab ! Transfert du fichier .safetensors vers le Studio..."])\n',
    '    res_up = upload_safetensors(output_model)\n',
    '    print(f"✅ Modèle transféré avec succès : {res_up}")\n',
    '    print("🔌 Libération automatique de la session GPU Google Colab...")\n',
    '    try:\n',
    '        from google.colab import runtime\n',
    '        runtime.unassign()\n',
    '    except Exception:\n',
    '        pass\n',
    'elif aborted:\n',
    '    print("🔌 Coupe-circuit activé depuis le Studio : libération de la session GPU Google Colab...")\n',
    '    try:\n',
    '        from google.colab import runtime\n',
    '        runtime.unassign()\n',
    '    except Exception:\n',
    '        pass\n',
    'else:\n',
    '    api_send_logs([f"[!] Échec du script d\'entraînement sur Colab (code retour: {ret}). La session Colab reste ouverte (modèle SDXL 6.9 Go conservé en cache) et le job est prêt à être relancé."], failed=True)\n',
    '    print(f"⚠️ Le script s\'est arrêté avec le code {ret}. La session Colab N\'EST PAS détruite afin de conserver le modèle SDXL (6.9 Go) et les paquets en cache.")\n',
    '    print("👉 Vous pouvez relancer uniquement cette Cellule 3 pour réessayer immédiatement !")\n',
  ];

  const notebookJson = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      colab: {
        provenance: [],
        gpuType: 'T4',
      },
      accelerator: 'GPU',
      gpuClass: 'standard',
      kernelspec: {
        name: 'python3',
        display_name: 'Python 3',
      },
      language_info: {
        name: 'python',
      },
    },
    cells: [
      {
        cell_type: 'markdown',
        metadata: {},
        source: [
          '# ⚡ LoRA Factory Studio — Worker GPU Google Colab (Tesla T4 15 Go)\n',
          'Ce notebook connecte gratuitement une carte **NVIDIA Tesla T4 (15 Go VRAM)** de Google Colab à votre **LoRA Factory Studio**.\n',
          '1. Assurez-vous que le runtime est bien en **GPU T4** (*Exécution > Modifier le type d\'exécution > T4 GPU*).\n',
          '2. Exécutez les 3 cellules ci-dessous (*Exécution > Tout exécuter*).\n',
        ],
      },
      {
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: cell1Source,
      },
      {
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: cell2Source,
      },
      {
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: cell3Source,
      },
    ],
  };

  res.setHeader('Content-Type', 'application/x-ipynb+json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="lora_studio_colab_worker.ipynb"');
  res.send(JSON.stringify(notebookJson, null, 2));
});

// RÈGLE 4 : Conservation des scripts d'entraînement GPU (`scripts/orchestrate.py` & `scripts/kill_switch.py`) + Mode Pont Google Colab
app.post('/api/train', (req: Request, res: Response) => {
  if (isRunning()) {
    return res.status(400).json({ error: 'Un entraînement est déjà en cours ou en attente !' });
  }
  const data = req.body || {};
  const provider = String(data.provider || 'runpod').toLowerCase();
  const steps = parseInt(String(data.steps || 1200), 10);
  const lr = String(data.lr || '1e-4');
  const dim = parseInt(String(data.dim || 32), 10);
  const trigger = String(data.trigger || 'culturax_style').trim();

  if (provider === 'colab') {
    try {
      const filesCount = createFlatDatasetZip('/tmp/dataset.zip');
      if (filesCount === 0) {
        return res.status(400).json({ error: 'Le dossier dataset est vide ! Importez des images.' });
      }
      const job: ColabJobState = {
        jobId: `colab_${Date.now()}`,
        status: 'WAITING_FOR_COLAB',
        steps,
        lr,
        dim,
        trigger,
        lowVram: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        abortRequested: false,
      };
      saveColabJobState(job);

      const initLog = [
        `=== [MODE PONT GOOGLE COLAB — TESLA T4 15 Go VRAM] ===`,
        `[*] Archive /tmp/dataset.zip préparée avec succès (${filesCount} fichiers : images + labels .txt).`,
        `[*] Paramètres Kohya Low-VRAM T4 : Trigger="${trigger}" | Steps=${steps} | LR=${lr} | Dim=${dim} | Batch=1 | Adafactor FP16 | Cache Text Encoder & Latents.`,
        `[*] État du job : WAITING_FOR_COLAB`,
        `    -> 1. Téléchargez le Notebook 'lora_studio_colab_worker.ipynb' depuis la colonne de gauche.`,
        `    -> 2. Ouvrez-le dans Google Colab (https://colab.research.google.com) avec l'accélérateur T4 GPU.`,
        `    -> 3. Cliquez sur 'Tout exécuter' : Colab va récupérer ce job automatiquement et streamer les logs ici en direct !\n`,
      ].join('\n');
      fs.writeFileSync(LOG_FILE, initLog, 'utf-8');

      return res.json({ status: 'waiting_for_colab', job_id: job.jobId });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || String(err) });
    }
  }

  const gpuChoice = String(data.gpu || getRunpodGpu() || 'AUTO').trim();
  if (gpuChoice) {
    fs.writeFileSync(RUNPOD_GPU_FILE, gpuChoice, 'utf-8');
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    LORA_STEPS: String(steps),
    LORA_LR: lr,
    LORA_DIM: String(dim),
    LORA_TRIGGER: trigger,
    RUNPOD_API_KEY: getRunpodApiKey(),
    RUNPOD_GPU: gpuChoice,
  };

  const logFd = fs.openSync(LOG_FILE, 'w');
  const proc = spawn('/usr/bin/python3', ['-u', path.join(SCRIPTS_DIR, 'orchestrate.py')], {
    env,
    stdio: ['ignore', logFd, logFd],
    detached: true,
  });
  proc.unref();
  fs.closeSync(logFd);

  if (proc.pid) {
    fs.writeFileSync(PID_FILE, String(proc.pid), 'utf-8');
  }
  res.json({ status: 'started', pid: proc.pid });
});

app.post('/api/kill', (_req: Request, res: Response) => {
  if (isLocalPidRunning()) {
    try {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
      process.kill(pid, 'SIGKILL');
    } catch {
      // ignore
    }
  }

  const colabJob = getColabJobState();
  if (colabJob.status === 'WAITING_FOR_COLAB' || colabJob.status === 'RUNNING_ON_COLAB') {
    colabJob.abortRequested = true;
    colabJob.status = 'ABORTED';
    saveColabJobState(colabJob);
    fs.appendFileSync(
      LOG_FILE,
      "\n[!] SIGNAL D'ARRÊT D'URGENCE ENVOYÉ AU WORKER GOOGLE COLAB (arrêt du processus Kohya & déconnexion du runtime T4)...\n",
      'utf-8'
    );
  }

  fs.appendFileSync(
    LOG_FILE,
    "\n[!] COUPE-CIRCUIT D'URGENCE ACTIVÉ DEPUIS LE STUDIO WEB...\n",
    'utf-8'
  );
  const logFd = fs.openSync(LOG_FILE, 'a');
  spawnSync('/usr/bin/python3', [path.join(SCRIPTS_DIR, 'kill_switch.py'), '--force'], {
    env: {
      ...process.env,
      RUNPOD_API_KEY: getRunpodApiKey(),
    },
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);

  res.json({ status: 'killed' });
});

app.get('/api/export_dataset', (req: Request, res: Response) => {
  try {
    const trigger = secureFilename(String(req.query.trigger || 'culturax_style').trim() || 'culturax_style');
    const outZip = '/tmp/dataset_kohya_export.zip';
    const pyScript = `
import zipfile
from pathlib import Path
src = Path(${JSON.stringify(DATASET_DIR)})
out = Path(${JSON.stringify(outZip)})
folder = f"10_${trigger}"
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
    for f in sorted(src.iterdir()):
        if f.is_file():
            zf.write(f, arcname=f"{folder}/{f.name}")
`;
    const r = spawnSync('/usr/bin/python3', ['-c', pyScript]);
    if (r.status !== 0 || !fs.existsSync(outZip)) {
      return res.status(500).json({ error: 'Erreur lors de la création de l’archive .zip' });
    }
    res.download(outZip, `dataset_lora_${trigger}.zip`);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.get('/api/logs', (_req: Request, res: Response) => {
  let logs = '';
  if (fs.existsSync(LOG_FILE)) {
    const raw = fs.readFileSync(LOG_FILE, 'utf-8');
    logs = raw.slice(-18000);
  }
  const colabJob = getColabJobState();
  res.json({
    running: isRunning(),
    colab_status: colabJob.status,
    logs,
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`LoRA Factory Studio listening on http://0.0.0.0:${PORT}`);
});
