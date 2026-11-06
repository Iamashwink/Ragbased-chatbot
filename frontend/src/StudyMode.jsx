import { useEffect, useRef, useState } from "react";
import {
  Layers,
  FileUp,
  Sparkles,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  AlertCircle,
  HelpCircle,
  CheckCircle2,
  BookOpen,
  Loader2,
} from "lucide-react";
import { generateFlashcards } from "./api.js";
import { Button } from "./components/ui/button.jsx";
import { Card } from "./components/ui/card.jsx";
import { Badge } from "./components/ui/badge.jsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.jsx";
import { cn } from "./lib/utils.js";

const COUNTS = [3, 5, 8, 12, 15];

function isStudyFile(file) {
  return (
    /\.(pdf|pptx|ppt)$/i.test(file?.name || "") ||
    file?.type === "application/pdf" ||
    file?.type === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    file?.type === "application/vnd.ms-powerpoint"
  );
}

export default function StudyMode() {
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [count, setCount] = useState(8);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [deck, setDeck] = useState(null);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const card = deck?.cards?.[index];
  const loading = status === "loading";

  function chooseFile(next) {
    if (!next) return;
    if (!isStudyFile(next)) {
      setFile(null);
      setDeck(null);
      setStatus("error");
      setError("Please choose a valid PDF or PowerPoint presentation (.pptx).");
      return;
    }
    setFile(next);
    setDeck(null);
    setError("");
    setStatus("idle");
    setIndex(0);
    setFlipped(false);
  }

  function onFileChange(e) {
    const next = e.target.files?.[0];
    e.target.value = "";
    if (next) chooseFile(next);
  }

  function go(step) {
    if (!deck?.cards?.length) return;
    setIndex((i) => (i + step + deck.cards.length) % deck.cards.length);
    setFlipped(false);
  }

  async function generate() {
    if (!file || loading) return;
    setStatus("loading");
    setError("");
    setFlipped(false);
    try {
      const result = await generateFlashcards(file, count);
      if (!result?.cards?.length) {
        throw new Error("No flashcards could be generated. Try a document with more text passages.");
      }
      setDeck(result);
      setIndex(0);
      setStatus("ready");
    } catch (err) {
      setDeck(null);
      setStatus("error");
      setError(err.message);
    }
  }

  useEffect(() => {
    if (status !== "ready" || !deck?.cards?.length) return;
    function onKey(e) {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (tag === "BUTTON" && (e.key === " " || e.key === "Enter")) return;
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        setFlipped((open) => !open);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(-1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status, deck]);

  const isPptx = Boolean(file && /\.(pptx|ppt)$/i.test(file.name));

  return (
    <div
      className={cn(
        "max-w-4xl w-full mx-auto px-4 sm:px-6 md:px-8 py-8 flex flex-col items-center transition-all duration-200",
        dragOver && "opacity-90"
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        chooseFile(e.dataTransfer.files?.[0]);
      }}
    >
      {/* Intro Header */}
      <div className="text-center max-w-lg mb-8">
        <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-100 mb-2">
          Study Mode
        </h2>
        <p className="text-sm text-slate-400 leading-relaxed">
          Upload any PDF or PowerPoint deck to instantly generate AI study flashcards grounded directly in the document.
        </p>
      </div>

      {/* Control Toolbar */}
      <Card className="w-full max-w-2xl p-4 sm:p-5 rounded-2xl border-slate-800/90 bg-slate-900/60 backdrop-blur-xl mb-6 shadow-xl shadow-black/30 relative z-30">
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.pptx,.ppt,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.ms-powerpoint"
          hidden
          onChange={onFileChange}
        />

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 flex-1 min-w-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-2 shrink-0 border-slate-700/80 hover:border-slate-600 hover:text-white"
              onClick={() => fileRef.current?.click()}
              disabled={loading}
            >
              <FileUp className="size-4 text-indigo-400" />
              <span>{file ? "Change file" : "Upload file"}</span>
            </Button>

            {file && (
              <div className="flex items-center gap-2 truncate px-2.5 py-1 rounded-xl bg-slate-800/50 border border-slate-700/50 text-xs">
                <Badge variant={isPptx ? "cyan" : "indigo"} className="text-[10px] px-1.5 py-0 font-bold shrink-0">
                  {isPptx ? "PPTX" : "PDF"}
                </Badge>
                <span className="truncate text-slate-200 font-medium max-w-[180px] sm:max-w-[240px]" title={file.name}>
                  {file.name}
                </span>
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-3 shrink-0">
            <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
              <span>Deck size:</span>
              <Select
                value={count}
                disabled={loading}
                onValueChange={(val) => setCount(Number(val))}
              >
                <SelectTrigger className="w-28 h-8 text-xs border-slate-700/80 bg-slate-900/90 text-slate-200 hover:border-slate-600 hover:bg-slate-800/80">
                  <SelectValue placeholder="Deck size" />
                </SelectTrigger>
                <SelectContent align="right">
                  {COUNTS.map((n) => (
                    <SelectItem key={n} value={n}>
                      {n} cards
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Button
              type="button"
              variant="midnight"
              size="sm"
              className="gap-1.5 shadow-md shrink-0"
              disabled={!file || loading}
              onClick={generate}
            >
              {loading ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  <span>Generating…</span>
                </>
              ) : deck ? (
                <>
                  <RotateCcw className="size-3.5" />
                  <span>Regenerate</span>
                </>
              ) : (
                <>
                  <Sparkles className="size-3.5" />
                  <span>Generate</span>
                </>
              )}
            </Button>
          </div>
        </div>
      </Card>

      {/* Loading Status Indicator */}
      {loading && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-2xl border border-indigo-500/30 bg-indigo-500/10 text-indigo-300 text-sm mb-6 animate-pulse">
          <Loader2 className="size-4 animate-spin text-indigo-400" />
          <span>Analyzing key concepts, definitions, and formatting flashcards…</span>
        </div>
      )}

      {/* Error Alert */}
      {status === "error" && error && (
        <div className="w-full max-w-2xl flex items-start gap-3 p-4 rounded-2xl border border-rose-500/30 bg-rose-500/10 text-rose-300 text-sm mb-6">
          <AlertCircle className="size-5 text-rose-400 shrink-0 mt-0.5" />
          <div className="leading-relaxed">
            <span className="font-semibold text-rose-200">Generation error: </span>
            <span>{error}</span>
          </div>
        </div>
      )}

      {/* Drag & Drop Prompt when no file is selected */}
      {!file && !loading && (
        <button
          type="button"
          className={cn(
            "w-full max-w-2xl border-2 border-dashed rounded-3xl p-12 text-center flex flex-col items-center justify-center transition-all duration-200 cursor-pointer group bg-slate-900/30 backdrop-blur-sm",
            dragOver
              ? "border-indigo-500 bg-indigo-500/10 scale-[1.01]"
              : "border-slate-800 hover:border-slate-700 hover:bg-slate-900/50"
          )}
          onClick={() => fileRef.current?.click()}
        >
          <div className="size-16 rounded-2xl bg-slate-800/80 border border-slate-700/60 flex items-center justify-center mb-4 text-indigo-400 group-hover:scale-110 group-hover:text-indigo-300 group-hover:border-indigo-500/40 transition-all duration-200 shadow-lg shadow-black/40">
            <Layers className="size-8" />
          </div>
          <h3 className="text-base font-semibold text-slate-200 mb-1 group-hover:text-white transition-colors">
            Drop a PDF or PowerPoint deck (.pptx) here
          </h3>
          <p className="text-xs text-slate-400">
            or click to browse from your computer
          </p>
        </button>
      )}

      {/* Active Deck & 3D Interactive Card */}
      {card && status === "ready" && (
        <div className="w-full max-w-2xl flex flex-col items-center relative z-10">
          {/* Deck Metadata Header */}
          <div className="w-full flex items-center justify-between text-xs text-slate-400 px-2 mb-3">
            <div className="flex items-center gap-2 truncate">
              <span className="font-medium text-slate-300 truncate max-w-[280px]" title={deck.filename}>
                {deck.filename}
              </span>
              {deck.units && (
                <span className="text-slate-500">
                  · {deck.units} {deck.unit_label === "Slide" ? "slides" : "pages"}
                </span>
              )}
            </div>
            <Badge variant="secondary" className="text-[11px] px-2 py-0.5 font-semibold">
              {deck.cards.length} cards in deck
            </Badge>
          </div>

          {/* 3D Flashcard Component */}
          <div className="w-full h-80 sm:h-96 perspective-1000 mb-6">
            <button
              type="button"
              className={cn(
                "w-full h-full text-left transition-transform duration-500 transform-style-preserve-3d relative rounded-3xl outline-none select-none cursor-pointer focus-visible:ring-2 focus-visible:ring-indigo-500",
                flipped && "rotate-y-180"
              )}
              onClick={() => setFlipped((open) => !open)}
              aria-label={flipped ? "Show question" : "Show answer"}
            >
              {/* Front Face: Question */}
              <div className="absolute inset-0 backface-hidden rounded-3xl border border-slate-800/90 bg-gradient-to-br from-slate-900/90 via-slate-950/90 to-slate-900/90 p-8 sm:p-10 flex flex-col justify-between shadow-2xl shadow-black/60 backdrop-blur-2xl hover:border-slate-700/80 transition-colors">
                <div className="flex items-center justify-between">
                  <Badge variant="indigo" className="gap-1 px-3 py-1 text-xs uppercase tracking-wider font-bold">
                    <HelpCircle className="size-3" /> Question
                  </Badge>
                  <span className="text-xs text-slate-500 font-medium">Card {index + 1} of {deck.cards.length}</span>
                </div>

                <div className="my-auto text-center py-4">
                  <h4 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-100 leading-snug">
                    {card.front}
                  </h4>
                </div>

                <div className="text-center text-xs text-slate-500 font-medium">
                  Click card or press <kbd className="px-1.5 py-0.5 rounded border border-slate-700 bg-slate-800 text-slate-300 text-[10px]">Space</kbd> to reveal answer
                </div>
              </div>

              {/* Back Face: Answer */}
              <div className="absolute inset-0 backface-hidden rotate-y-180 rounded-3xl border border-indigo-500/40 bg-gradient-to-br from-indigo-950/40 via-slate-950/95 to-slate-900/95 p-8 sm:p-10 flex flex-col justify-between shadow-2xl shadow-indigo-500/10 backdrop-blur-2xl">
                <div className="flex items-center justify-between">
                  <Badge variant="cyan" className="gap-1 px-3 py-1 text-xs uppercase tracking-wider font-bold">
                    <CheckCircle2 className="size-3" /> Answer
                  </Badge>
                  {card.source && (
                    <Badge variant="indigo" className="text-xs px-2.5 py-0.5">
                      {card.source}
                    </Badge>
                  )}
                </div>

                <div className="my-auto py-4 overflow-y-auto max-h-48">
                  <p className="text-base sm:text-lg font-medium text-slate-200 leading-relaxed text-center sm:text-left">
                    {card.back}
                  </p>
                </div>

                <div className="text-center text-xs text-slate-500 font-medium">
                  Click card or press <kbd className="px-1.5 py-0.5 rounded border border-slate-700 bg-slate-800 text-slate-300 text-[10px]">Space</kbd> to flip back
                </div>
              </div>
            </button>
          </div>

          {/* Navigation Controls Bar */}
          <div className="flex items-center gap-4">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5 px-4 rounded-xl border-slate-800 hover:border-slate-700 hover:bg-slate-800/80"
              onClick={() => go(-1)}
              disabled={deck.cards.length < 2}
            >
              <ChevronLeft className="size-4" />
              <span>Previous</span>
            </Button>

            <span className="text-xs font-semibold text-slate-400 bg-slate-900/80 border border-slate-800 px-3.5 py-1.5 rounded-xl">
              {index + 1} / {deck.cards.length}
            </span>

            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5 px-4 rounded-xl border-slate-800 hover:border-slate-700 hover:bg-slate-800/80"
              onClick={() => go(1)}
              disabled={deck.cards.length < 2}
            >
              <span>Next</span>
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
