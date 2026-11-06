import asyncio
import json
import logging
import os
import threading
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, StringConstraints

from . import config, embeddings, llm, store
from .pdf import PDFError, chunk_pages, extract_pages
from .slides import SlideError
from .study import (
    CARD_COUNTS,
    CARD_SCHEMA,
    DocumentError,
    build_messages,
    detect_kind,
    fit_source,
    load_units,
    parse_cards,
    retrieve_units,
    sample_study_queries,
)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("app")



@asynccontextmanager
async def lifespan(_: FastAPI):
    config.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    await asyncio.to_thread(embeddings.model)
    yield


app = FastAPI(title="Indexio", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["content-type"],
)
upload_lock = threading.Lock()


def _store(fn, *args):
    try:
        return fn(*args)
    except Exception:
        log.exception("ChromaDB call failed")
        raise HTTPException(503, "The vector store (ChromaDB) is unavailable.")


def _write_upload(file: UploadFile, dest: Path) -> bytes:
    """Save an upload within the size limit and return its first bytes."""
    limit = config.MAX_UPLOAD_MB * 1024 * 1024
    size = 0
    head = b""
    with dest.open("wb") as out:
        while block := file.file.read(1024 * 1024):
            if not head:
                head = block[:1024]
            size += len(block)
            if size > limit:
                raise HTTPException(413, f"File exceeds the {config.MAX_UPLOAD_MB} MB limit.")
            out.write(block)
    return head



@app.post("/api/upload")
def upload(file: Annotated[UploadFile, File()]) -> dict:
    if not upload_lock.acquire(blocking=False):
        raise HTTPException(409, "Another upload is being processed. Try again shortly.")
    config.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    tmp = config.UPLOAD_DIR / f".incoming-{uuid.uuid4().hex}"
    try:
        head = _write_upload(file, tmp)
        try:
            kind = detect_kind(file.filename or "", head)
            label, unit_count, units = load_units(tmp, kind)
        except (DocumentError, PDFError, SlideError) as e:
            raise HTTPException(400, str(e))
        if not units:
            raise HTTPException(
                422,
                "No extractable text found. Scanned pages and image-only slides are not supported.",
            )

        chunks = chunk_pages(units, embeddings.token_spans, config.CHUNK_TOKENS, config.CHUNK_OVERLAP)
        vectors = embeddings.embed_passages([c.text for c in chunks])

        doc_id = uuid.uuid4().hex
        ext = ".pptx" if kind == "pptx" else ".pdf"
        filename = Path(file.filename or f"document{ext}").name
        _store(store.replace_index, doc_id, filename, unit_count, chunks, vectors, kind)

        final = config.UPLOAD_DIR / f"{doc_id}{ext}"
        os.replace(tmp, final)
        for old in config.UPLOAD_DIR.glob("*"):
            if (
                old != final
                and not old.name.startswith(".incoming-")
                and not old.name.startswith(".study-")
            ):
                old.unlink(missing_ok=True)
        log.info("Indexed %s: %d %ss, %d chunks", filename, unit_count, label.lower(), len(chunks))
        return {
            "doc_id": doc_id,
            "filename": filename,
            "pages": unit_count,
            "units": unit_count,
            "unit_label": label,
            "chunks": len(chunks),
            "kind": kind,
        }
    finally:
        tmp.unlink(missing_ok=True)
        upload_lock.release()


class ChatRequest(BaseModel):
    question: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]


def _study_source(units: list[tuple[int, str]], label: str, count: int) -> str:
    """Chunk the file, embed it, and retrieve passages for the flashcard prompt.

    This is a one-shot index. It does not replace the chat document in ChromaDB.
    """
    chunks = chunk_pages(units, embeddings.token_spans, config.CHUNK_TOKENS, config.CHUNK_OVERLAP)
    if not chunks:
        return ""
    vectors = embeddings.embed_passages([c.text for c in chunks])
    queries = sample_study_queries(3)
    query_vectors = [embeddings.embed_query(q) for q in queries]
    k = min(len(chunks), max(count, config.TOP_K))
    selected = retrieve_units([(c.page, c.text) for c in chunks], vectors, query_vectors, k)
    return fit_source(selected, label)


