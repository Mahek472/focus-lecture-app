"""Hour 3.5-4: one results table from whatever result JSONs exist.

Usage: python scripts/results_table.py [--results results] [--tag exp2_our8]
Writes <results>/results_table.md and prints it.
"""
import argparse
import json
import os


def get(path):
    return json.load(open(path)) if os.path.exists(path) else None


def fmt(x):
    return "—" if x is None else f"{x:.3f}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", default="results")
    ap.add_argument("--tag", default="exp2_our8")
    args = ap.parse_args()
    r = args.results
    lines = ["| Model | Window | Calibrated (leave-one-video-out) | Calibrated (train on 1 video) | New person (3 folds) | New person + re-centering |",
             "|---|---|---|---|---|---|"]
    for win in (2, 4):
        d = get(f"{r}/riemann_{args.tag}_{win}s.json")
        if d:
            rows = d["rows"]
            lines.append(f"| Riemannian (Tang) | {win} s | {fmt(rows['calibrated, leave-one-video-out']['mean'])} "
                         f"| {fmt(rows['calibrated, train on 1 video']['mean'])} "
                         f"| {fmt(rows['new person, 3 grouped folds']['mean'])} "
                         f"| {fmt(rows['new person, 3 grouped folds + re-centering']['mean'])} |")
    p = get(f"{r}/cbramod_probe_{args.tag}.json")
    if p:
        lines.append(f"| CBraMod frozen + probe | 4 s | {fmt(p['rows']['calibrated, leave-one-video-out']['mean'])} | — "
                     f"| {fmt(p['rows']['new person, 3 grouped folds']['mean'])} | — |")
    out = ["## Results: BBBD Exp 2, 8 channels, attentive vs distracted (AUC)", ""] + lines
    f = get(f"{r}/cbramod_finetune_{args.tag}.json")
    if f:
        out += ["", "Fine-tuning (one fold per split, same fold for the probe):", "",
                "| Split | Probe | Fine-tuned | Keep fine-tune (≥ +0.03)? |", "|---|---|---|---|"]
        for name, v in f["rows"].items():
            out.append(f"| {name} | {fmt(v['probe'])} | {fmt(v['finetuned'])} | {'yes' if v['keep_finetuned'] else 'no'} |")
    gates = []
    d4 = get(f"{r}/riemann_{args.tag}_4s.json") or get(f"{r}/riemann_{args.tag}_2s.json")
    if d4:
        gates.append(f"- Gate 1: {d4['gate1']}")
    if p:
        gates.append(f"- Gate 2: {p['gate2']}")
    if gates:
        out += [""] + gates
    text = "\n".join(out) + "\n"
    open(f"{r}/results_table.md", "w", encoding="utf-8").write(text)
    print(text)


if __name__ == "__main__":
    main()
