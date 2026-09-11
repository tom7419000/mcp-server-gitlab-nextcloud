// Nextcloud Deck's JSON payload shape has small variations across
// NC 28/29/30 (e.g. some fields renamed or nested differently), so every
// accessor here is defensive: unknown/missing fields degrade to `null`/`[]`
// instead of throwing.

type RawRecord = Record<string, unknown>;

function asRecord(value: unknown): RawRecord {
  return typeof value === "object" && value !== null ? (value as RawRecord) : {};
}

export function summarizeBoard(raw: unknown): RawRecord {
  const board = asRecord(raw);
  return {
    id: board.id,
    title: board.title,
    color: board.color,
    archived: Boolean(board.archived),
  };
}

export function summarizeStack(raw: unknown): RawRecord {
  const stack = asRecord(raw);
  const cards = Array.isArray(stack.cards) ? stack.cards : [];
  return {
    id: stack.id,
    title: stack.title,
    order: stack.order,
    cardCount: cards.length,
  };
}

function extractLabels(raw: unknown): RawRecord[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((entry) => {
    const label = asRecord(entry);
    return { title: label.title ?? null, color: label.color ?? null };
  });
}

function extractAssignedUsers(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((entry) => {
    const assignment = asRecord(entry);
    const participant = asRecord(assignment.participant);
    return participant.uid ?? assignment.participant ?? null;
  });
}

export function extractCardsFromStack(raw: unknown): unknown[] {
  const stack = asRecord(raw);
  return Array.isArray(stack.cards) ? stack.cards : [];
}

export function summarizeCard(raw: unknown, options: { includeDescription: boolean }): RawRecord {
  const card = asRecord(raw);
  return {
    id: card.id,
    title: card.title,
    description: options.includeDescription ? (card.description ?? null) : undefined,
    dueDate: card.duedate ?? card.dueDate ?? null,
    labels: extractLabels(card.labels),
    assignedUsers: extractAssignedUsers(card.assignedUsers),
    done: Boolean(card.done),
    archived: Boolean(card.archived),
  };
}
