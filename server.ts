import fs from 'fs';
import path from 'path';
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

function secureFilename(filename: string): string {
  const base = path.basename(filename || '');
  return base.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function isRunning(): boolean {
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

    res.json({
      dataset: items,
      models: modelFiles,
      tags_config: loadTagsConfig(),
      has_gemini_key: Boolean(getGeminiApiKey()),
      gemini_model: getGeminiModel(),
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

// RÈGLE 4 : Conservation des scripts d'entraînement GPU (`scripts/orchestrate.py` & `scripts/kill_switch.py`)
app.post('/api/train', (req: Request, res: Response) => {
  if (isRunning()) {
    return res.status(400).json({ error: 'Un entraînement est déjà en cours !' });
  }
  const data = req.body || {};
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    LORA_STEPS: String(parseInt(String(data.steps || 1200), 10)),
    LORA_LR: String(data.lr || '1e-4'),
    LORA_DIM: String(parseInt(String(data.dim || 32), 10)),
    LORA_TRIGGER: String(data.trigger || 'culturax_style').trim(),
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
  if (isRunning()) {
    try {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
      process.kill(pid, 'SIGKILL');
    } catch {
      // ignore
    }
  }
  fs.appendFileSync(
    LOG_FILE,
    "\n[!] COUPE-CIRCUIT D'URGENCE ACTIVÉ DEPUIS LE STUDIO WEB...\n",
    'utf-8'
  );
  const logFd = fs.openSync(LOG_FILE, 'a');
  spawnSync('/usr/bin/python3', [path.join(SCRIPTS_DIR, 'kill_switch.py')], {
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);

  res.json({ status: 'killed' });
});

app.get('/api/logs', (_req: Request, res: Response) => {
  let logs = '';
  if (fs.existsSync(LOG_FILE)) {
    const raw = fs.readFileSync(LOG_FILE, 'utf-8');
    logs = raw.slice(-18000);
  }
  res.json({ running: isRunning(), logs });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`LoRA Factory Studio listening on http://0.0.0.0:${PORT}`);
});
