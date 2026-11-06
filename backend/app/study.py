"""Turn a PDF or PowerPoint into study flashcards grounded in retrieved passages."""

import json
import random
import re
from pathlib import Path

from .pdf import extract_pages
from .slides import extract_slides

# Leave room for the prompt and the card JSON inside a local 8k context.
MAX_SOURCE_CHARS = 6_000

# Ollama structured output. A top-level array makes the model stop when the deck is finished.
CARD_SCHEMA = {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {
            "front": {"type": "string"},
            "back": {"type": "string"},
            "source": {"type": "string"},
        },
        "required": ["front", "back", "source"],
    },
}

# Queries embedded the same way as a chat question, then matched against chunk vectors.
STUDY_QUERY_POOL = (
    "definitions, terminology, and key concepts to memorize",
    "important mechanisms, processes, steps, causes, and effects",
    "comparisons, contrasts, differences, and relationships",
    "practical examples, scenarios, formulas, and applications",
    "critical principles, takeaways, and foundational conclusions",
)
STUDY_QUERIES = STUDY_QUERY_POOL[:3]


def sample_study_queries(k: int = 3) -> list[str]:
    """Pick a varied set of query angles to probe different passages across regenerations."""
    return random.sample(STUDY_QUERY_POOL, min(k, len(STUDY_QUERY_POOL)))


CARD_COUNTS = (3, 5, 8, 12, 15)

PEDAGOGICAL_ANGLES = (
    "Vary question types across recall, comprehension, and application. Emphasize definitions, core terminology, and key distinctions.",
    "Vary question types across recall, comprehension, and application. Emphasize 'why' and 'how' questions, causal mechanisms, and processes.",
    "Vary question types across recall, comprehension, and application. Emphasize comparisons, contrasts, and relationships between concepts.",
    "Vary question types across recall, comprehension, and application. Emphasize short scenario prompts, practical examples, and concrete applications.",
    "Vary question types across recall, comprehension, and application. Emphasize core principles, critical consequences, and key takeaways.",
)

SYSTEM_PROMPT = """You are a flashcard generation engine for a study app. You create high-quality study flashcards from retrieved document excerpts. Each excerpt is labeled with its page or slide (for example, "[Page 3]" or "[Slide 2]").

Goal:
Produce flashcards that reliably test deep understanding of the material in the excerpts. Cover the key concepts, definitions, relationships, causes and effects, processes, and examples that appear in the excerpts.

Guidelines & Standards:
1. Strict Grounding: Ground every card strictly in the text of the excerpts. Do not add facts from outside knowledge, and do not guess at details the excerpts do not state.
2. Self-Contained: Keep each card self-contained so it makes sense on its own, without needing the surrounding text.
3. Varied Question Types: Vary question types to test recall, comprehension, and application: definitions, "why" and "how" questions, comparisons, and short scenario prompts where the material supports them. Avoid trivial yes/no questions and near-duplicate cards.
4. Concise & Readable: Keep each front and back short enough to read at a glance, typically one to three sentences.
   - "front": a clear question, term, or cue
   - "back": a concise, accurate answer that a student can check against the source
   - "source": the excerpt label the card was drawn from, copied exactly (e.g., "Page 3" or "Slide 2")
5. Noise Filtering: Skip boilerplate such as headers, page numbers, references, and filler text. If excerpts contain little substantive content, produce fewer cards rather than inventing material.
6. JSON Output: Return a JSON array of objects and nothing else. No markdown fences, no thinking trace, and no commentary. Start your reply directly with [."""


class DocumentError(ValueError):
    """The upload is not a PDF or a .pptx presentation."""


def detect_kind(name: str, head: bytes) -> str:
    """Return 'pdf' or 'pptx' from the filename and the first bytes of the file."""
    lower = Path(name).name.lower()
    if head.startswith(b"\xd0\xcf\x11\xe0") or lower.endswith(".ppt"):
        raise DocumentError("Older .ppt files are not supported. Save the deck as .pptx and upload that.")
    if b"%PDF-" in head[:1024] or lower.endswith(".pdf"):
        return "pdf"
    if lower.endswith(".pptx") or head[:2] == b"PK":
        return "pptx"
    raise DocumentError("Upload a PDF or a PowerPoint file (.pptx).")


