#!/bin/bash
set -e
STEPS=${1:-1200}
LR=${2:-1e-4}
DIM=${3:-32}
TRIGGER=${4:-culturax_style}

echo "=== [1/4] Préparation du dataset (Mot-clé: $TRIGGER \vert{} Steps:$STEPS | LR: $LR \vert{} Dim:$DIM) ==="
mkdir -p /tmp/lora_work/{dataset,output,models}
unzip -q -o /tmp/dataset.zip -d /tmp/lora_work/dataset/
mkdir -p "/tmp/lora_work/dataset/10_${TRIGGER}"
mv /tmp/lora_work/dataset/*.* "/tmp/lora_work/dataset/10_${TRIGGER}/" 2>/dev/null || true

echo "=== [2/4] Déploiement de l'environnement Kohya sd-scripts ==="
cd /tmp/lora_work
if [ ! -d "sd-scripts" ]; then
    git clone -q https://github.com/kohya-ss/sd-scripts.git
    cd sd-scripts
    python3 -m venv venv
    source venv/bin/activate
    pip install -q --upgrade pip
    pip install -q torch torchvision --index-url https://download.pytorch.org/whl/cu121
    pip install -q -r requirements.txt
    pip install -q xformers bitsandbytes accelerate
else
    cd sd-scripts
    source venv/bin/activate
fi

echo "=== [3/4] Téléchargement du modèle de base SDXL 1.0 ==="
if [ ! -f "/tmp/lora_work/models/sd_xl_base_1.0.safetensors" ]; then
    curl -s -L -o /tmp/lora_work/models/sd_xl_base_1.0.safetensors \
    "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors"
fi

echo "=== [4/4] Lancement du Fine-Tuning LoRA ==="
accelerate launch --num_cpu_threads_per_process 4 sdxl_train_network.py \
    --pretrained_model_name_or_path="/tmp/lora_work/models/sd_xl_base_1.0.safetensors" \
    --train_data_dir="/tmp/lora_work/dataset" \
    --output_dir="/tmp/lora_work/output" \
    --output_name="filtre_culturel_v1" \
    --save_model_as="safetensors" \
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
    --network_module="networks.lora" \
    --network_dim=$DIM \
    --network_alpha=$((DIM / 2)) \
    --gradient_checkpointing \
    --xformers \
    --cache_latents \
    --cache_latents_to_disk
echo "=== Entraînement terminé avec succès ! ==="
