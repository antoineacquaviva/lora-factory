#!/usr/bin/env python3
import os
import sys
import json
import time
import zipfile
import subprocess
import urllib.request
import urllib.error
from pathlib import Path

DISPLAY_NAME = "gpu-ephemere-lora-worker"
DOCKER_IMAGE = "runpod/pytorch:2.2.0-py3.10-cuda12.1.1-devel-ubuntu22.04"

# Résolution dynamique du dossier du projet (compatible VM Oracle /home/opc/lora-factory et AI Studio)
BASE_DIR = Path(__file__).resolve().parent.parent
DATASET_DIR = BASE_DIR / "dataset"
MODELS_DIR = BASE_DIR / "models"
WORKER_SCRIPT = BASE_DIR / "scripts" / "gpu_worker_run.sh"
RUNPOD_KEY_FILE = BASE_DIR / ".runpod_key"
RUNPOD_GPU_FILE = BASE_DIR / ".runpod_gpu"
ACTIVE_POD_FILE = BASE_DIR / "runpod_pod.id"

SSH_DIR = Path.home() / ".ssh"
SSH_KEY_PRIV = SSH_DIR / "id_gpu_worker"
SSH_KEY_PUB = SSH_DIR / "id_gpu_worker.pub"

# Liste de priorité des GPU 24 Go+ VRAM sur RunPod (du meilleur rapport vitesse/prix au plus disponible)
DEFAULT_GPU_CANDIDATES = [
    "NVIDIA GeForce RTX 4090",
    "NVIDIA RTX A5000",
    "NVIDIA GeForce RTX 3090",
    "NVIDIA GeForce RTX 3090 Ti",
    "NVIDIA RTX A6000",
    "NVIDIA A40",
    "NVIDIA L4",
]


def get_runpod_api_key() -> str:
    env_key = os.environ.get("RUNPOD_API_KEY", "").strip()
    if env_key:
        return env_key
    if RUNPOD_KEY_FILE.exists():
        return RUNPOD_KEY_FILE.read_text(encoding="utf-8").strip()
    return ""


def get_preferred_gpu() -> str:
    env_gpu = os.environ.get("RUNPOD_GPU", "").strip()
    if env_gpu:
        return env_gpu
    if RUNPOD_GPU_FILE.exists():
        return RUNPOD_GPU_FILE.read_text(encoding="utf-8").strip()
    return "AUTO"


def ensure_ssh_keypair() -> str:
    SSH_DIR.mkdir(parents=True, exist_ok=True)
    if not SSH_KEY_PRIV.exists() or not SSH_KEY_PUB.exists():
        print("[*] Génération automatique de la clé SSH dédiée au worker GPU (~/.ssh/id_gpu_worker)...")
        subprocess.run(
            ["ssh-keygen", "-t", "ed25519", "-N", "", "-f", str(SSH_KEY_PRIV)],
            check=True,
        )
    os.chmod(SSH_KEY_PRIV, 0o600)
    return SSH_KEY_PUB.read_text(encoding="utf-8").strip()


def runpod_graphql(api_key: str, query: str, variables: dict = None) -> dict:
    url = f"https://api.runpod.io/graphql?api_key={api_key}"
    payload = {"query": query}
    if variables is not None:
        payload["variables"] = variables

    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "User-Agent": "lora-factory-studio/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=35) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if "errors" in data and data["errors"]:
                err_msg = "; ".join(e.get("message", str(e)) for e in data["errors"])
                raise RuntimeError(err_msg)
            return data.get("data", {})
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Erreur HTTP RunPod ({e.code}) : {body}")


def zip_dataset(zip_path: Path):
    files = [f for f in DATASET_DIR.glob("*") if f.is_file()]
    if not files:
        raise RuntimeError(f"Le dossier {DATASET_DIR} est vide ! Importez d'abord des images.")
    print(f"[*] Compression de {len(files)} fichiers (images + labels .txt)...")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for file in files:
            zf.write(file, arcname=file.name)


