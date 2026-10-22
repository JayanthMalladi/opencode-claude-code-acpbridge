// History fingerprinting: how the provider decides what the ACP agent already knows.
//
// OpenCode resends the FULL prompt on every doStream; the ACP session is stateful and
// sequential. Each non-system message gets a cheap key; comparing the keys already
// sent with the incoming ones tells a normal append from a revert or a divergence.
// This logic has broken before (CHANGELOG 0.8.0, 9299af9): change it only together
// with the fixtures in test/fixtures/v2, which are real OpenCode V2 prompts.
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";

type Prompt = LanguageModelV3CallOptions["prompt"];

export type HistoryKind = "append" | "revert" | "diverged";

export function hashText(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

/** Text of the first user message — stable identifier for the conversation. Tags other
 *  plugins inject (DCP) are not part of it: they come and go between requests. */
export function firstUserText(prompt: Prompt): string {
  for (const m of prompt) {
    if (m.role !== "user") continue;
    if (typeof (m as any).content === "string") return stripInjected((m as any).content).trim();
    return stripInjected(((m as any).content as any[]).filter((p) => p.type === "text").map((p) => p.text).join("")).trim();
  }
  return "";
}

/** The conversation proper: system messages are excluded because they're forwarded
 *  separately (or not at all) and OpenCode rewrites them every turn — including them
 *  would make every history comparison look like a divergence. */
export function historyOf(prompt: Prompt): any[] {
  return (prompt as any[]).filter((m) => m.role !== "system");
}

/** Cheap, stable per-message identity. Deliberately keyed on tool-call IDs rather
 *  than payloads: it must survive re-serialization but change if the turn changes. */
export function msgKey(msg: any): string {
  let body = "";
  if (typeof msg.content === "string") body = msg.content;
  else if (Array.isArray(msg.content)) {
    for (const p of msg.content) {
      if (p?.type === "text") body += `t:${p.text}`;
      else if (p?.type === "tool-call") body += `c:${p.toolCallId}`;
      else if (p?.type === "tool-result") body += `r:${p.toolCallId}`;
      else if (p?.type === "file") body += `f:${p.filename ?? p.mediaType ?? ""}`;
      else body += `?${p?.type}`;
    }
  }
  return `${msg.role}:${hashText(body)}`;
}

/** How the incoming history relates to what the agent already knows.
 *   - append   → normal turn (or another agent ran turns meanwhile): send the tail.
 *   - revert   → the user rewound: the agent can't unremember, so it needs a new session.
 *   - diverged → compaction/rollback replaced the middle: same, a new session. */
export function classifyHistory(sent: readonly string[], keys: readonly string[]): { kind: HistoryKind; fromIndex: number } {
  let i = 0;
  while (i < sent.length && i < keys.length && sent[i] === keys[i]) i++;
  if (i === sent.length) return { kind: "append", fromIndex: i };
  // Prefijo estricto = revert SOLO si incoming es más corto; si son iguales no hay
  // mensajes nuevos → append desde el final (evita falsos revert).
  if (i === keys.length) return keys.length < sent.length
    ? { kind: "revert", fromIndex: i }
    : { kind: "append", fromIndex: keys.length };
  return { kind: "diverged", fromIndex: i };
}

export function systemText(prompt: Prompt): string {
  const parts: string[] = [];
  for (const m of prompt) {
    if (m.role !== "system") continue;
    parts.push(
      typeof (m as any).content === "string"
        ? (m as any).content
        : ((m as any).content as any[]).filter((p) => p.type === "text").map((p) => p.text).join(""),
    );
  }
  return parts.join("\n").trim();
}

// ---- anchor fingerprint (historyMode "shadow" | "v2") -----------------------------
//
// The legacy key hashes every part of every message. OpenCode V2 re-renders OLD
// assistant messages in ways that don't change the conversation — reasoning dropped or
// turned into text after a model switch or an error, providerOptions stripped — and other
// plugins tag message text (DCP). Each of those looked like a divergence → new session +
// cold replay. Anchors keep only what identifies the conversation: what the USER wrote
// and the ids of every tool round-trip. Assistant prose is left out; whether the agent
// already has it is decided separately (own-output detection).

/** Tags other plugins inject into message text (DCP's ids and nudges). */
const INJECTED_TAGS = /<(dcp-[a-z-]+)\b[^>]*>[\s\S]*?<\/\1>/g;
/** What V2 puts in place of an old image once the request exceeds its media budget. */
const IMAGE_REMOVED = /^\[This image was removed to reduce the request size[^\]]*\]$/;

export function stripInjected(text: string): string {
  return text.replace(INJECTED_TAGS, "");
}

/** A user message that only carries a `<system-reminder>`: V2's plan plugin inserts one
 *  for a single request and persists a copy that lands later — it moves around, so it
 *  can't be part of the identity of the history. */
export function isTransient(msg: any): boolean {
  if (msg?.role !== "user") return false;
  const parts = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content ?? [];
  const text = parts.filter((p: any) => p?.type === "text").map((p: any) => String(p.text ?? "")).join("").trim();
  return parts.every((p: any) => p?.type === "text") && /^<system-reminder>[\s\S]*<\/system-reminder>$/.test(text);
}

/** Normalized text of a user message (injected tags and V2's media placeholders out). */
export function userText(msg: any): string {
  const parts = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content ?? [];
  return parts
    .filter((p: any) => p?.type === "text")
    .map((p: any) => stripInjected(String(p.text ?? "")).trim())
    .filter((t: string) => t && !IMAGE_REMOVED.test(t))
    .join("\n");
}

export interface Anchor {
  key: string;
  /** Index, in the non-system history, of the message the anchor comes from. */
  at: number;
}

export function anchorsOf(hist: readonly any[]): Anchor[] {
  const out: Anchor[] = [];
  hist.forEach((m, at) => {
    if (m.role === "user") {
      if (!isTransient(m)) out.push({ key: `u:${hashText(userText(m))}`, at });
      return;
    }
    if (!Array.isArray(m.content)) return;
    for (const p of m.content) {
      if (p?.type === "tool-call") out.push({ key: `c:${p.toolCallId}`, at });
      else if (p?.type === "tool-result") out.push({ key: `r:${p.toolCallId}`, at });
    }
  });
  return out;
}

/** `classifyHistory` over anchors. `fromIndex` is a MESSAGE index: the tail starts after
 *  the message of the last anchor already known. */
export function classifyAnchors(sent: readonly string[], incoming: readonly Anchor[]): { kind: HistoryKind; fromIndex: number } {
  let i = 0;
  while (i < sent.length && i < incoming.length && sent[i] === incoming[i].key) i++;
  const after = i > 0 ? incoming[i - 1].at + 1 : 0;
  if (i === sent.length) return { kind: "append", fromIndex: after };
  if (i === incoming.length) return incoming.length < sent.length
    ? { kind: "revert", fromIndex: after }
    : { kind: "append", fromIndex: after };
  return { kind: "diverged", fromIndex: after };
}
