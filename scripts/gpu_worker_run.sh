#!/bin/bash
set -e
STEPS=${1:-1200}
LR=${2:-1e-4}
DIM=${3:-32}
TRIGGER=${4:-culturax_style}
EXTRA_FLAG=${5:-""}

echo "=== [1/4] Préparation du dataset (Mot-clé: $TRIGGER | Steps: $STEPS | LR: $LR | Dim: $DIM) ==="
if ! command -v unzip &> /dev/null; then
    apt-get update -qq && apt-get install -y -qq unzip git curl
fi

rm -rf /tmp/lora_work/dataset
mkdir -p /tmp/lora_work/{dataset,output,models}
unzip -q -o /tmp/dataset.zip -d /tmp/lora_work/dataset/
mkdir -p "/tmp/lora_work/dataset/10_${TRIGGER}"
mv /tmp/lora_work/dataset/*.* "/tmp/lora_work/dataset/10_${TRIGGER}/" 2>/dev/null || true

IMG_COUNT=$(ls -1 "/tmp/lora_work/dataset/10_${TRIGGER}"/*.{jpg,jpeg,png,webp} 2>/dev/null | wc -l || echo 0)
echo "    -> $IMG_COUNT images prêtes dans 10_${TRIGGER}/"

# Détection automatique de la VRAM GPU (via nvidia-smi) ou flag --low-vram
VRAM_MIB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -n 1 | tr -d ' ' || echo "24000")
GPU_MODEL=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -n 1 || echo "GPU")
LOW_VRAM_MODE=0

if [ "$EXTRA_FLAG" = "--low-vram" ]; then
    LOW_VRAM_MODE=1
elif [ -n "$VRAM_MIB" ] && [ "$VRAM_MIB" -le 16500 ] 2>/dev/null; then
    LOW_VRAM_MODE=1
fi

if [ "$LOW_VRAM_MODE" -eq 1 ]; then
    echo "    -> [PROFIL LOW-VRAM ACTIF] Carte détectée : $GPU_MODEL (${VRAM_MIB} MiB <= 16 Go) — Optimisations Tesla T4 activées !"
else
    echo "    -> [PROFIL HIGH-VRAM 24Go+ ACTIF] Carte détectée : $GPU_MODEL (${VRAM_MIB} MiB)"
fi

echo "=== [2/4] Déploiement rapide de Kohya sd-scripts ==="
cd /tmp/lora_work
if [ ! -d "sd-scripts" ]; then
    git clone --depth 1 -q https://github.com/kohya-ss/sd-scripts.git
    cd sd-scripts
    if python3 -c "import torch" 2>/dev/null; then
        # Sur Google Colab ou conteneur RunPod PyTorch, réutiliser l'environnement système CUDA existant
        pip install -q --upgrade pip
        pip install -q -r requirements.txt || true
        pip install -q accelerate transformers diffusers safetensors bitsandbytes dadaptation prodigyopt lion-pytorch toml voluptuous imagesize huggingface_hub
    else
        python3 -m venv --system-site-packages venv
        source venv/bin/activate
        pip install -q --upgrade pip
        pip install -q torch torchvision --index-url https://download.pytorch.org/whl/cu121
        pip install -q -r requirements.txt
        pip install -q bitsandbytes accelerate xformers || pip install -q bitsandbytes accelerate
    fi
else
    cd sd-scripts
    if [ -f "venv/bin/activate" ]; then
        source venv/bin/activate
    fi
fi

# Détection automatique de xformers vs sdpa (évite les crashs de compatibilité sur Colab CUDA 12)
if python3 -c "import xformers" 2>/dev/null; then
    ATTN_ARG="--xformers"
else
    ATTN_ARG="--sdpa"
fi
echo "    -> Accélération d'attention sélectionnée : $ATTN_ARG"

echo "=== [3/4] Téléchargement rapide du modèle de base SDXL 1.0 (6.9 Go) ==="
if [ ! -f "/tmp/lora_work/models/sd_xl_base_1.0.safetensors" ]; then
    curl -sS -L -o /tmp/lora_work/models/sd_xl_base_1.0.safetensors \
    "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors"
fi

echo "=== [4/4] Lancement du Fine-Tuning SDXL LoRA ==="
if [ "$LOW_VRAM_MODE" -eq 1 ]; then
    # Profil optimisé Tesla T4 (15 Go VRAM / 12.7 Go RAM Système Colab) :
    # --lowram : charge les poids SDXL directement en VRAM GPU sans saturer les 12.7 Go de RAM CPU (évite SIGKILL: 9)
    # --max_data_loader_n_workers=0 : évite la duplication mémoire des sous-processus Python sur Colab
    # --caption_extension=".txt" : lit les fichiers de labels .txt générés par le Studio
    accelerate launch --num_cpu_threads_per_process 2 sdxl_train_network.py \
        --pretrained_model_name_or_path="/tmp/lora_work/models/sd_xl_base_1.0.safetensors" \
        --train_data_dir="/tmp/lora_work/dataset" \
        --output_dir="/tmp/lora_work/output" \
        --output_name="filtre_culturel_v1" \
        --save_model_as="safetensors" \
        --caption_extension=".txt" \
        --resolution="1024,1024" \
        --enable_bucket \
        --train_batch_size=1 \
        --max_train_steps=$STEPS \
        --learning_rate=$LR \
        --unet_lr=$LR \
        --network_train_unet_only \
        --lr_scheduler="constant" \
        --optimizer_type="adafactor" \
        --optimizer_args "scale_parameter=False" "relative_step=False" "warmup_init=False" \
        --mixed_precision="fp16" \
        --save_precision="fp16" \
        --network_module="networks.lora" \
        --network_dim=$DIM \
        --network_alpha=$((DIM / 2)) \
        --gradient_checkpointing \
        --lowram \
        $ATTN_ARG \
        --cache_latents \
        --cache_latents_to_disk \
        --cache_text_encoder_outputs \
        --max_data_loader_n_workers=0
else
    # Profil standard 24 Go+ VRAM (RTX 4090 / A5000 / 3090 / A10)
    accelerate launch --num_cpu_threads_per_process 4 sdxl_train_network.py \
        --pretrained_model_name_or_path="/tmp/lora_work/models/sd_xl_base_1.0.safetensors" \
        --train_data_dir="/tmp/lora_work/dataset" \
        --output_dir="/tmp/lora_work/output" \
        --output_name="filtre_culturel_v1" \
        --save_model_as="safetensors" \
        --caption_extension=".txt" \
        --resolution="1024,1024" \
        --enable_bucket \
        --train_batch_size=2 \
        --max_train_steps=$STEPS \
        --learning_rate=$LR \
        --unet_lr=$LR \
        --text_encoder_lr=1e-5 \
        --lr_scheduler="cosine" \
        --optimizer_type="AdamW8bit" \
        --mixed_precision="fp16" \
        --save_precision="fp16" \
        --network_module="networks.lora" \
        --network_dim=$DIM \
        --network_alpha=$((DIM / 2)) \
        --gradient_checkpointing \
        $ATTN_ARG \
        --cache_latents \
        --cache_latents_to_disk
fi

echo "=== Entraînement terminé avec succès ! ==="
