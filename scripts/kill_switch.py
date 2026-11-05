#!/usr/bin/env python3
import os
import sys
import json
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

TARGET_NAME = "gpu-ephemere-lora-worker"
MAX_RUNTIME_HOURS = 2.5

BASE_DIR = Path(__file__).resolve().parent.parent
RUNPOD_KEY_FILE = BASE_DIR / ".runpod_key"
ACTIVE_POD_FILE = BASE_DIR / "runpod_pod.id"


def get_runpod_api_key() -> str:
    env_key = os.environ.get("RUNPOD_API_KEY", "").strip()
    if env_key:
        return env_key
    if RUNPOD_KEY_FILE.exists():
        return RUNPOD_KEY_FILE.read_text(encoding="utf-8").strip()
    return ""


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
    with urllib.request.urlopen(req, timeout=25) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        return data.get("data", {})


def terminate_pod(api_key: str, pod_id: str):
    mutation = """
    mutation TerminatePod($input: PodTerminateInput!) {
      podTerminate(input: $input)
    }
    """
    runpod_graphql(api_key, mutation, {"input": {"podId": pod_id}})


def check_and_kill(force_all: bool = False):
    now = datetime.now(timezone.utc)
    api_key = get_runpod_api_key()
    if not api_key:
        print(f"[{now.isoformat()}] Aucune clé RunPod configurée — rien à détruire.")
        return

    killed_ids = set()

    # 1. En mode coupe-circuit d'urgence (--force), détruire immédiatement le pod enregistré localement
    if force_all and ACTIVE_POD_FILE.exists():
        saved_id = ACTIVE_POD_FILE.read_text(encoding="utf-8").strip()
        if saved_id:
            try:
                print(f"[{now.isoformat()}] Destruction immédiate du Pod actif ({saved_id})...")
                terminate_pod(api_key, saved_id)
                killed_ids.add(saved_id)
                ACTIVE_POD_FILE.unlink()
                print(f"    -> Pod {saved_id} détruit.")
            except Exception as e:
                print(f"    -> Info destruction {saved_id} : {e}")

    # 2. Lister tous les pods actifs sur le compte RunPod portant le nom gpu-ephemere-lora-worker
    query = """
    query MyselfPods {
      myself {
        pods {
          id
          name
          desiredStatus
          runtime {
            uptimeInSeconds
          }
        }
      }
    }
    """
    try:
        data = runpod_graphql(api_key, query)
        pods = (data.get("myself") or {}).get("pods") or []
        found_any = False

        for pod in pods:
            pid = pod.get("id")
            pname = pod.get("name", "")
            if pname != TARGET_NAME or pid in killed_ids:
                continue

            found_any = True
            uptime_sec = ((pod.get("runtime") or {}).get("uptimeInSeconds")) or 0
            age_hours = uptime_sec / 3600.0
            print(f"[{now.isoformat()}] Pod RunPod {pid} ({pod.get('desiredStatus')}) actif depuis {age_hours:.2f}h.")

            if force_all or age_hours > MAX_RUNTIME_HOURS:
                reason = "Coupe-circuit manuel" if force_all else f"Dépassement de {MAX_RUNTIME_HOURS}h"
                print(f" -> Destruction forcée ({reason}) du Pod {pid}...")
                terminate_pod(api_key, pid)
                if ACTIVE_POD_FILE.exists() and ACTIVE_POD_FILE.read_text(encoding="utf-8").strip() == pid:
                    ACTIVE_POD_FILE.unlink()
                print(f" -> Pod {pid} détruit. Facturation stoppée.")

        if not found_any and not killed_ids:
            print(f"[{now.isoformat()}] Aucun Pod GPU '{TARGET_NAME}' actif sur RunPod.")
    except Exception as e:
        print(f"[{now.isoformat()}] Erreur lors de la vérification RunPod : {e}")


if __name__ == "__main__":
    force = "--force" in sys.argv
    check_and_kill(force_all=force)
