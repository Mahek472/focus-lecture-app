"""Hour 1a: pull only what we need from a BBBD experiment zip on S3.

The official downloader (madjens/bbbd-dataset/data-download-scripts) fetches
the whole 4.5 GB zip; here we use HTTP range reads (remotezip) to extract just
the preprocessed EEG derivatives plus the metadata, ~1.8 GB for Experiment 2.

Usage: python scripts/download_bbbd.py --exp 2 --out data/bbbd
"""
import argparse
import os
from concurrent.futures import ThreadPoolExecutor

from remotezip import RemoteZip

URL = "https://fcp-indi.s3.amazonaws.com/data/Projects/CUNY_MADSEN/BBBD/bids_data/experiment{}.zip"


def wanted(name):
    if name.endswith("/"):
        return False
    if name.startswith("derivatives/") and "/eeg/" in name:
        return True  # preprocessed 64-ch EEG, 128 Hz
    if name.startswith("phenotype/") or "/" not in name:
        return True  # README, participants, quizzes, ASRS
    # one channels.tsv + events.tsv per raw session, for channel names and timing checks
    return "/eeg/" in name and name.endswith(("_channels.tsv", "_events.tsv", "_eeg.json"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--exp", type=int, default=2)
    ap.add_argument("--out", default="data/bbbd")
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()

    url = URL.format(args.exp)
    out = os.path.join(args.out, f"experiment{args.exp}")
    with RemoteZip(url) as z:
        members = [i for i in z.infolist() if wanted(i.filename)]
    todo = [m for m in members
            if not (os.path.exists(os.path.join(out, m.filename))
                    and os.path.getsize(os.path.join(out, m.filename)) == m.file_size)]
    total = sum(m.file_size for m in todo)
    print(f"{len(members)} wanted, {len(todo)} to fetch, {total / 1e9:.2f} GB", flush=True)

    chunks = [todo[i::args.workers] for i in range(args.workers)]

    def fetch(chunk):
        with RemoteZip(url) as z:
            for m in chunk:
                z.extract(m.filename, out)
                print("ok", m.filename, flush=True)

    with ThreadPoolExecutor(args.workers) as ex:
        list(ex.map(fetch, chunks))
    print("done", flush=True)


if __name__ == "__main__":
    main()
