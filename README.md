# Indexio

**Indexio** is a private, local Retrieval-Augmented Generation (RAG) platform supporting **PDF** and **PowerPoint (.pptx)** documents with two distinct modes: **Chat Mode** and **Study Mode**.

### 👥 Team Members

| Member Name | Roll Number |
|---|---|
| **Ashish M K S** | `24PC03` |
| **Ashwin K** | `24PC04` |
| **Pranesh R** | `24PC21` |
| **Sachin Saravan K** | `24PC31` |

---

Built with **React (Vite) + Tailwind CSS**, **FastAPI**, **PyMuPDF**, **python-pptx**, **SentenceTransformers (`BAAI/bge-small-en-v1.5`)**, **ChromaDB**, and **LM Studio** for local LLM inference. All parsing, embeddings, vector search, and model completions run 100% locally on your machine with zero external API calls.

---

## Architecture & Services

| Service | Host URL | Container / Internal URL | Notes |
|---|---|---|---|
| **Frontend UI** | `http://localhost:5173` | Container port `5173` | Modern Midnight-themed React app with Vite |
| **Backend API** | `http://localhost:8000` | Published on `127.0.0.1:8000` | FastAPI server handling RAG, search, and streaming |
| **ChromaDB** | Not exposed | `chroma:8000` | High-performance vector database container |
| **LM Studio** | `http://localhost:1234` | `http://host.docker.internal:1234` | Local LLM server running on host machine |

---

## Features & Modes

### 1. Chat Mode
- **Multi-Format Ingestion**: Upload any **PDF** or **PowerPoint presentation (`.pptx`)**.
- **Accurate Grounding**: Answers are strictly grounded in retrieved passages from the active document, preventing hallucinations.
- **Dynamic Citations**: Automatically cites sources using appropriate units—`[Page 1]` for PDFs and `[Slide 1]` for presentations—highlighted with styled inline badge pills.
- **Streaming & Thought Process**: Streams tokens in real-time via Server-Sent Events (SSE). Thinking models (e.g., Qwen 3.5, DeepSeek R1) render reasoning in a collapsible thought process tray.
- **Single Active Document Index**: Uploading a new document automatically purges previous files and resets the vector store index.

### 2. Study Mode
- **Automated Flashcard Generation**: Turn any PDF or PowerPoint deck into interactive study flashcards.
- **Pedagogical Excerpt Probing**: Runs multi-angle semantic queries (definitions, causal mechanisms, comparisons, practical scenarios, core principles) to sample diverse, high-value concepts across the entire document.
- **Interactive 3D Card Deck**: Flip cards to reveal answers and definitions with smooth 3D CSS animations.
- **Keyboard Navigation**:
  - `Space` or `Enter`: Flip card front/back.
  - `Left Arrow` / `Right Arrow`: Navigate between flashcards.
- **Source Badges**: Every card tracks and attributes its exact origin (e.g., `Page 3` or `Slide 5`).
- **Flexible Deck Sizes**: Generate 3, 5, 8, 12, or 15 cards per session.
- **Isolated Indexing**: Study Mode uses a one-shot extraction that does not overwrite your active Chat Mode document.

---

## Quickstart

