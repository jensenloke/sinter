/**
 * Terminal key decoding. Pure: bytes in, keys out — the impure raw-mode
 * plumbing lives in menu.ts so this stays testable.
 *
 * One stdin chunk can carry several keypresses (paste, key repeat, a held
 * arrow), so this always returns an array.
 */

export type KeyType =
  | "up"
  | "down"
  | "left"
  | "right"
  | "enter"
  | "esc"
  | "backspace"
  | "delete"
  | "tab"
  | "shift-tab"
  | "pgup"
  | "pgdn"
  | "home"
  | "end"
  | "ctrl-c"
  | "ctrl-d"
  | "ctrl-u"
  | "ctrl-w"
  | "char";

export interface Key {
  type: KeyType;
  /** Only set for `char`. */
  value?: string;
}

/** CSI/SS3 final byte (or `<n>~` code) → key. */
const CSI: Record<string, KeyType> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  Z: "shift-tab",
  "1~": "home",
  "3~": "delete",
  "4~": "end",
  "5~": "pgup",
  "6~": "pgdn",
  "7~": "home",
  "8~": "end",
};

const CTRL: Record<string, KeyType> = {
  "\x03": "ctrl-c",
  "\x04": "ctrl-d",
  "\x09": "tab",
  "\x0d": "enter",
  "\x0a": "enter",
  "\x15": "ctrl-u",
  "\x17": "ctrl-w",
  "\x7f": "backspace",
  "\x08": "backspace",
};

export function parseKeys(input: string): Key[] {
  const out: Key[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i]!;

    if (ch === "\x1b") {
      const next = input[i + 1];

      // CSI: ESC [ <params> <intermediates> <final>   ·   SS3: ESC O <final>
      //
      // Parameter bytes are 0x30-0x3F — which includes `<`, `=`, `>` and `?`,
      // the private-use prefixes. SGR mouse reports (ESC [ < 0;12;5 M) live
      // there, and a scan that only accepts digits would spill their tail into
      // the filter box.
      if (next === "[" || next === "O") {
        let j = i + 2;
        while (j < input.length && input[j]! >= "\x30" && input[j]! <= "\x3f") j++;
        while (j < input.length && input[j]! >= "\x20" && input[j]! <= "\x2f") j++;
        const final = input[j];
        if (final !== undefined) {
          const params = input.slice(i + 2, j);
          const key = CSI[final] ?? CSI[`${params}${final}`];
          if (key) out.push({ type: key });
          // Unrecognised sequences (mouse, focus, bracketed paste) are dropped
          // rather than leaking their bytes into the filter box.
          i = j + 1;
          continue;
        }
      }

      // A bare ESC, or ESC+char (alt-modified) we do not bind.
      out.push({ type: "esc" });
      i += next === undefined ? 1 : 2;
      continue;
    }

    const ctrl = CTRL[ch];
    if (ctrl) {
      out.push({ type: ctrl });
      i++;
      continue;
    }

    // Printable (incl. non-ASCII); other C0 controls are ignored.
    if (ch >= " ") out.push({ type: "char", value: ch });
    i++;
  }

  return out;
}
