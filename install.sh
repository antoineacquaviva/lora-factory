#!/bin/bash
set -e

echo "=== [1/3] Installation de Pillow (traitement d'image Python) ==="
sudo dnf install -y python3-pillow || python3 -m pip install Pillow --user

echo "=== [2/3] Arrêt de l'ancien processus Flask (nohup) ==="
pkill -f "lora-factory/app.py" || true

echo "=== [3/3] Configuration du service Systemd (lora-studio.service) ==="
sudo tee /etc/systemd/system/lora-studio.service > /dev/null << 'SERVICE'
[Unit]
Description=LoRA Factory Studio Web Application
After=network.target

[Service]
Type=simple
User=opc
WorkingDirectory=/home/opc/lora-factory
ExecStart=/usr/bin/python3 /home/opc/lora-factory/app.py
Restart=always
RestartSec=3
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
SERVICE

sudo systemctl daemon-reload
sudo systemctl enable lora-studio.service
sudo systemctl restart lora-studio.service

echo "✅ Déploiement terminé ! Le service lora-studio est actif sur le port 5050."
