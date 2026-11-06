import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  BookOpen,
  Bot,
  BrainCircuit,
  ChevronDown,
  FileText,
  Layers,
  Loader2,
  MessageSquare,
  Paperclip,
  Pencil,
  RotateCcw,
  Send,
  Sparkles,
  Square,
} from "lucide-react";
import { getIndexedDocument, streamChat, uploadDocument } from "./api.js";
import { marked } from "marked";
import DOMPurify from "dompurify";
import StudyMode from "./StudyMode.jsx";
import { Button } from "./components/ui/button.jsx";
import { Card } from "./components/ui/card.jsx";
import { Badge } from "./components/ui/badge.jsx";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs.jsx";
import { Textarea } from "./components/ui/textarea.jsx";
import { cn } from "./lib/utils.js";

const MAX_QUESTION = 2000;
let nextId = 0;
const uid = () => `m${++nextId}`;

const SUGGESTED_PROMPTS = [
  { label: "Summarize document", text: "Can you give a brief summary of this document?" },
  { label: "Key points & conclusions", text: "What are the key points and main conclusions?" },
  { label: "Primary findings", text: "What are the primary recommendations or findings?" },
];

// Renders rich Markdown with lists, headings, bold text, code, and inline citation badges
function AnswerText({ text }) {
  const html = useMemo(() => {
    if (!text) return "";
    // Normalize bullet points or numbered lists that appear inline without leading newlines
    let normalized = text
      .replace(/([^\n])\s+([*•-]\s+)/g, "$1\n\n$2")
      .replace(/([^\n])\s+(\d+\.\s+)/g, "$1\n\n$2");

    // Convert bulleted headers (e.g. "* **Heading:**") into clean standalone subheadings without bullets
    normalized = normalized.replace(
      /^[*•-]\s+(\*\*[^*:\n]+:?\*\*|\*\*[^*:\n]+\*\*:\s*)$/gm,
      (_, heading) => `\n#### ${heading.replace(/[*:]/g, "").trim()}\n`
    );

    const parsed = marked.parse(normalized, { breaks: true, gfm: true });
    // Transform inline citation labels like [Page 3] or [Slide 2] into styled badges
    const withBadges = parsed.replace(
      /(\[(?:Pages?|Chunks?|Slides?)\s[^\]\n]*\d[^\]\n]*\])/gi,
      '<span class="citation-badge">$1</span>'
    );
    return DOMPurify.sanitize(withBadges, {
      ADD_TAGS: ["span"],
      ADD_ATTR: ["class"],
    });
  }, [text]);

  return (
    <div
      className="prose-midnight text-slate-200 text-sm leading-relaxed"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// Collapsible thinking block for models with reasoning (Qwen 3.5, DeepSeek R1, Gemma thinking, etc.)
function ThinkingBlock({ thinking, isStreaming }) {
  const [open, setOpen] = useState(false);

  if (!thinking) return null;

  return (
    <div className="mb-3.5 rounded-xl border border-amber-500/25 bg-amber-500/5 backdrop-blur-md overflow-hidden transition-all duration-200">
      <div className="flex items-center justify-between px-3.5 py-2.5 bg-amber-500/10 border-b border-amber-500/15">
        <button
          type="button"
          className="flex items-center gap-2 text-xs font-semibold tracking-wide text-amber-300 hover:text-amber-200 transition-colors"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          <BrainCircuit className={cn("size-3.5 text-amber-400", isStreaming && "animate-pulse")} />
          <span>{isStreaming ? "Thinking through response…" : "Thought process"}</span>
          <ChevronDown
            className={cn(
              "size-3.5 text-amber-400/80 transition-transform duration-200",
              open && "rotate-180"
            )}
          />
        </button>
      </div>
      {open && (
        <pre className="p-3.5 text-xs text-amber-200/80 font-mono leading-relaxed overflow-x-auto whitespace-pre-wrap max-h-72 border-t border-amber-500/10 bg-black/20">
          {thinking}
        </pre>
      )}
    </div>
  );
}

function Message({ msg, onStop, onEditPrompt, isLatestAssistant, isBusy, lastQuestion }) {
  if (msg.role === "user") {
    return (
      <div className="group flex justify-end items-end gap-2 my-4 pl-8 sm:pl-16">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7 rounded-lg text-slate-500 opacity-0 group-hover:opacity-100 hover:text-slate-300 hover:bg-slate-800 transition-all duration-150 shrink-0"
          onClick={() => onEditPrompt?.(msg.content)}
          title="Edit and ask again"
        >
          <Pencil className="size-3.5" />
        </Button>
        <div className="rounded-2xl rounded-br-sm border border-indigo-500/30 bg-gradient-to-br from-indigo-950/70 to-slate-900/90 px-4 py-3 text-slate-100 text-sm shadow-lg shadow-black/30 backdrop-blur-md max-w-2xl leading-relaxed">
          {msg.content}
        </div>
      </div>
    );
  }

  const isInitialWait = msg.status === "streaming" && !msg.content && !msg.thinking;

  return (
    <div className="flex gap-3 my-4 pr-4 sm:pr-12">
      <div className="size-8 rounded-xl bg-gradient-to-tr from-indigo-600 to-indigo-500 border border-indigo-400/30 flex items-center justify-center shrink-0 shadow-md shadow-indigo-600/20 text-white">
        <Bot className="size-4" />
      </div>

      <Card className="flex-1 rounded-2xl border-slate-800/80 bg-slate-900/70 backdrop-blur-xl p-4 sm:p-5 shadow-xl shadow-black/40 text-slate-200 overflow-hidden">
        {msg.thinking && (
          <ThinkingBlock
            thinking={msg.thinking}
            isStreaming={msg.status === "streaming" && !msg.content}
          />
        )}

        {isInitialWait && (
          <div className="flex items-center gap-2.5 py-1 text-sm text-slate-400">
            <Sparkles className="size-4 text-indigo-400 animate-spin" />
            <span className="text-xs sm:text-sm text-slate-300">
              Reviewing document and formulating response…
            </span>
          </div>
        )}

        {msg.content && <AnswerText text={msg.content} />}

        {msg.status === "paused" && (
          <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-200">
            <div className="flex items-center gap-2">
              <Badge variant="destructive" className="bg-amber-500/20 text-amber-300 border-amber-500/40 gap-1 px-2 py-0.5">
                <Square className="size-2.5 fill-current" />
                Stopped
              </Badge>
              <span>Generation stopped. Want to revise what you asked?</span>
            </div>
            {(msg.prompt || lastQuestion) && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-xs border-amber-500/40 text-amber-200 hover:bg-amber-500/20"
                onClick={() => onEditPrompt?.(msg.prompt || lastQuestion)}
              >
                <Pencil className="size-3 mr-1" /> Edit question
              </Button>
            )}
          </div>
        )}

        {msg.status === "error" && (
          <div className="mt-3.5 flex items-start gap-2.5 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3.5 text-xs text-rose-300">
            <AlertCircle className="size-4 text-rose-400 shrink-0 mt-0.5" />
            <div className="leading-relaxed">
              <span className="font-semibold text-rose-200">
                {msg.content ? "Answer interrupted: " : "Generation failed: "}
              </span>
              <span>{msg.error}</span>
            </div>
          </div>
        )}

        {msg.status === "done" && msg.sources && msg.sources.length > 0 && (
          <div className="mt-4 pt-3.5 border-t border-slate-800/80 flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 text-xs font-medium text-slate-400">
              <Layers className="size-3.5 text-indigo-400" />
              Sources:
            </span>
            {msg.sources.map((page) => (
              <Badge
                key={page}
                variant={msg.unitLabel === "Slide" ? "cyan" : "indigo"}
                className="text-[11px] font-semibold tracking-wide px-2.5 py-0.5 rounded-md"
              >
                {msg.unitLabel || "Page"} {page}
              </Badge>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

export default function App() {
  const [mode, setMode] = useState("chat");
  const [indexed, setIndexed] = useState(null);
  const [upload, setUpload] = useState({ status: "idle", name: "", error: "" });
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  const busyRef = useRef(false);
  const abortRef = useRef(null);
  const lastQuestionRef = useRef("");
  const activeBotIdRef = useRef(null);
  const fileRef = useRef(null);
  const inputRef = useRef(null);
  const scrollRef = useRef(null);
  const stickRef = useRef(true);

  const uploading = upload.status === "uploading";
  const canChat = Boolean(indexed) && !uploading;

  const isPpt = Boolean(
    indexed?.kind === "pptx" ||
      indexed?.unit_label === "Slide" ||
      /\.(pptx|ppt)$/i.test(indexed?.filename || "")
  );
  const unitLabel = isPpt ? "Slide" : "Page";
  const unitSingle = isPpt ? "slide" : "page";
  const unitPlural = isPpt ? "slides" : "pages";

  // Pick up previously indexed document on mount
  useEffect(() => {
    let cancelled = false;
    getIndexedDocument().then((doc) => {
      if (!cancelled && doc) {
        setIndexed((cur) =>
          cur ?? {
            filename: doc.filename,
            pages: doc.pages,
            kind: doc.kind,
            unit_label: doc.unit_label,
          }
        );
      }
    });
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, []);

  // Smooth auto-scroll following new messages
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) {
      el.scrollTo({
        top: el.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [messages]);

  // Dynamic textarea expansion
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [input]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  }

  function isSupportedFile(file) {
    return (
      /\.(pdf|pptx|ppt)$/i.test(file?.name || "") ||
      file?.type === "application/pdf" ||
      file?.type === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
      file?.type === "application/vnd.ms-powerpoint"
    );
  }

  async function handleFile(file) {
    if (!file || uploading || busyRef.current) return;
    if (!isSupportedFile(file)) {
      setUpload({
        status: "error",
        name: file.name,
        error: "Please choose a valid PDF or PowerPoint presentation (.pptx).",
      });
      return;
    }
    setUpload({ status: "uploading", name: file.name, error: "" });
    try {
      const doc = await uploadDocument(file);
      setIndexed({
        filename: doc.filename,
        pages: doc.pages ?? doc.units,
        kind: doc.kind,
        unit_label: doc.unit_label,
      });
      setMessages([]);
      setUpload({ status: "idle", name: "", error: "" });
      inputRef.current?.focus();
    } catch (err) {
      setUpload({ status: "error", name: file.name, error: err.message });
    }
  }

  function onFileChange(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) handleFile(file);
  }

  function handleStop() {
    abortRef.current?.abort();
    if (activeBotIdRef.current) {
      setMessages((m) =>
        m.map((x) =>
          x.id === activeBotIdRef.current && x.status === "streaming"
            ? { ...x, status: "paused" }
            : x
        )
      );
    }
    busyRef.current = false;
    setBusy(false);

    if (lastQuestionRef.current) {
      handleEditPrompt(lastQuestionRef.current);
    }
  }

  function handleEditPrompt(promptText) {
    if (!promptText) return;
    setInput(promptText);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  async function send() {
    const question = input.trim();
    if (!question || !canChat || busyRef.current) return;

    lastQuestionRef.current = question;
    busyRef.current = true;
    setBusy(true);
    setInput("");
    stickRef.current = true;

    const botId = uid();
    activeBotIdRef.current = botId;

    setMessages((m) => [
      ...m,
      { id: uid(), role: "user", content: question },
      {
        id: botId,
        role: "assistant",
        prompt: question,
        content: "",
        thinking: "",
        sources: [],
        unitLabel,
        status: "streaming",
      },
    ]);

    const patch = (fn) => setMessages((m) => m.map((x) => (x.id === botId ? fn(x) : x)));

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await streamChat(question, {
        signal: ctrl.signal,
        onSources: (sources) => patch((x) => ({ ...x, sources })),
        onThinking: (chunk) => patch((x) => ({ ...x, thinking: (x.thinking || "") + chunk })),
        onToken: (text) => patch((x) => ({ ...x, content: (x.content || "") + text })),
      });
      patch((x) => ({ ...x, status: "done" }));
    } catch (err) {
      if (err.name === "AbortError") {
        patch((x) => ({ ...x, status: "paused" }));
      } else {
        patch((x) => ({ ...x, status: "error", error: err.message }));
      }
    } finally {
      abortRef.current = null;
      busyRef.current = false;
      setBusy(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }

  const latestAssistantId = [...messages].reverse().find((m) => m.role === "assistant")?.id;

  return (
    <div className="midnight-canvas flex flex-col h-screen overflow-hidden selection:bg-indigo-500/30 selection:text-white">
      {/* Sleek Minimalist Midnight Header */}
      <header className="h-16 border-b border-slate-800/80 bg-slate-950/70 backdrop-blur-xl px-4 sm:px-6 flex items-center justify-between shrink-0 z-20">
        <div className="flex items-center gap-3">
          <div className="size-9 rounded-xl bg-gradient-to-tr from-indigo-600 to-indigo-500 border border-indigo-400/30 flex items-center justify-center text-white shadow-lg shadow-indigo-600/30">
            <Sparkles className="size-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm sm:text-base font-semibold tracking-tight text-slate-100">
                Indexio
              </h1>
              <Badge variant="outline" className="text-[10px] py-0 px-1.5 border-indigo-500/30 text-indigo-300 bg-indigo-500/10">
                RAG
              </Badge>
            </div>
            <p className="text-xs text-slate-400 font-normal hidden sm:block">
              {mode === "study" ? "Flashcards & memory study mode" : "Grounded conversational intelligence"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 sm:gap-4">
          <Tabs value={mode} onValueChange={setMode}>
            <TabsList className="h-9 p-1 bg-slate-900/90 border-slate-800/80">
              <TabsTrigger value="chat" className="gap-1.5 text-xs py-1">
                <MessageSquare className="size-3.5" />
                <span>Chat</span>
              </TabsTrigger>
              <TabsTrigger value="study" className="gap-1.5 text-xs py-1">
                <BookOpen className="size-3.5" />
                <span>Study</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </header>

      {/* Main View Area */}
      {mode === "study" ? (
        <main className="flex-1 overflow-y-auto">
          <StudyMode />
        </main>
      ) : (
        <main
          className="flex-1 overflow-y-auto px-4 sm:px-6 md:px-8 py-6 max-w-4xl w-full mx-auto"
          ref={scrollRef}
          onScroll={onScroll}
        >
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center min-h-[60vh] text-center max-w-lg mx-auto py-12">
              <div className="size-16 rounded-3xl bg-slate-900/80 border border-slate-800 shadow-2xl shadow-indigo-500/10 flex items-center justify-center mb-6 text-indigo-400 backdrop-blur-md">
                <FileText className="size-8" />
              </div>
              <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-100 mb-2">
                Welcome to Indexio
              </h2>
              <p className="text-sm text-slate-400 leading-relaxed mb-8">
                {indexed
                  ? `Ready to discuss "${indexed.filename}". Ask questions, request executive summaries, or inspect key citations.`
                  : "Upload a PDF or PowerPoint deck below to extract answers, explore excerpts, and chat directly with your document."}
              </p>

              {indexed ? (
                <div className="w-full flex flex-col sm:flex-row flex-wrap items-center justify-center gap-2.5">
                  {SUGGESTED_PROMPTS.map(({ label, text }) => (
                    <Button
                      key={label}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="rounded-xl border-slate-800 bg-slate-900/60 hover:bg-slate-800/80 hover:border-indigo-500/40 hover:text-indigo-200 text-xs py-2 px-3.5 transition-all duration-200"
                      onClick={() => handleEditPrompt(text)}
                    >
                      <Sparkles className="size-3 text-indigo-400 mr-1" />
                      "{label}"
                    </Button>
                  ))}
                </div>
              ) : (
                <div>
                  <Button
                    type="button"
                    variant="midnight"
                    size="lg"
                    className="gap-2 text-sm shadow-xl"
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading}
                  >
                    <Paperclip className="size-4" />
                    <span>Choose a document (PDF or PPTX)</span>
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4 pb-4">
              {messages.map((m) => (
                <Message
                  key={m.id}
                  msg={m}
                  onStop={handleStop}
                  onEditPrompt={handleEditPrompt}
                  isBusy={busy}
                  isLatestAssistant={m.id === latestAssistantId}
                  lastQuestion={lastQuestionRef.current}
                />
              ))}
            </div>
          )}
        </main>
      )}

      {/* Floating Bottom Composer (Chat Mode Only) */}
      {mode === "chat" && (
        <footer className="p-4 sm:p-6 pt-0 max-w-4xl w-full mx-auto z-20">
          <Card className="border-slate-800/90 bg-slate-950/85 backdrop-blur-2xl shadow-2xl shadow-black/80 p-3 sm:p-4 rounded-2xl relative">
            {/* Document attachment status banner */}
            {(indexed || uploading || upload.status === "error") && (
              <div className="mb-2.5 pb-2.5 border-b border-slate-800/60 flex items-center justify-between text-xs">
                {uploading ? (
                  <div className="flex items-center gap-2 text-indigo-300">
                    <Loader2 className="size-3.5 animate-spin text-indigo-400" />
                    <span>Indexing "{upload.name}"…</span>
                  </div>
                ) : upload.status === "error" ? (
                  <div className="flex items-center justify-between w-full text-rose-300 gap-2">
                    <div className="flex items-center gap-1.5 truncate">
                      <AlertCircle className="size-3.5 text-rose-400 shrink-0" />
                      <span className="truncate">{upload.error}</span>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 text-xs text-rose-300 hover:text-white hover:bg-rose-500/20 px-2"
                      onClick={() => fileRef.current?.click()}
                    >
                      <RotateCcw className="size-3 mr-1" /> Retry
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between w-full text-slate-300">
                    <div className="flex items-center gap-2 truncate">
                      <Badge variant={isPpt ? "cyan" : "indigo"} className="text-[10px] px-1.5 py-0 font-bold">
                        {isPpt ? "PPTX" : "PDF"}
                      </Badge>
                      <span className="font-medium truncate max-w-[240px] sm:max-w-md text-slate-200" title={indexed.filename}>
                        {indexed.filename}
                      </span>
                      <span className="text-slate-500 hidden sm:inline">
                        ({indexed.pages} {indexed.pages === 1 ? unitSingle : unitPlural})
                      </span>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 text-xs text-slate-400 hover:text-slate-100 hover:bg-slate-800/60 px-2"
                      onClick={() => fileRef.current?.click()}
                      disabled={uploading || busy}
                      title="Choose a different document to replace current index"
                    >
                      Replace
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Input Row */}
            <div className="flex items-end gap-2">
              <input
                ref={fileRef}
                type="file"
                accept=".pdf,.pptx,.ppt,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.ms-powerpoint"
                hidden
                onChange={onFileChange}
              />

              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  "size-9 rounded-xl text-slate-400 hover:text-slate-100 hover:bg-slate-800/60 shrink-0",
                  indexed && "text-indigo-400 hover:text-indigo-300"
                )}
                disabled={uploading || busy}
                onClick={() => fileRef.current?.click()}
                title={indexed ? "Replace document" : "Attach document"}
                aria-label={indexed ? "Replace document" : "Attach document"}
              >
                <Paperclip className="size-4" />
              </Button>

              <Textarea
                ref={inputRef}
                rows={1}
                value={input}
                maxLength={MAX_QUESTION}
                disabled={!canChat}
                placeholder={
                  canChat
                    ? busy
                      ? "Generating response... Click ■ to stop"
                      : `Ask a question about your ${isPpt ? "presentation" : "document"}...`
                    : "Attach a PDF or PowerPoint deck above to start chatting..."
                }
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                className="py-2.5 px-3 min-h-[40px] border-slate-800/80 bg-slate-900/70 text-slate-100 text-sm focus-visible:ring-indigo-500/40"
              />

              {busy ? (
                <Button
                  type="button"
                  variant="destructive"
                  size="icon"
                  className="size-9 rounded-xl shrink-0"
                  onClick={handleStop}
                  title="Stop generating"
                  aria-label="Stop generating"
                >
                  <Square className="size-3.5 fill-current" />
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="midnight"
                  size="icon"
                  className="size-9 rounded-xl shrink-0"
                  disabled={!canChat || !input.trim()}
                  onClick={send}
                  title="Send message"
                  aria-label="Send message"
                >
                  <Send className="size-4" />
                </Button>
              )}
            </div>
          </Card>
        </footer>
      )}
    </div>
  );
}
