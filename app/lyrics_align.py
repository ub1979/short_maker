"""Line up the user's own lyric lines with Whisper's word timings.

Whisper on a song is noisy: it misses words, repeats choruses, and may write
Urdu in Urdu script, Hindi script or English letters. So we:
  1. compare words loosely: exact (accents stripped) or by consonant skeleton,
     which survives a change of script ("وطن", "वतन" and "watan" -> "wtn");
  2. find the best in-order matching of lyric words to heard words (a weighted
     longest-common-subsequence, so skipped and extra words are cheap);
  3. give each line with enough matched words its heard start time;
  4. spread lines nobody could hear between their matched neighbours.
Lines that already have a time (set by the user) are kept and used as anchors.
"""
from __future__ import annotations

import math
import re
import unicodedata
from difflib import SequenceMatcher

# Urdu/Arabic letters -> rough Latin consonants (vowel-ish letters map to "").
_UR = {
    "ا": "", "آ": "", "أ": "", "إ": "", "ب": "b", "پ": "p", "ت": "t", "ٹ": "t", "ث": "s", "ج": "j", "چ": "c",
    "ح": "h", "خ": "k", "د": "d", "ڈ": "d", "ذ": "z", "ر": "r", "ڑ": "r", "ز": "z", "ژ": "z", "س": "s",
    "ش": "s", "ص": "s", "ض": "z", "ط": "t", "ظ": "z", "ع": "", "غ": "g", "ف": "f", "ق": "k", "ک": "k",
    "ك": "k", "گ": "g", "ل": "l", "م": "m", "ن": "n", "ں": "n", "و": "", "ؤ": "", "ہ": "", "ھ": "", "ة": "",
    "ء": "", "ی": "", "ي": "", "ى": "", "ئ": "", "ے": "", "ۓ": "",
}
# Devanagari consonants (Whisper sometimes writes Urdu/Hindi this way).
_DEV = {
    "क": "k", "ख": "k", "ग": "g", "घ": "g", "च": "c", "छ": "c", "ज": "j", "झ": "j", "ट": "t", "ठ": "t",
    "ड": "d", "ढ": "d", "ण": "n", "त": "t", "थ": "t", "द": "d", "ध": "d", "न": "n", "प": "p", "फ": "f",
    "ब": "b", "भ": "b", "म": "m", "य": "", "र": "r", "ल": "l", "व": "", "श": "s", "ष": "s", "स": "s",
    "ह": "", "ं": "n", "ँ": "n", "अ": "", "आ": "", "इ": "", "ई": "", "उ": "", "ऊ": "", "ए": "", "ऐ": "",
    "ओ": "", "औ": "",
}


def norm(word: str) -> str:
    s = unicodedata.normalize("NFKD", word.casefold())
    return "".join(ch for ch in s if unicodedata.category(ch)[0] in "LN")


def skeleton(word: str) -> str:
    out = []
    for ch in norm(word):
        if ch in _UR:
            out.append(_UR[ch])
        elif ch in _DEV:
            out.append(_DEV[ch])
        elif "a" <= ch <= "z" or ch.isdigit():
            out.append(ch)
    s = "".join(out)
    s = s.replace("q", "k").replace("ph", "f").replace("x", "ks").replace("c", "k")
    s = re.sub(r"[aeiouywvh]", "", s)
    return re.sub(r"(.)\1+", r"\1", s)


class _Word:
    __slots__ = ("n", "k")

    def __init__(self, text: str):
        self.n, self.k = norm(text), skeleton(text)


_cache: dict[tuple[str, str], float] = {}


def similarity(a: _Word, b: _Word) -> float:
    if not a.n or not b.n:
        return 0.0
    if a.n == b.n:
        return 1.0
    key = (a.n, b.n)
    if key in _cache:
        return _cache[key]
    best = 0.0
    if a.n[0] == b.n[0] or abs(len(a.n) - len(b.n)) <= 3:
        best = SequenceMatcher(None, a.n, b.n).ratio()
    if len(a.k) >= 2 and len(b.k) >= 2 and a.k[0] == b.k[0]:
        best = max(best, 0.9 * SequenceMatcher(None, a.k, b.k).ratio())
    elif a.k and a.k == b.k:
        best = max(best, 0.7)
    _cache[key] = best
    return best