@app.post("/api/study")
async def study(
    file: Annotated[UploadFile, File()],
    count: Annotated[int, Form()] = 8,
) -> dict:
    """Build flashcards from retrieved passages of one PDF or .pptx. Does not replace the chat index."""
    if count not in CARD_COUNTS:
        raise HTTPException(422, "Ask for 3, 5, 8, 12, or 15 flashcards.")
    if not upload_lock.acquire(blocking=False):
        raise HTTPException(409, "Another upload is being processed. Try again shortly.")
    tmp = None
    try:
        config.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        tmp = config.UPLOAD_DIR / f".study-{uuid.uuid4().hex}"
        head = await run_in_threadpool(_write_upload, file, tmp)
        try:
            kind = detect_kind(file.filename or "", head)
            label, unit_count, units = await run_in_threadpool(load_units, tmp, kind)
        except (DocumentError, PDFError, SlideError) as e:
            raise HTTPException(400, str(e))
        source = await run_in_threadpool(_study_source, units, label, count) if units else ""
        if not source:
            raise HTTPException(
                422,
                "No extractable text found. Scanned pages and image-only slides are not supported.",
            )
        messages = build_messages(source, count)
        log.info("Generating up to %d flashcards from %d excerpt characters", count, len(source))
        try:
            # Token budget: 200 tokens per card (Gemma/local models are verbose) + 200 for the
            # array wrapper. Cap at 4096 so a rambling model cannot stall the request indefinitely.
            # Temperature is 0.75 so 'Regenerate' explores distinct concepts & question angles.
            raw = await llm.complete(
                messages,
                max_tokens=min(4096, 200 + count * 200),
                json_schema=CARD_SCHEMA,
                temperature=0.75,
            )
            cards = parse_cards(raw, count)
        except llm.LLMError as e:
            log.error("Study generation failed: %s", e)
            raise HTTPException(502, str(e))
        except (ValueError, json.JSONDecodeError):
            log.error("Study model returned unusable cards")
            raise HTTPException(502, "The model did not return usable flashcards. Try again.")
        filename = Path(file.filename or "document").name
        log.info("Study cards for %s: %d from %d %ss", filename, len(cards), unit_count, label.lower())
        return {
            "filename": filename,
            "kind": kind,
            "units": unit_count,
            "unit_label": label,
            "cards": cards,
        }
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)
        upload_lock.release()


def _retrieve(question: str) -> tuple[str, list[store.Hit]]:
    doc = _store(store.current_document)
    if doc is None:
        raise HTTPException(409, "No document has been uploaded yet.")
    kind = doc.get("kind") or ("pptx" if doc.get("filename", "").lower().endswith(".pptx") else "pdf")
    label = "Slide" if kind == "pptx" else "Page"
    vector = embeddings.embed_query(question)
    return label, _store(store.search, vector, doc["doc_id"], config.TOP_K)


def _sse(event: str, data: object) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@app.post("/api/chat")
async def chat(req: ChatRequest) -> StreamingResponse:
    label, hits = await run_in_threadpool(_retrieve, req.question)
    messages = llm.build_messages(req.question, hits, label=label)

    async def events():
        yield _sse("sources", sorted({h.page for h in hits}))
        try:
            # No max_tokens cap here: Gemma 4B e4b is a thinking model and spends its first
            # 200-400 tokens on internal reasoning before writing the answer. A hard cap
            # would cut it off before any visible content is produced.
            # Response length is controlled by the "1-3 sentences" rule in SYSTEM_PROMPT.
            async for chunk in llm.stream_answer(messages):
                event_type = "thinking" if getattr(chunk, "is_thinking", False) else "token"
                yield _sse(event_type, {"text": str(chunk)})
        except llm.LLMError as e:
            log.error("LLM failure: %s", e)
            yield _sse("error", {"message": str(e)})
            return
        except Exception:
            log.exception("Unexpected error while streaming")
            yield _sse("error", {"message": "Unexpected error while generating the answer."})
            return
        yield _sse("done", {})

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


async def _check_ollama() -> dict:
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{config.LLM_BASE_URL}/api/tags")
            r.raise_for_status()
        names = {m.get("name") for m in r.json().get("models", [])}
        available = config.LLM_MODEL in names or f"{config.LLM_MODEL}:latest" in names
        out = {"ok": available, "model": config.LLM_MODEL, "model_available": available}
        if not available:
            out["error"] = f"Model not found in Ollama. Run: ollama pull {config.LLM_MODEL}"
        return out
    except Exception as e:
        return {"ok": False, "model": config.LLM_MODEL, "error": repr(e)}


async def _check_openai() -> dict:
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{config.LLM_BASE_URL}/v1/models")
            r.raise_for_status()
        models = [m.get("id") for m in r.json().get("data", [])]
        available = bool(models)
        out = {
            "ok": available,
            "provider": config.LLM_PROVIDER,
            "model": config.LLM_MODEL,
            "models_available": models,
            "model_available": (config.LLM_MODEL in models) if config.LLM_MODEL else available,
        }
        if not available:
            out["error"] = "No models loaded in LM Studio. Please start the server and load a model."
        return out
    except Exception as e:
        return {"ok": False, "provider": config.LLM_PROVIDER, "model": config.LLM_MODEL, "error": repr(e)}


async def _check_llm() -> dict:
    if config.LLM_PROVIDER in ("lmstudio", "openai"):
        return await _check_openai()
    return await _check_ollama()


def _check_chroma() -> dict:
    try:
        store.ping()
        return {"ok": True, "document": store.current_document()}
    except Exception as e:
        return {"ok": False, "error": repr(e)}


@app.get("/api/health")
async def health() -> JSONResponse:
    chroma, llm_status = await asyncio.gather(asyncio.to_thread(_check_chroma), _check_llm())
    ok = chroma["ok"] and llm_status["ok"]
    body = {
        "status": "ok" if ok else "degraded",
        "chroma": chroma,
        "llm": llm_status,
        "embedding_model_loaded": embeddings.is_loaded(),
    }
    return JSONResponse(body, status_code=200 if ok else 503)