def launch_runpod_gpu(api_key: str, ssh_pub_key: str) -> tuple[str, str]:
    preferred = get_preferred_gpu()
    if preferred and preferred != "AUTO":
        candidates = [preferred] + [g for g in DEFAULT_GPU_CANDIDATES if g != preferred]
    else:
        candidates = list(DEFAULT_GPU_CANDIDATES)

    mutation = """
    mutation LaunchPod($input: PodFindAndDeployOnDemandInput!) {
      podFindAndDeployOnDemand(input: $input) {
        id
        name
        imageName
        machineId
        costPerHr
      }
    }
    """

    last_err = None
    for gpu_type in candidates:
        for cloud_type in ["ALL", "COMMUNITY", "SECURE"]:
            print(f"[*] Recherche d'un GPU disponible : {gpu_type} (Cloud: {cloud_type})...")
            pod_input = {
                "cloudType": cloud_type,
                "gpuCount": 1,
                "volumeInGb": 0,
                "containerDiskInGb": 45,
                "minVcpuCount": 4,
                "minMemoryInGb": 24,
                "gpuTypeId": gpu_type,
                "name": DISPLAY_NAME,
                "imageName": DOCKER_IMAGE,
                "dockerArgs": "",
                "ports": "22/tcp",
                "volumeMountPath": "/workspace",
                "startSsh": True,
                "env": [
                    {"key": "PUBLIC_KEY", "value": ssh_pub_key},
                ],
            }
            try:
                res = runpod_graphql(api_key, mutation, {"input": pod_input})
                pod = res.get("podFindAndDeployOnDemand")
                if pod and pod.get("id"):
                    cost = pod.get("costPerHr", "?")
                    print(f"    -> [OK] Pod GPU créé : {pod['id']} sur {gpu_type} (~{cost} $/h)")
                    return pod["id"], gpu_type
            except Exception as e:
                last_err = str(e)
                print(f"    -> Indisponible sur {gpu_type} ({cloud_type}) : {last_err}")
                if "unauthenticated" in last_err.lower() or "unauthorized" in last_err.lower() or "balance" in last_err.lower() or "funds" in last_err.lower():
                    raise RuntimeError(f"Erreur compte/clé RunPod : {last_err}")

    raise RuntimeError(f"Aucun GPU 24 Go disponible pour le moment sur RunPod. Dernier message : {last_err}")


def wait_for_pod_ssh(api_key: str, pod_id: str, timeout_sec: int = 420) -> tuple[str, int]:
    query = """
    query GetPod($podId: String!) {
      pod(input: { podId: $podId }) {
        id
        desiredStatus
        runtime {
          uptimeInSeconds
          ports {
            ip
            isIpPublic
            privatePort
            publicPort
            type
          }
        }
      }
    }
    """
    print("[*] Attente du démarrage du conteneur PyTorch CUDA et de l'ouverture du port SSH...")
    start = time.time()
    while time.time() - start < timeout_sec:
        res = runpod_graphql(api_key, query, {"podId": pod_id})
        pod = res.get("pod")
        if not pod:
            raise RuntimeError(f"Le pod {pod_id} n'existe plus sur RunPod.")
        runtime = pod.get("runtime")
        if runtime and runtime.get("ports"):
            for p in runtime["ports"]:
                if p.get("privatePort") == 22 and p.get("isIpPublic") and p.get("ip") and p.get("publicPort"):
                    return p["ip"], int(p["publicPort"])
        time.sleep(6)

    raise TimeoutError("Délai dépassé (7 min) en attendant l'IP SSH publique du Pod RunPod.")


def terminate_runpod_pod(api_key: str, pod_id: str):
    mutation = """
    mutation TerminatePod($input: PodTerminateInput!) {
      podTerminate(input: $input)
    }
    """
    runpod_graphql(api_key, mutation, {"input": {"podId": pod_id}})


def run_ssh_cmd(ip: str, port: int, command: str):
    subprocess.run(
        [
            "ssh",
            "-i", str(SSH_KEY_PRIV),
            "-p", str(port),
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "ConnectTimeout=12",
            f"root@{ip}",
            command,
        ],
        check=True,
    )


