// Browser-side client for the FastAPI backend. The browser calls the backend directly
// (published on the host), so this must be a host-reachable URL, never a Docker service name.
export const API_BASE = (import.meta.env.VITE_API_BASE_URL || "http://localhost:8000").replace(/\/+$/, "");

const unreachable = () => new Error(`Cannot reach the server at ${API_BASE}. Is the backend running?`);

async function errorMessage(res) {
  try {
    const { detail } = await res.json();
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) return detail.map((d) => d.msg).join("; ");
  } catch {
    /* body was not JSON */
  }
  return `Request failed (HTTP ${res.status}).`;
}

// POST /api/upload -> { doc_id, filename, pages, units, unit_label, chunks, kind }
export async function uploadDocument(file) {
  const body = new FormData();
  body.append("file", file);
  let res;
  try {
    res = await fetch(`${API_BASE}/api/upload`, { method: "POST", body });
  } catch {
    throw unreachable();
  }
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export const uploadPdf = uploadDocument;

// POST /api/study -> { filename, kind, units, unit_label, cards: [{ front, back, source }] }
export async function generateFlashcards(file, count) {
  const body = new FormData();
  body.append("file", file);
  body.append("count", String(count));
  let res;
  try {
    res = await fetch(`${API_BASE}/api/study`, { method: "POST", body, signal: AbortSignal.timeout(180_000) });
  } catch (e) {
    if (e.name === "TimeoutError" || e.name === "AbortError") {
      throw new Error("Flashcard generation took too long. Try again with fewer cards.");
    }
    throw unreachable();
  }
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

// GET /api/health also reports the PDF that is already indexed (it answers 503 when Ollama is
// down, but the body is still useful), so a page reload can pick the existing index back up.
export async function getIndexedDocument() {
  try {
    const res = await fetch(`${API_BASE}/api/health`);
    const body = await res.json();
    return body?.chroma?.document ?? null;
  } catch {
    return null;
  }
}

// Parses one SSE block ("event: x\ndata: {...}") into [event, data].
function parseBlock(block) {
  let event = "message";
  const data = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return [event, data.length ? JSON.parse(data.join("\n")) : null];
}

// POST /api/chat and read the Server-Sent Events incrementally from the response body.
// Resolves only after a `done` event; rejects on an `error` event, a bad HTTP status,
// a dropped connection, or a stream that ends without `done`.
export async function streamChat(question, { onSources, onToken, onThinking, signal }) {
  let res;
  try {
    res = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
      signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw unreachable();
  }
  if (!res.ok) throw new Error(await errorMessage(res));
  if (!res.body) throw new Error("This browser does not support streaming responses.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let tokens = 0;

  // Returns true when the stream is complete.
  const handle = (block) => {
    if (!block.trim()) return false;
    const [event, data] = parseBlock(block);
    if (event === "sources") onSources?.(data);
    else if (event === "thinking") {
      tokens += 1;
      onThinking?.(data?.text || "");
    } else if (event === "token") {
      tokens += 1;
      onToken?.(data?.text || "");
    } else if (event === "error") throw new Error(data?.message || "The answer could not be generated.");
    else if (event === "done") {
      if (tokens === 0) throw new Error("The model returned an empty response.");
      return true;
    }
    return false;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done }).replace(/\r\n/g, "\n");
      let end;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (handle(block)) return;
      }
      if (done) break;
    }
    if (handle(buffer)) return;
  } catch (e) {
    if (e.name === "AbortError") throw e;
    if (e instanceof SyntaxError) throw new Error("Received a malformed response from the server.");
    if (e instanceof TypeError) throw new Error("The connection was lost while receiving the answer.");
    throw e;
  } finally {
    reader.cancel().catch(() => {});
  }
  throw new Error("The connection closed before the answer was complete.");
}
