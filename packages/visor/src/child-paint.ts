/** Repair native truncation resets only within a grouped child's painted cells.
 * Read colors from the native line (including default/ANSI/256/RGB colors), not
 * from a palette. Restore colors, never bold/inverse or other native attributes.
 */
export function continuousChildPaint(line: string): string {
  const tokens = line.match(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*?(?:\x07|\x1b\\))|[^\x1b]+|\x1b/g) ?? [];
  let lastText = -1;
  for (let i = 0; i < tokens.length; i++) if (!tokens[i].startsWith("\x1b")) lastText = i;
  let fg = "39", bg: string | undefined;
  let repaired = false;
  const result = tokens.map((token, index) => {
    const sgr = /^\x1b\[([\d;]*)m$/.exec(token);
    if (!sgr) return token;
    const params = (sgr[1] || "0").split(";").map((part) => Number(part || "0"));
    const pieces: string[] = [];
    let changed = false;
    for (let i = 0; i < params.length;) {
      const code = params[i];
      // Extended-color payloads may themselves contain 0/49: consume atomically.
      const size = (code === 38 || code === 48) && params[i + 1] === 5 ? 3
        : (code === 38 || code === 48) && params[i + 1] === 2 ? 5 : 1;
      const group = params.slice(i, i + size).join(";");
      pieces.push(`\x1b[${group}m`);
      if ((code === 0 || code === 49) && bg && index < lastText) {
        pieces.push(`\x1b[${bg}m\x1b[${fg}m`);
        changed = repaired = true;
      } else if (code === 0) { fg = "39"; bg = undefined; }
      else if (code === 49) bg = undefined;
      if (code === 38 || code === 39 || (code >= 30 && code <= 37) || (code >= 90 && code <= 97)) fg = group;
      if (code === 48 || (code >= 40 && code <= 47) || (code >= 100 && code <= 107)) bg = group;
      i += size;
    }
    return changed ? pieces.join("") : token;
  }).join("");
  // Restoration must never color the frame's following gutter or border.
  return repaired ? result + "\x1b[39;49m" : line;
}