### 1. Prepare LM Studio
1. Download and open [LM Studio](https://lmstudio.ai/).
2. Download any chat model (e.g., `qwen3.5-9b`, `gemma-2-9b`, `llama-3.1-8b`, or similar).
3. Navigate to the **Developer / Local Server** tab in LM Studio (`<->` icon).
4. Select your loaded model from the top dropdown.
5. Click **Start Server** on port **1234** (ensure CORS is enabled in LM Studio settings).

### 2. Configure Environment

Copy the example environment configuration:

```bash
cp .env.example .env
```

Ensure your `.env` contains:

```env
API_PORT=8000
LLM_PROVIDER=lmstudio
LLM_BASE_URL=http://host.docker.internal:1234
LLM_MODEL=qwen3.5-9b
```

### 3. Launch with Docker Compose

```bash
docker compose up --build
```

- On the first startup, the embedding model (`BAAI/bge-small-en-v1.5`, ~130 MB) will be downloaded to the `hf_cache` Docker volume; subsequent launches reuse this cache.
- Open your browser to **http://localhost:5173**.

### 4. Verify Health

Check if the backend can communicate with ChromaDB and LM Studio:

```bash
curl http://localhost:8000/api/health
```

Expected response (`200 OK`):
```json
{
  "status": "ok",
  "chroma": { "ok": true, "document": null },
  "llm": {
    "ok": true,
    "provider": "lmstudio",
    "model": "qwen3.5-9b",
    "model_available": true
  },
  "embedding_model_loaded": true
}
```

---

## How It Works

### Ingestion & Text Extraction
- **PDF Documents**: Parsed with `PyMuPDF`. Text is cleaned, stripped of redundant whitespace, and mapped by page number.
- **PowerPoint Presentations**: Parsed with `python-pptx`. Extracts text frames, grouped shapes, structured tables, and speaker notes, indexed slide by slide.
- **Legacy Formats**: Older binary `.ppt` files are rejected with an informative prompt directing the user to save as modern `.pptx`.

### Chunking & Vector Search
- Pages and slides are chunked using windowing (~500 tokens per chunk with 50-token overlap), never crossing slide or page boundaries.
- Vectors are generated using the local `BAAI/bge-small-en-v1.5` sentence-transformer.
- Passages are saved into ChromaDB with metadata tags (`doc_id`, `page`/`slide`, `kind`).

### Grounded Answering & Citations
- User queries are embedded and matched against ChromaDB using cosine similarity (top $K$, default 5).
- A specialized system prompt enforces strict grounding without speculation, instructing the model to cite chunks directly using `[Page N]` or `[Slide N]`.
- The response is streamed incrementally to the browser via SSE.

---

## API Reference

### 1. Upload Document (Chat Mode)
```bash
curl -F "file=@presentation.pptx" http://localhost:8000/api/upload
```
**Response**:
```json
{
  "doc_id": "78a9c3d4e5f6...",
  "filename": "presentation.pptx",
  "pages": 12,
  "units": 12,
  "unit_label": "Slide",
  "chunks": 24,
  "kind": "pptx"
}
```

### 2. Stream Chat Completion
```bash
curl -N -X POST http://localhost:8000/api/chat \
     -H 'Content-Type: application/json' \
     -d '{"question": "What is the primary conclusion in slide 4?"}'
```

**SSE Events**:
- `event: sources`: `[1, 4]` (retrieved page or slide numbers)
- `event: thinking`: `{"text": "..."}` (model internal reasoning, if supported by loaded model)
- `event: token`: `{"text": "..."}` (answer text tokens)
- `event: done`: `{}` (stream finished)
- `event: error`: `{"message": "..."}` (streaming failure)

### 3. Generate Study Flashcards
```bash
curl -F "file=@notes.pdf" \
     -F "count=8" \
     http://localhost:8000/api/study
```

**Response**:
```json
{
  "filename": "notes.pdf",
  "kind": "pdf",
  "units": 15,
  "unit_label": "Page",
  "cards": [
    {
      "front": "What is Mitosis?",
      "back": "A type of cell division that results in two daughter cells each having the same number and kind of chromosomes as the parent nucleus.",
      "source": "Page 3"
    }
  ]
}
```

### 4. Health & Status Check
```bash
curl http://localhost:8000/api/health
```

---

## Running Locally Without Docker

If you prefer to run services directly on your host machine:

### 1. Run ChromaDB
```bash
docker run -d --name chroma -p 8000:8000 -v chroma_data:/data chromadb/chroma:1.5.9
```

### 2. Run Backend
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt

export CHROMA_HOST=localhost
export CHROMA_PORT=8000
export LLM_PROVIDER=lmstudio
export LLM_BASE_URL=http://localhost:1234
export LLM_MODEL=qwen3.5-9b

uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

### 3. Run Frontend
```bash
cd frontend
npm install
npm run dev
```

---

## Running Tests

The test suite runs with simulated fakes for ChromaDB, embeddings, and LM Studio, requiring no external running services:

```bash
cd backend
source .venv/bin/activate
pytest backend/tests
```

---

## Configuration Variables

| Variable | Default | Description |
|---|---|---|
| `API_PORT` | `8000` | Host port for FastAPI backend |
| `LLM_PROVIDER` | `lmstudio` | Language model provider (`lmstudio` or `openai`) |
| `LLM_BASE_URL` | `http://host.docker.internal:1234` | Base URL for LM Studio OpenAI-compatible endpoint |
| `LLM_MODEL` | `qwen3.5-9b` | Model name loaded in LM Studio |
| `EMBEDDING_MODEL` | `BAAI/bge-small-en-v1.5` | Hugging Face model for passage/query embeddings |
| `CHUNK_TOKENS` | `500` | Token budget per chunk |
| `CHUNK_OVERLAP` | `50` | Shared token count between sequential chunks |
| `TOP_K` | `5` | Number of chunks retrieved for chat queries |
| `MAX_UPLOAD_MB` | `50` | Maximum file upload limit in MB |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Allowed browser origins |

---

## Troubleshooting

| Symptom | Likely Cause | Solution |
|---|---|---|
| `/api/health` reports `llm.ok: false` | LM Studio server is not running or no model loaded | In LM Studio, click the **Local Server** icon (`<->`), choose a model from the top dropdown, and click **Start Server** on port 1234. |
| LM Studio unreachable from Docker container | Bind address is restricted to `127.0.0.1` | In LM Studio Server settings, check **Serve on Local Network** / set listening address to all interfaces (`0.0.0.0`). |
| `400 Older .ppt files are not supported` | Uploaded a legacy binary PowerPoint file | Open the presentation in PowerPoint or Keynote and **Save As** `.pptx`, then re-upload. |
| `422 No extractable text found` | Scanned PDF or presentation containing only images | The document contains raster images with no embedded text stream. Run OCR on the PDF before uploading. |
| `chroma.ok: false` | ChromaDB container stopped or crashed | Run `docker compose ps` and check logs using `docker compose logs chroma`. |
| Browser shows `Cannot reach server` or CORS error | Backend port or origin mismatch | Ensure backend is healthy at `http://localhost:8000/api/health` and verify `CORS_ORIGINS` includes your browser address. |
