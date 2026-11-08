"""Lectures and transcripts served by the backend.

Lectures are the BBBD Experiment 2 stimuli the experiment and the frontend use (YouTube embeds).
Transcripts: a real one can be dropped in as backend/transcripts/<lecture_id>.json
([{start, end, text}], e.g. from Whisper). Without it, PLACEHOLDER lines are served (the same
ones the frontend mock uses); they are not the videos' real words, and the recap says so.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))

LECTURES = [
    {"id": "stim2", "stim": 2, "title": "How modern light bulbs work", "video": "", "length_s": 143, "youtube": "oCEKMEeZXug"},
    {"id": "stim5", "stim": 5, "title": "Why do we have more boys than girls", "video": "", "length_s": 154, "youtube": "3IaYhG11ckA"},
    {"id": "stim1", "stim": 1, "title": "Why are stars star-shaped", "video": "", "length_s": 209, "youtube": "VVAKFJ8VVp4"},
]

_POOLS = {
    "stim2": [
        "Light bulbs turn electrical energy into light, and some into heat.",
        "An incandescent bulb heats a thin filament until it glows.",
        "Most of the energy in an incandescent bulb is lost as heat rather than light.",
        "Halogen bulbs add a gas that helps the filament last longer.",
        "Fluorescent tubes excite a gas, which makes ultraviolet light.",
        "A coating inside the tube turns that ultraviolet into visible light.",
        "LEDs make light directly from a semiconductor junction.",
        "Because little energy becomes heat, LEDs use far less power.",
        "Efficiency is measured as light output per watt of power.",
        "Different bulbs produce different colour temperatures of light.",
    ],
    "stim5": [
        "Slightly more boys than girls are born worldwide.",
        "The ratio at birth is roughly 105 boys for every 100 girls.",
        "Evolutionary theory predicts a balance in the long run.",
        "If one sex becomes rarer, parents of that sex have more grandchildren.",
        "Boys have a higher mortality rate in childhood.",
        "By adulthood the numbers become roughly equal.",
        "The extra boys at birth may compensate for that higher mortality.",
        "Some regions show larger imbalances for social reasons.",
        "Scientists still debate which factors matter most.",
        "Population data help test these ideas.",
    ],
    "stim1": [
        "Stars are round balls of gas, yet we draw them with points.",
        "Light passing through a small opening spreads out, which is called diffraction.",
        "The shape of the opening sets the pattern of the spread.",
        "Telescopes with support struts add spikes to bright stars.",
        "Our own eyes also diffract light as it enters.",
        "Tiny structures in the lens of the eye create a spiky pattern.",
        "That is why stars look pointy to the naked eye.",
        "The pattern differs slightly from person to person.",
        "Space telescope images show spikes from their mirror design.",
        "So the points come from our instruments, not from the stars.",
    ],
}


def lecture(lecture_id):
    return next((l for l in LECTURES if l["id"] == lecture_id), None)


def transcript(lecture_id):
    """(lines, is_placeholder)"""
    path = os.path.join(HERE, "transcripts", f"{lecture_id}.json")
    if os.path.exists(path):
        return json.load(open(path, encoding="utf-8")), False
    lec = lecture(lecture_id)
    length = lec["length_s"] if lec else 140
    pool = _POOLS.get(lecture_id, _POOLS["stim2"])
    lines, step = [], 7
    for i, t in enumerate(range(0, length, step)):
        lines.append({"start": t, "end": min(t + step, length), "text": pool[i % len(pool)]})
    return lines, True


def snippet(lines, start, end):
    return " ".join(l["text"] for l in lines if l["end"] > start and l["start"] < end)