def run_scp_upload(ip: str, port: int, local_path: Path, remote_path: str):
    subprocess.run(
        [
            "scp",
            "-i", str(SSH_KEY_PRIV),
            "-P", str(port),
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            str(local_path),
            f"root@{ip}:{remote_path}",
        ],
        check=True,
    )


def run_scp_download(ip: str, port: int, remote_path: str, local_path: Path):
    subprocess.run(
        [
            "scp",
            "-i", str(SSH_KEY_PRIV),
            "-P", str(port),
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            f"root@{ip}:{remote_path}",
            str(local_path),
        ],
        check=True,
    )


def main():
    api_key = get_runpod_api_key()
    if not api_key:
        print("[!] ERREUR : Clé API RunPod manquante !")
        print("    -> Cliquez sur le bouton '🔑 Clé RunPod GPU' dans la colonne de gauche du Studio")
        print("    -> Ou collez votre clé API RunPod (https://www.runpod.io/console/user/settings) pour continuer.")
        sys.exit(1)

    zip_path = Path("/tmp/dataset.zip")
    zip_dataset(zip_path)
    ssh_pub_key = ensure_ssh_keypair()

    steps = os.environ.get("LORA_STEPS", "1200")
    lr = os.environ.get("LORA_LR", "1e-4")
    dim = os.environ.get("LORA_DIM", "32")
    trigger = os.environ.get("LORA_TRIGGER", "culturax_style")

    pod_id = None
    try:
        pod_id, gpu_name = launch_runpod_gpu(api_key, ssh_pub_key)
        ACTIVE_POD_FILE.write_text(pod_id, encoding="utf-8")

        ssh_ip, ssh_port = wait_for_pod_ssh(api_key, pod_id)
        print(f"    -> Pod GPU actif ! Connexion SSH : root@{ssh_ip}:{ssh_port}")

        print("[*] Vérification de la disponibilité du démon SSH...")
        for _ in range(30):
            try:
                run_ssh_cmd(ssh_ip, ssh_port, "echo 'SSH OK' && nvidia-smi --query-gpu=name,memory.total --format=csv,noheader")
                break
            except subprocess.CalledProcessError:
                time.sleep(6)
        else:
            raise TimeoutError("Impossible d'établir la session SSH avec le Pod GPU.")

        print("[*] Transfert SCP du dataset compressé et du script d'entraînement Kohya...")
        run_scp_upload(ssh_ip, ssh_port, zip_path, "/tmp/dataset.zip")
        run_scp_upload(ssh_ip, ssh_port, WORKER_SCRIPT, "/tmp/gpu_worker_run.sh")

        print(f"[*] Lancement du Fine-Tuning SDXL LoRA sur {gpu_name} (Steps={steps}, LR={lr}, Dim={dim}, Trigger={trigger})...")
        run_ssh_cmd(
            ssh_ip,
            ssh_port,
            f"chmod +x /tmp/gpu_worker_run.sh && /tmp/gpu_worker_run.sh {steps} {lr} {dim} {trigger}",
        )

        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        timestamp = time.strftime("%Y%m%d-%H%M")
        local_model = MODELS_DIR / f"filtre_culturel_{timestamp}.safetensors"
        print("[*] Rapatriement du modèle .safetensors vers votre serveur...")
        run_scp_download(ssh_ip, ssh_port, "/tmp/lora_work/output/filtre_culturel_v1.safetensors", local_model)
        print(f"[+] SUCCÈS TOTAL ! Modèle LoRA sauvegardé : {local_model.name}")

    finally:
        if pod_id:
            print(f"\n[!] GARDE-FOU : Destruction immédiate du Pod GPU RunPod ({pod_id})...")
            try:
                terminate_runpod_pod(api_key, pod_id)
                if ACTIVE_POD_FILE.exists():
                    ACTIVE_POD_FILE.unlink()
                print("    -> Pod détruit avec succès. Facturation GPU stoppée à la seconde.")
            except Exception as e:
                print(f"    -> ERREUR lors de la destruction automatique : {e}. Utilisez le bouton Kill Switch.")


if __name__ == "__main__":
    main()
