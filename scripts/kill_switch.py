#!/usr/bin/env python3
import oci
from datetime import datetime, timezone

COMPARTMENT_ID = "ocid1.tenancy.oc1..aaaaaaaalxubpmf6ftgnymkcvjzoiwfcs4ji4iyjfedpa337byo3u4j5htuq"
TARGET_NAME = "gpu-ephemere-lora-worker"
MAX_RUNTIME_HOURS = 2.5

def check_and_kill():
    config = oci.config.from_file()
    compute = oci.core.ComputeClient(config)
    
    instances = compute.list_instances(COMPARTMENT_ID, display_name=TARGET_NAME).data
    now = datetime.now(timezone.utc)
    
    for inst in instances:
        if inst.lifecycle_state not in ["TERMINATED", "TERMINATING"]:
            age_hours = (now - inst.time_created).total_seconds() / 3600.0
            print(f"[{now.isoformat()}] Instance {inst.id} ({inst.lifecycle_state}) active depuis {age_hours:.2f}h.")
            
            if age_hours > MAX_RUNTIME_HOURS:
                print(f" -> ALERTE BUDGET : Dépassement de {MAX_RUNTIME_HOURS}h ! Destruction forcée...")
                compute.terminate_instance(inst.id, preserve_boot_volume=False)

if __name__ == "__main__":
    check_and_kill()
