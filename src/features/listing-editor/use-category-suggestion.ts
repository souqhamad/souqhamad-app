import { useEffect, useLayoutEffect, useState } from "react";
import { api } from "../../core/api";
import type { Category } from "../../core/types";

type Suggestion = { category: string; categoryOption: string; carModel: string };
type Scope = { ownerId: string; title: string };
type Feedback = Scope & { status: "idle" | "pending" | "suggested" };
type Input = Scope & { enabled: boolean; categories: readonly Category[] };
type RequestSuggestion = (title: string, signal: AbortSignal) => Promise<unknown>;
const emptyCategories: readonly Category[] = [];

function validatedSuggestion(value: unknown, categories: readonly Category[]): Suggestion | null {
  if (!value || typeof value !== "object" || !("status" in value) || value.status !== "suggested" || !("category" in value)) return null;
  const category = categories.find(item => item.id === value.category);
  if (!category) return null;
  const optionId = "categoryOption" in value ? value.categoryOption : undefined;
  const categoryOption = category.options.find(item => item.id === optionId)?.id || "";
  const modelId = "carModel" in value ? value.carModel : undefined;
  const carModel = category.id === "cars" && categoryOption
    ? category.carModels?.[categoryOption]?.find(item => item.id === modelId)?.id || ""
    : "";
  return { category: category.id, categoryOption, carModel };
}

// The same session drives the hook and the race tests. A cancelled request is
// ignored even when a transport/provider still resolves after its abort signal.
export function createCategorySuggestionSession({ request, onSuggestion, onFeedback }: {
  request: RequestSuggestion;
  onSuggestion: (suggestion: Suggestion, scope: Scope) => void;
  onFeedback: (feedback: Feedback) => void;
}) {
  let sequence = 0;
  let locked = false;
  let applySuggestion = onSuggestion;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const cancel = () => {
    sequence += 1;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    controller?.abort();
    controller = undefined;
  };
  return {
    cancel,
    setOnSuggestion(callback: typeof onSuggestion) { applySuggestion = callback; },
    lock() { locked = true; cancel(); },
    update(input: Input) {
      cancel();
      const title = input.title.trim();
      if (locked || !input.enabled || !input.ownerId || title.length < 2 || !input.categories.length) return;
      const scope = { ownerId: input.ownerId, title };
      const attempt = sequence;
      const abort = new AbortController();
      controller = abort;
      const current = () => attempt === sequence && !locked && !abort.signal.aborted;
      timer = setTimeout(async () => {
        timer = undefined;
        if (!current()) return;
        onFeedback({ ...scope, status: "pending" });
        try {
          const response = await request(title, abort.signal);
          if (!current()) return;
          const suggestion = validatedSuggestion(response, input.categories);
          if (suggestion) applySuggestion(suggestion, scope);
          onFeedback({ ...scope, status: suggestion ? "suggested" : "idle" });
        } catch {
          if (current()) onFeedback({ ...scope, status: "idle" });
        }
      }, 600);
    },
  };
}

export function useCategorySuggestion({ ownerId, title, enabled, categories, onSuggestion }: {
  ownerId: string;
  title: string;
  enabled: boolean;
  categories?: readonly Category[];
  onSuggestion: (suggestion: Suggestion, scope: Scope) => void;
}) {
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [manual, setManual] = useState(false);
  const [session] = useState(() => createCategorySuggestionSession({
    request: (suggestionTitle, signal) => api.post("/api/marketplace/listing-category", { title: suggestionTitle }, { signal }),
    onSuggestion,
    onFeedback: setFeedback,
  }));
  useEffect(() => { session.setOnSuggestion(onSuggestion); }, [session, onSuggestion]);
  const catalog = categories ?? emptyCategories;
  useLayoutEffect(() => {
    session.update({ ownerId, title, enabled, categories: catalog });
    return session.cancel;
  }, [session, ownerId, title, enabled, catalog]);
  return {
    status: enabled && !manual && feedback?.ownerId === ownerId && feedback.title === title.trim()
      ? feedback.status
      : "idle",
    lockManualSelection() { session.lock(); setManual(true); },
    cancel: session.cancel,
  };
}
