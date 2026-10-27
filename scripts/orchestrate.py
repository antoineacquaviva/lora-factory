#!/usr/bin/env python3
import os
import oci
import time
import zipfile
import subprocess
from pathlib import Path

COMPARTMENT_ID = "ocid1.tenancy.oc1..aaaaaaaalxubpmf6ftgnymkcvjzoiwfcs4ji4iyjfedpa337byo3u4j5htuq"
AD_NAME = "Tyit:EU-PARIS-1-AD-1"
CURRENT_VNIC_ID = "ocid1.vnic.oc1.eu-paris-1.abrwiljrqzmzrh2n5f2kksty76qaap6iok4kih66miesycqbnb5ligoxwx5q"
GPU_SHAPE = "VM.GPU.A10.1"
DISPLAY_NAME = "gpu-ephemere-lora-worker"

BASE_DIR = Path.home() / "lora-factory"
DATASET_DIR = BASE_DIR / "dataset"
MODELS_DIR = BASE_DIR / "models"
WORKER_SCRIPT = BASE_DIR / "scripts" / "gpu_worker_run.sh"
SSH_KEY_PRIV = Path.home() / ".ssh" / "id_gpu_worker"
SSH_KEY_PUB = Path.home() / ".ssh" / "id_gpu_worker.pub"

def get_oci_clients():
    config = oci.config.from_file()
    return oci.core.ComputeClient(config), oci.core.VirtualNetworkClient(config)

def discover_subnet_and_image(compute, network):
    print("[*] Découverte automatique du Subnet ID...")
    subnet_id = network.get_vnic(CURRENT_VNIC_ID).data.subnet_id
    print(f"    -> Subnet ID : {subnet_id}")
    images = compute.list_images(
        COMPARTMENT_ID, operating_system="Canonical Ubuntu",
        operating_system_version="22.04", shape=GPU_SHAPE,
        sort_by="TIMECREATED", sort_order="DESC"
    ).data
    if not images:
        raise RuntimeError("Aucune image Ubuntu trouvée pour le GPU.")
    print(f"    -> Image : {images[0].display_name}")
    return subnet_id, images[0].id

def zip_dataset(zip_path):
    files = [f for f in DATASET_DIR.glob("*") if f.is_file()]
    if not files:
        raise RuntimeError(f"Le dossier {DATASET_DIR} est vide !")
    print(f"[*] Compression de {len(files)} fichiers...")
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for file in files:
            zf.write(file, arcname=file.name)

def run_ssh_cmd(ip, user, command):
    subprocess.run([
        "ssh", "-i", str(SSH_KEY_PRIV), "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null", "-o", "ConnectTimeout=10",
        f"{user}@{ip}", command
    ], check=True)

def main():
    zip_path = Path("/tmp/dataset.zip")
    zip_dataset(zip_path)
    compute, network = get_oci_clients()
    subnet_id, image_id = discover_subnet_and_image(compute, network)
    ssh_pub_key = SSH_KEY_PUB.read_text().strip()

    steps = os.environ.get("LORA_STEPS", "1200")
    lr = os.environ.get("LORA_LR", "1e-4")
    dim = os.environ.get("LORA_DIM", "32")
    trigger = os.environ.get("LORA_TRIGGER", "culturax_style")

    instance_id = None
    try:
        print(f"[*] Provisionnement de {GPU_SHAPE} (~2,00 $/h)...")
        launch_details = oci.core.models.LaunchInstanceDetails(
            compartment_id=COMPARTMENT_ID, availability_domain=AD_NAME,
            shape=GPU_SHAPE, display_name=DISPLAY_NAME, image_id=image_id,
            create_vnic_details=oci.core.models.CreateVnicDetails(subnet_id=subnet_id, assign_public_ip=True),
            metadata={"ssh_authorized_keys": ssh_pub_key},
            source_details=oci.core.models.InstanceSourceViaImageDetails(image_id=image_id, boot_volume_size_in_gbs=100)
        )
        instance_id = compute.launch_instance(launch_details).data.id
        print(f"    -> Instance créée ({instance_id}). Démarrage...")
        oci.wait_until(compute, compute.get_instance(instance_id), 'lifecycle_state', 'RUNNING', max_wait_seconds=600)
        
        vnic_id = compute.list_vnic_attachments(COMPARTMENT_ID, instance_id=instance_id).data[0].vnic_id
        gpu_ip = network.get_vnic(vnic_id).data.private_ip
        print(f"    -> VM GPU active sur IP locale : {gpu_ip}")

        for _ in range(30):
            try:
                run_ssh_cmd(gpu_ip, "ubuntu", "echo 'SSH OK'")
                break
            except subprocess.CalledProcessError:
                time.sleep(10)
        else:
            raise TimeoutError("Timeout SSH sur la VM GPU.")

        print("[*] Installation des pilotes NVIDIA sur la VM GPU...")
        run_ssh_cmd(gpu_ip, "ubuntu", "sudo apt-get update -qq && sudo apt-get install -y -qq unzip python3-venv nvidia-driver-535 && sudo modprobe nvidia")

        print("[*] Transfert SCP du dataset et du script...")
        scp_base = ["scp", "-i", str(SSH_KEY_PRIV), "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null"]
        subprocess.run(scp_base + [str(zip_path), f"ubuntu@{gpu_ip}:/tmp/dataset.zip"], check=True)
        subprocess.run(scp_base + [str(WORKER_SCRIPT), f"ubuntu@{gpu_ip}:/tmp/gpu_worker_run.sh"], check=True)

        print("[*] Lancement de l'entraînement !")
        run_ssh_cmd(gpu_ip, "ubuntu", f"chmod +x /tmp/gpu_worker_run.sh && /tmp/gpu_worker_run.sh {steps} {lr} {dim} {trigger}")

        timestamp = time.strftime("%Y%m%d-%H%M")
        local_model = MODELS_DIR / f"filtre_culturel_{timestamp}.safetensors"
        subprocess.run(scp_base + [f"ubuntu@{gpu_ip}:/tmp/lora_work/output/filtre_culturel_v1.safetensors", str(local_model)], check=True)
        print(f"[+] SUCCÈS ! Modèle sauvegardé : {local_model}")
    finally:
        if instance_id:
            print(f"\n[!] GARDE-FOU : Destruction immédiate de l'instance GPU ({instance_id})...")
            try:
                compute.terminate_instance(instance_id, preserve_boot_volume=False)
                print("    -> Instance détruite. Facturation stoppée.")
            except Exception as e:
                print(f"    -> ERREUR : {e}. Le Cron prendra le relais.")

if __name__ == "__main__":
    main()
