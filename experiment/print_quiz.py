"""Printable quiz documents (paper backup) with the same per-participant randomization as the app.

Writes recordings/<participant>_quiz.html: pre-test, memory quiz, then an answer key on its
own page. Open in a browser and print (Ctrl+P); the key starts on a new page.

Usage: python experiment/print_quiz.py --participant P01 [--videos 1,2,3,4,5]
"""
import argparse
import html
import os

from run_experiment import REC_DIR, build_session


def section(title, blocks, number_from=1):
    out, n = [f"<h2>{title}</h2>"], number_from
    for blk in blocks:
        for q in blk["questions"]:
            opts = "".join(f"<li>{chr(65 + k)}. {html.escape(o)}</li>" for k, o in enumerate(q["options"]))
            out.append(f"<div class='q'><p><b>{n}.</b> {html.escape(q['text'])}</p><ul>{opts}</ul></div>")
            n += 1
    return "\n".join(out), n


def key(title, blocks):
    rows, n = [], 1
    for blk in blocks:
        for q in blk["questions"]:
            rows.append(f"<tr><td>{n}</td><td>{chr(65 + q['correct'])}</td><td>video {blk['stim']}</td>"
                        f"<td>{html.escape(blk['title'])}</td></tr>")
            n += 1
    return f"<h3>{title}</h3><table><tr><th>#</th><th>Answer</th><th>Video</th><th></th></tr>{''.join(rows)}</table>"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--participant", required=True)
    ap.add_argument("--videos", default="1,2,5")  # keep in sync with run_experiment.py
    ap.add_argument("--quiz", choices=["end", "after-each"], default="end")
    a = ap.parse_args()
    s = build_session(a.participant, a.quiz, [int(v) for v in a.videos.split(",") if v])
    pre, _ = section("Part 1: General knowledge (before the videos)", s["domain_quiz"])
    mem, _ = section("Part 2: Questions about the videos", s["memory_quiz"])
    doc = f"""<!doctype html><html><head><meta charset="utf-8"><title>Quiz {html.escape(a.participant)}</title>
<style>body{{font:14px/1.45 Georgia,serif;max-width:760px;margin:24px auto;color:#111}}
h1{{font-size:22px}} h2{{font-size:18px;margin-top:28px;border-bottom:1px solid #999}}
.q{{break-inside:avoid;margin:10px 0}} ul{{list-style:none;padding-left:18px;margin:4px 0}}
li::before{{content:"\\2610  "}} table{{border-collapse:collapse}} td,th{{padding:2px 10px;border-bottom:1px solid #ddd;text-align:left}}
.key{{break-before:page}}</style></head><body>
<h1>Video study quiz &middot; participant {html.escape(a.participant)}</h1>
<p>Mark one answer per question.</p>
{pre}
<p style="break-before:page"></p>
{mem}
<div class="key"><h1>Answer key &middot; participant {html.escape(a.participant)} (experimenter only)</h1>
<p>Video order: {', '.join(map(str, s['attentive_order']))} &middot; distractor primes: {', '.join(map(str, s['primes']))}</p>
{key("Part 1: General knowledge", s["domain_quiz"])}
{key("Part 2: Video questions", s["memory_quiz"])}</div>
</body></html>"""
    os.makedirs(REC_DIR, exist_ok=True)
    path = f"{REC_DIR}/{a.participant}_quiz.html"
    open(path, "w", encoding="utf-8").write(doc)
    print("wrote", path)


if __name__ == "__main__":
    main()
