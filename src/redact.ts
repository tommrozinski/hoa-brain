// Privacy minimization before anything is embedded or stored.
// Built-in patterns catch common identifiers; redaction-terms.txt (one name/address/unit per line, gitignored)
// catches the things only you know. This is a safety net, not a guarantee: review samples at ingest time.
const PATTERNS: [string, RegExp, string][] = [
  ["email", /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]"],
  ["ssn", /\b\d{3}-\d{2}-\d{4}\b/g, "[SSN]"],
  ["phone", /(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/g, "[PHONE]"],
  ["long-number", /\b\d{9,17}\b/g, "[NUMBER]"], // account / routing / card-like numbers
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface RedactResult {
  text: string;
  counts: Record<string, number>;
}

export function redact(input: string, terms: string[] = []): RedactResult {
  let text = input;
  const counts: Record<string, number> = {};
  for (const [name, re, label] of PATTERNS) {
    text = text.replace(re, () => {
      counts[name] = (counts[name] ?? 0) + 1;
      return label;
    });
  }
  for (const t of terms.map((x) => x.trim()).filter((x) => x.length >= 3)) {
    const re = new RegExp(`\\b${esc(t)}\\b`, "gi");
    text = text.replace(re, () => {
      counts["term"] = (counts["term"] ?? 0) + 1;
      return "[REDACTED]";
    });
  }
  return { text, counts };
}