def load_units(path: Path, kind: str) -> tuple[str, int, list[tuple[int, str]]]:
    """Return (label, unit count, non-empty units). Label is 'Page' or 'Slide'."""
    if kind == "pdf":
        return ("Page", *extract_pages(path))
    if kind == "pptx":
        return ("Slide", *extract_slides(path))
    raise DocumentError("Upload a PDF or a PowerPoint file (.pptx).")


def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0].rstrip()
    return (cut or text[:limit].rstrip()) + "…"


def fit_source(units: list[tuple[int, str]], label: str, limit: int = MAX_SOURCE_CHARS) -> str:
    """Join labeled units, shortening each one so the whole source stays within `limit`."""
    if not units:
        return ""
    per_unit = max(24, limit // len(units))
    while True:
        parts = [
            f"[{label} {number}]\n{_truncate(text, per_unit)}"
            for number, text in units
        ]
        joined = "\n\n".join(parts)
        if len(joined) <= limit or per_unit <= 24:
            return joined
        per_unit = max(24, int(per_unit * 0.75))


def _dot(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def retrieve_units(
    units: list[tuple[int, str]],
    vectors: list[list[float]],
    query_vectors: list[list[float]],
    k: int,
) -> list[tuple[int, str]]:
    """Pick up to k passages by similarity to the study queries, then return them in document order.

    Ties keep the earlier passage. If the queries agree on too few passages, the rest of the
    slots are filled by walking the document so later pages still appear.
    """
    if k <= 0 or not units:
        return []
    k = min(k, len(units))
    chosen: list[int] = []
    seen: set[int] = set()

    def take(order: list[int], limit: int) -> None:
        got = 0
        for i in order:
            if i in seen:
                continue
            seen.add(i)
            chosen.append(i)
            got += 1
            if got >= limit or len(chosen) >= k:
                return

    per_query = max(1, -(-k // max(1, len(query_vectors))))
    for qv in query_vectors:
        ranked = sorted(range(len(units)), key=lambda i: (-_dot(qv, vectors[i]), i))
        take(ranked, per_query)
        if len(chosen) >= k:
            break

    if len(chosen) < k:
        need = k - len(chosen)
        candidates = [i for i in range(len(units)) if i not in seen]
        if need >= len(candidates):
            take(candidates, need)
        else:
            step = len(candidates) / need
            picks = [candidates[min(len(candidates) - 1, int(i * step))] for i in range(need)]
            take(picks, need)

    return [units[i] for i in sorted(chosen)]


def build_messages(source: str, count: int, angle: str | None = None) -> list[dict[str, str]]:
    focus = angle or random.choice(PEDAGOGICAL_ANGLES)
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": (
                f"Create up to {count} flashcards from the retrieved excerpts.\n"
                f"Pedagogical focus for this set: {focus}\n"
                "If the excerpts contain little substantive content, produce fewer cards rather than inventing material.\n\n"
                f"Here are the excerpts to process:\n\"\"\"\n{source}\n\"\"\""
            ),
        },
    ]


def _clip(value: object, limit: int) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:limit].rstrip()


def parse_cards(raw: str, limit: int) -> list[dict[str, str]]:
    """Pull a JSON card list out of a model response. Raises ValueError when nothing usable is there."""
    text = raw.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    start, end = text.find("["), text.rfind("]")
    if start != -1 and end > start:
        data = json.loads(text[start : end + 1])
    else:
        obj_start, obj_end = text.find("{"), text.rfind("}")
        if obj_start == -1 or obj_end <= obj_start:
            raise ValueError("no JSON")
        data = json.loads(text[obj_start : obj_end + 1])

    if isinstance(data, dict):
        for key in ("cards", "flashcards", "items"):
            if isinstance(data.get(key), list):
                data = data[key]
                break
    if not isinstance(data, list):
        raise ValueError("not a list")

    cards: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in data:
        if not isinstance(item, dict):
            continue
        front = _clip(item.get("front") or item.get("question") or item.get("term"), 280)
        back = _clip(item.get("back") or item.get("answer") or item.get("definition"), 700)
        source = _clip(item.get("source") or item.get("page") or item.get("slide"), 40)
        key = front.casefold()
        if not front or not back or key in seen:
            continue
        seen.add(key)
        cards.append({"front": front, "back": back, "source": source})
        if len(cards) >= limit:
            break
    if not cards:
        raise ValueError("no cards")
    return cards
