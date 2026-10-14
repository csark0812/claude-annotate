// Where an element is written: the file and line Claude should open.
//
// The page reports what React knows. React 18 names the file and a line (_debugSource), which some
// transforms shift. React 19 only has a stack into the served code: Vite's transformed module, a
// webpack or Turbopack bundle. So, for each note:
//  1. A position in served code (react.at) is mapped back through that file's source map.
//  2. The line is checked against the file itself: the element's tag, id, test id, classes and
//     text are looked for near it, and the line moved to where the element is written.
// Both are best effort: a source that can't be confirmed is left as reported.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FETCH_MS = 3000;
const mapCache = new Map(); // script url -> Promise<{ map, base } | null>, for this batch's life

// ---------------------------------------------------------------------------
// Source maps
// ---------------------------------------------------------------------------
const B64 = Object.fromEntries([..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].map((c, i) => [c, i]));
function decodeVlq(segment) {
  const out = [];
  let value = 0, shift = 0;
  for (const c of segment) {
    const d = B64[c];
    if (d === undefined) return null;
    value += (d & 31) << shift;
    if (d & 32) { shift += 5; continue; }
    out.push(value & 1 ? -(value >>> 1) : value >>> 1);
    value = 0; shift = 0;
  }
  return out;
}

// The original position of a generated (line 1-based, column 1-based) in a plain map.
function lookup(map, line, col) {
  const lines = String(map.mappings || "").split(";");
  let src = 0, oLine = 0, oCol = 0;
  let best = null;
  for (let l = 0; l < lines.length && l < line; l++) {
    let gCol = 0;
    for (const seg of lines[l].split(",")) {
      if (!seg) continue;
      const v = decodeVlq(seg);
      if (!v) return null;
      gCol += v[0];
      if (v.length >= 4) { src += v[1]; oLine += v[2]; oCol += v[3]; }
      if (l === line - 1 && v.length >= 4 && gCol <= col - 1) best = { source: map.sources[src], line: oLine + 1, base: map.sourceRoot || "" };
    }
  }
  return best;
}
// An index map (Turbopack) is sections of plain maps, each at an offset.
function lookupAny(map, line, col) {
  if (!Array.isArray(map.sections)) return lookup(map, line, col);
  let hit = null;
  for (const sec of map.sections) {
    const o = sec.offset || { line: 0, column: 0 };
    if (o.line + 1 > line || (o.line + 1 === line && o.column + 1 > col)) break;
    hit = sec;
  }
  if (!hit || !hit.map) return null;
  const o = hit.offset;
  return lookupAny(hit.map, line - o.line, line - o.line === 1 ? col - o.column : col);
}

async function get(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}
function mapFor(scriptUrl) {
  if (!mapCache.has(scriptUrl)) {
    mapCache.set(scriptUrl, (async () => {
      const code = await get(scriptUrl);
      const m = /[#@] sourceMappingURL=(\S+)\s*$/.exec(code.slice(-200000));
      if (!m) return null;
      const ref = m[1];
      if (ref.startsWith("data:")) {
        const comma = ref.indexOf(",");
        const body = ref.slice(comma + 1);
        return JSON.parse(/;base64/.test(ref.slice(0, comma)) ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body));
      }
      return JSON.parse(await get(new URL(ref, scriptUrl).href));
    })().catch(() => null));
  }
  return mapCache.get(scriptUrl);
}
export function forgetMaps() { mapCache.clear(); }