MATCH = 0.7  # a word pair counts as the same word at or above this


def _align(lyr: list[_Word], heard: list[_Word]) -> list[tuple[int, int]]:
    """Best in-order matching (i in lyrics, j in heard). O(n*m)."""
    n, m = len(lyr), len(heard)
    score = [[0.0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        row, prev, a = score[i], score[i - 1], lyr[i - 1]
        for j in range(1, m + 1):
            best = prev[j] if prev[j] > row[j - 1] else row[j - 1]
            s = similarity(a, heard[j - 1])
            if s >= MATCH and prev[j - 1] + s > best:
                best = prev[j - 1] + s
            row[j] = best
    pairs, i, j = [], n, m
    while i and j:
        s = similarity(lyr[i - 1], heard[j - 1])
        if s >= MATCH and abs(score[i][j] - (score[i - 1][j - 1] + s)) < 1e-9:
            pairs.append((i - 1, j - 1)); i -= 1; j -= 1
        elif score[i - 1][j] >= score[i][j - 1]:
            i -= 1
        else:
            j -= 1
    return pairs[::-1]


WORD_SEC = 0.38  # rough length of a sung word, for lines matched mid-way
MIN_LINE = 0.8   # a sung line takes at least this long


_LABEL_WORDS = r"(intro|outro|verse|chorus|pre-?chorus|post-?chorus|hook|bridge|refrain|interlude|instrumental|break|breakdown|coda|drop|solo|spoken|ad-?libs?)"


def is_section_label(text: str) -> bool:
    """Song-structure labels people paste with lyrics ("[Verse 2 – HOP]", "**Chorus:**").
    They aren't sung, so they never get a time or a caption. A plain bracketed
    line like "(ooh ooh)" is backing vocals and stays a lyric."""
    t = text.strip().strip("*_ ").strip()
    if not t:
        return False
    if t.startswith("[") and t.endswith("]"):
        return True
    core = t.strip("()[]{}:-–— ").strip("*_ ").lower()
    return bool(re.fullmatch(_LABEL_WORDS + r"\b[\w\s&'’.,:–—-]{0,40}", core))


def is_rtl_text(text: str) -> bool:
    """Like dir="auto": the first letter with a direction decides."""
    for ch in text:
        if "\u0590" <= ch <= "\u08ff" or "\ufb1d" <= ch <= "\ufdff" or "\ufe70" <= ch <= "\ufeff":
            return True
        if ch.isalpha():
            return False
    return False


def align_lyrics(lines: list[dict], segments: list[dict], duration: float) -> dict:
    heard_raw = [w for seg in segments for w in seg.get("words", []) if norm(w.get("w", ""))]
    heard = [_Word(w["w"]) for w in heard_raw]
    tokens: list[tuple[int, int]] = []  # (line index, word index in line)
    lyr: list[_Word] = []
    line_words = []
    for li, line in enumerate(lines):
        ws = [w for w in line["text"].split() if norm(w)]
        line_words.append(len(ws))
        for k, w in enumerate(ws):
            tokens.append((li, k)); lyr.append(_Word(w))

    matched: dict[int, list[tuple[int, dict]]] = {}
    for ti, hj in _align(lyr, heard):
        li, k = tokens[ti]
        matched.setdefault(li, []).append((k, heard_raw[hj]))

    # Heard anchors per line: enough of the line must have been heard.
    auto: dict[int, tuple[float, float | None]] = {}
    for li, hits in matched.items():
        need = 1 if line_words[li] <= 2 else max(2, math.ceil(line_words[li] * 0.4))
        if len(hits) < need:
            continue
        k0, w0 = hits[0]
        k1, w1 = hits[-1]
        start = max(0.0, w0["s"] - k0 * WORD_SEC)
        end = min(duration, w1["e"] + (line_words[li] - 1 - k1) * WORD_SEC + 0.3)
        auto[li] = (start, end, len(hits) / max(1, line_words[li]) + len(hits) * 0.1)

    # Pick a consistent set of anchors: in line order, increasing in time, with at least
    # MIN_LINE seconds per line between two anchors (so a stray match can't squeeze
    # a whole verse into a second). Weighted by how well each line was heard; the
    # user's own times always win.
    user = {i: (l["start"], l.get("end")) for i, l in enumerate(lines) if l.get("start") is not None}
    ukeys = sorted(user)

    def fits(i: int, t: float) -> bool:  # leaves room for the lines between it and the user's times
        before = [u for u in ukeys if u < i]
        after = [u for u in ukeys if u > i]
        if before and t - user[before[-1]][0] < MIN_LINE * (i - before[-1]):
            return False
        return not (after and user[after[0]][0] - t < MIN_LINE * (after[0] - i))
    cands = sorted((i, s, e, w) for i, (s, e, w) in auto.items() if i not in user and fits(i, s))
    best, back = [0.0] * len(cands), [-1] * len(cands)
    for b, (ib, sb, _, wb) in enumerate(cands):
        best[b] = wb
        for a in range(b):
            ia, sa, _, _ = cands[a]
            if ia < ib and sb - sa >= MIN_LINE * (ib - ia) and best[a] + wb > best[b]:
                best[b], back[b] = best[a] + wb, a
    anchors: dict[int, tuple[float, float | None]] = dict(user)
    if cands:
        k = max(range(len(cands)), key=lambda x: best[x])
        while k >= 0:
            i, s0, e0, _ = cands[k]
            anchors[i] = (s0, e0)
            k = back[k]
    heard_lines = len([i for i in anchors if i not in user])
    if not anchors:
        return {"lines": lines, "heard": 0, "estimated": 0, "kept": 0}

    # Seconds per character from matched lines, to place unheard lines.
    keys = sorted(anchors)
    rates = []
    for a, b in zip(keys, keys[1:]):
        if b == a + 1:
            gap = anchors[b][0] - anchors[a][0]
            if 0.5 < gap < 15:
                rates.append(gap / max(1, len(lines[a]["text"])))
    rate = sorted(rates)[len(rates) // 2] if rates else 0.12

    out = [dict(l) for l in lines]
    for i, (s, e) in anchors.items():
        out[i]["start"] = round(s, 3)
        if i not in user:
            out[i]["end"] = round(e, 3) if e else None
            out[i].pop("est", None)
            out[i]["heard"] = True  # timed by auto-sync from the audio
    estimated = 0
    i = 0
    while i < len(out):
        if i in anchors:
            i += 1
            continue
        j = i
        while j < len(out) and j not in anchors:
            j += 1
        run = list(range(i, j))
        lens = [max(4, len(out[r]["text"])) for r in run]
        prev = keys[keys.index(i - 1)] if (i - 1) in anchors else None
        lo = (out[prev].get("end") or out[prev]["start"] + rate * lens[0]) if prev is not None else None
        hi = out[j]["start"] if j < len(out) else None
        if lo is None:
            lo = max(0.0, hi - rate * sum(lens))
        if hi is None or hi <= lo:
            hi = min(duration, lo + rate * sum(lens)) if hi is None else lo + 0.3 * len(run)
        span = hi - lo
        t = lo
        total = sum(lens)
        for r, ln in zip(run, lens):
            out[r]["start"] = round(min(t, duration), 3)
            out[r]["end"] = None
            out[r].pop("heard", None)
            out[r]["est"] = True  # placed between heard lines, not heard itself
            t += span * ln / total
            estimated += 1
        i = j
    return {"lines": out, "heard": heard_lines, "estimated": estimated, "kept": len(user)}
