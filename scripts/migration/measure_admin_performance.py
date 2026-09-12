#!/usr/bin/env python3
"""Read-only timings for the pinned kanouk.com EmDash API; never saves content or credentials."""
import argparse
import datetime
import json
import sys
import subprocess
import tempfile
import urllib.parse
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "cloudflare"))
from run_emdash_kanouk import load_credential
from measure_performance import percentile

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=int, default=20)
    parser.add_argument("--organizer", action="store_true")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if not 1 <= args.samples <= 100:
        parser.error("samples must be 1..100")
    credential = load_credential()
    routes = [("posts", "/_emdash/api/content/posts?limit=50"), ("media", "/_emdash/api/media?limit=50"), ("photos", "/_emdash/api/content/photos?limit=50")]
    def request(path, content=False):
        with tempfile.TemporaryDirectory() as directory:
            body = Path(directory) / "response"
            result = subprocess.run(["curl", "-sS", "--max-time", "25", "--config", "-", "-o", str(body), "-w", "%{json}", credential["url"] + path],
                input="header = " + json.dumps("Authorization: Bearer " + credential["token"]) + "\n", capture_output=True, text=True)
            if result.returncode:
                return {"status": 0, "error": "transport"}, None
            metric = json.loads(result.stdout)
            return {"status": metric["http_code"], "ttfb_ms": round(metric["time_starttransfer"]*1000,2), "bytes": metric["size_download"]}, json.loads(body.read_text()) if content and metric["http_code"] == 200 else None
    if args.organizer:
        routes.append(("album-counts", "/_emdash/api/plugins/yohaku-photo-tools/album-counts"))
        metric, data = request(routes[-1][1], True)
        if metric["status"] != 200:
            raise RuntimeError("Organizer read denied: " + str(metric["status"]))
        items = data.get("data", data).get("items", [])
        album = max(items, key=lambda item: item["total"])["album"]
        routes.append(("photo-page-largest-album", "/_emdash/api/plugins/yohaku-photo-tools/photo-page?album=" + urllib.parse.quote(album)))
    results = []
    for label, path in routes:
        rows = []
        for _ in range(args.samples):
            metric, _ = request(path)
            rows.append(metric)
        values = [row["ttfb_ms"] for row in rows if row["status"] == 200]
        results.append({"route": label, "samples": rows, "median_ms": percentile(values,.5), "p75_ms": percentile(values,.75) if len(values)>=20 else None, "p95_ms": percentile(values,.95) if len(values)>=50 else None})
        print(json.dumps({key:value for key,value in results[-1].items() if key!="samples"}), flush=True)
    Path(args.output).write_text(json.dumps({"measured_at":datetime.datetime.now(datetime.timezone.utc).isoformat(),"authentication":"existing PAT; HTTP API only, not browser readiness","routes":results},indent=2)+"\n")
if __name__ == "__main__":
    main()