// ---------------------------------------------------------------------------
// From a map's source name to a file on disk
// ---------------------------------------------------------------------------
// Vite: an absolute path or one relative to the module. webpack: webpack://_N_E/./app/page.jsx.
// Turbopack: turbopack:///[project]/app/page.jsx. The project folder is found by trying the
// chat's folder, the repository, and the folders under them.
function fileOnDisk(source, scriptUrl, roots) {
  let s = String(source || "").replace(/[?#].*$/, "");
  if (!s) return null;
  if (s.startsWith("file://")) { try { s = fileURLToPath(s); } catch { return null; } } // Turbopack names files so
  if (path.isAbsolute(s) && fs.existsSync(s)) return s;
  const bundler = /^(turbopack|webpack):\/\//.test(s); // named from the project's root, not the script's folder
  s = s.replace(/^turbopack:\/\/\/\[project\]\//, "").replace(/^webpack:\/\/[^/]*\/(\.\/)?/, "").replace(/^\/@fs\//, "/");
  if (path.isAbsolute(s) && fs.existsSync(s)) return s;
  if (/^https?:/.test(s)) s = new URL(s).pathname;
  else if (!bundler && scriptUrl && !s.startsWith("/")) { try { s = new URL(s, scriptUrl).pathname; } catch { /* as it is */ } }
  const rel = s.replace(/^\/+/, "");
  for (const root of roots) {
    const f = path.join(root, rel);
    if (fs.existsSync(f)) return f;
  }
  return null;
}
function candidateRoots(cwd, project) {
  const roots = [cwd, project];
  for (const base of [cwd, project]) {
    for (const d of safeDirs(base)) { roots.push(d); for (const dd of safeDirs(d)) roots.push(dd); }
  }
  return [...new Set(roots)];
}
function safeDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !/^(\.|node_modules$|dist$|build$)/.test(e.name)).map((e) => path.join(dir, e.name)).slice(0, 40);
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// The line, checked against the file
// ---------------------------------------------------------------------------
const NEAR = 120; // lines either side of the reported one that are searched
function selectorParts(selector) {
  const sel = String(selector || "");
  const tag = (/^[a-z][\w-]*/i.exec(sel) || [""])[0].toLowerCase();
  const id = (/#([\w-]+)/.exec(sel) || [])[1] || null;
  const classes = [...sel.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  const testid = (/\[data-testid=([^\]]+)\]/.exec(sel) || [])[1] || null;
  return { tag, id, classes, testid };
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function checkLine(file, line, ctx) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return { line, sure: false }; }
  if (text.length > 2e6) return { line, sure: false };
  const lines = text.split("\n");
  const { tag, id, classes, testid } = selectorParts(ctx.selector);
  const comp = (ctx.react && ctx.react.components && ctx.react.components[0]) || null;
  const words = String(ctx.text || "").replace(/…$/, "").trim().slice(0, 24);
  const tagRe = tag ? new RegExp(`<${esc(tag)}(?=[\\s>/])`) : null;
  const compRe = comp ? new RegExp(`<${esc(comp)}(?=[\\s>/.])`) : null;
  const from = Math.max(0, (line || 1) - 1 - NEAR), to = Math.min(lines.length, (line || 1) - 1 + NEAR);
  let best = null;
  for (let i = from; i < to; i++) {
    const opens = (tagRe && tagRe.test(lines[i])) || (compRe && compRe.test(lines[i]));
    if (!opens) continue;
    const near = lines.slice(i, i + 6).join("\n");
    let score = 1;
    if (id && new RegExp(`id=\\{?["'\`]${esc(id)}["'\`]`).test(near)) score += 4;
    if (testid && near.includes(testid.replace(/^["']|["']$/g, ""))) score += 4;
    for (const c of classes) if (new RegExp(`class(Name)?=[^>]*\\b${esc(c)}\\b`).test(near)) score += 1;
    if (words.length >= 3 && near.includes(words.slice(0, 16))) score += 2;
    const dist = Math.abs(i + 1 - (line || i + 1));
    if (!best || score > best.score || (score === best.score && dist < best.dist)) best = { line: i + 1, score, dist };
  }
  if (!best) return { line, sure: false };
  // Confirmed by more than the tag, or the tag is the only one of its kind nearby.
  const sure = best.score >= 3 || lines.slice(from, to).filter((l) => (tagRe && tagRe.test(l)) || (compRe && compRe.test(l))).length === 1;
  return sure ? { line: best.line, sure: true } : { line, sure: false };
}

// ---------------------------------------------------------------------------
// One note's element
// ---------------------------------------------------------------------------
// ctx: a cleaned element context. toProject(file, line) -> "rel/path:line" or null (outside the
// project). isLocal(url): only this machine's dev servers are fetched. Returns { source, sure } or null.
export async function resolveSource(ctx, { cwd, project, toProject, isLocal }) {
  if (!ctx || !ctx.react) return null;
  const roots = candidateRoots(cwd, project);
  let file = null, line = null;
  const at = ctx.react.at;
  if (at && isLocal(at.url)) {
    const map = await mapFor(at.url);
    const hit = map && lookupAny(map, at.line, at.col);
    if (hit) { file = fileOnDisk(hit.base ? `${hit.base.replace(/\/?$/, "/")}${hit.source}` : hit.source, at.url, roots) || fileOnDisk(hit.source, at.url, roots); line = hit.line; }
  }
  if (!file && ctx.react.source) {
    const m = /^(.+?):(\d+)$/.exec(ctx.react.source);
    const f = m ? m[1] : ctx.react.source;
    file = path.isAbsolute(f) ? (fs.existsSync(f) ? f : null) : fileOnDisk(f, null, roots);
    line = m ? Number(m[2]) : null;
  }
  if (!file) return null;
  const checked = checkLine(file, line, ctx);
  const source = toProject(file, checked.line);
  return source ? { source, sure: checked.sure, components: unrenamed(file, ctx.react.components || []) } : null;
}

// esbuild renames a function that shares a name with its binding (const Card = memo(function Card…)
// becomes Card2): a name the code doesn't have goes back to the one it does.
function unrenamed(file, components) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return components; }
  return components.map((c) => {
    const m = /^(.+?)\d+$/.exec(c);
    return m && !new RegExp(`\\b${esc(c)}\\b`).test(text) && new RegExp(`\\b${esc(m[1])}\\b`).test(text) ? m[1] : c;
  });
}
