from dataclasses import dataclass
from functools import lru_cache

import chromadb
from chromadb.config import Settings

from . import config
from .pdf import Chunk

COLLECTION = "pdf"
BATCH = 200


@dataclass(frozen=True)
class Hit:
    page: int
    text: str


@lru_cache(maxsize=1)
def _client() -> chromadb.api.ClientAPI:
    return chromadb.HttpClient(
        host=config.CHROMA_HOST,
        port=config.CHROMA_PORT,
        settings=Settings(anonymized_telemetry=False),
    )


def _collection():
    return _client().get_or_create_collection(COLLECTION)


def ping() -> None:
    _client().heartbeat()


def current_document() -> dict | None:
    """Metadata of the currently indexed document (doc_id, filename, pages, chunks, kind), if any."""
    meta = _collection().metadata or {}
    if "doc_id" not in meta:
        return None
    doc = dict(meta)
    if "kind" not in doc:
        doc["kind"] = "pptx" if doc.get("filename", "").lower().endswith(".pptx") else "pdf"
    return doc


def replace_index(
    doc_id: str,
    filename: str,
    page_count: int,
    chunks: list[Chunk],
    vectors: list[list[float]],
    kind: str = "pdf",
) -> None:
    """Index the new document, then drop everything belonging to previous ones.

    The old index stays intact if indexing the new document fails.
    """
    col = _collection()
    ids = [f"{doc_id}:{n}" for n in range(len(chunks))]
    try:
        for i in range(0, len(chunks), BATCH):
            part = slice(i, i + BATCH)
            col.add(
                ids=ids[part],
                embeddings=vectors[part],
                documents=[c.text for c in chunks[part]],
                metadatas=[{"doc_id": doc_id, "page": c.page} for c in chunks[part]],
            )
        col.modify(
            metadata={
                "doc_id": doc_id,
                "filename": filename,
                "pages": page_count,
                "chunks": len(chunks),
                "kind": kind,
            }
        )
    except Exception:
        try:
            col.delete(where={"doc_id": doc_id})
        except Exception:
            pass
        raise
    col.delete(where={"doc_id": {"$ne": doc_id}})


def search(vector: list[float], doc_id: str, k: int) -> list[Hit]:
    res = _collection().query(
        query_embeddings=[vector],
        n_results=k,
        where={"doc_id": doc_id},
        include=["documents", "metadatas"],
    )
    return [
        Hit(page=int(meta["page"]), text=doc)
        for doc, meta in zip(res["documents"][0], res["metadatas"][0])
    ]
