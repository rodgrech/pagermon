#!/usr/bin/env python3
"""Restart the decoder if rtl_fm logs a USB transfer failure and stays up."""

import json
import os
import subprocess
import time


UNIT = os.environ.get("PAGERMON_DECODER_UNIT", "pagermon-decoder.service")
STATUS_FILE = os.environ.get("PAGERMON_DECODER_STATUS_FILE", "/var/lib/pagermon/decoder-health.json")
ERROR_MARKERS = (
    "cb transfer status:",
    "libusb_submit_transfer failed",
    "rtlsdr_read_async failed",
)


def invocation_id():
    result = subprocess.run(
        ["systemctl", "show", UNIT, "--property=InvocationID", "--value"],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def write_status(status):
    temporary = STATUS_FILE + ".tmp"
    with open(temporary, "w", encoding="utf-8") as output:
        json.dump(status, output)
        output.write("\n")
    os.chmod(temporary, 0o644)
    os.replace(temporary, STATUS_FILE)


while True:
    with subprocess.Popen(
        ["journalctl", "--follow", "--no-pager", "--lines=0", "--output=json", "--unit", UNIT],
        stdout=subprocess.PIPE,
        text=True,
    ) as journal:
        for line in journal.stdout:
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            message = entry.get("MESSAGE", "")
            if "Output at 22050 Hz." in message:
                try:
                    with open(STATUS_FILE, encoding="utf-8") as source:
                        status = json.load(source)
                except (FileNotFoundError, ValueError):
                    status = {}
                if status.get("state") == "restarting":
                    status["state"] = "recovered"
                    status["recoveredAt"] = int(time.time())
                    write_status(status)
                    print("Decoder reopened the SDR after restart", flush=True)
                continue
            if not any(marker in message for marker in ERROR_MARKERS):
                continue
            failed_run = entry.get("_SYSTEMD_INVOCATION_ID")
            if not failed_run:
                continue
            status = {"state": "error", "errorAt": int(time.time()), "message": message[:180]}
            write_status(status)
            print(f"USB error detected: {message}; checking decoder in 30 seconds", flush=True)
            time.sleep(30)
            if invocation_id() == failed_run:
                print("Decoder is still on the failed run; restarting it", flush=True)
                status["state"] = "restarting"
                status["restartAt"] = int(time.time())
                write_status(status)
                subprocess.run(["systemctl", "restart", UNIT], check=True)
            else:
                status["state"] = "recovered"
                status["recoveredAt"] = int(time.time())
                write_status(status)
                print("Decoder already restarted; no action needed", flush=True)
    time.sleep(2)
