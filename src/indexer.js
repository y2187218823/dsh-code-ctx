/**
 * 索引构建：遍历文件 → 按符号切块 → 抽取依赖边 → 落盘。
 *
 * 为什么不用「按行切 window」：一个函数被切成两半，检索命中后拿到的片段是残缺的，
 * agent 还得自己再读一遍文件。按符号切是为了让**返回结果本身就能直接用**。
 *
 * 切块目前用正则 + 括号配对，不依赖 tree-sitter（要编译原生模块，Windows 上装起来很痛）。
 * 代价是复杂语法（嵌套模板字符串、装饰器）可能切歪 —— 这是已知局限，写在 README 里。
 */
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative, dirname, extname, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { languageOf, tokenize } from './text.js';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', 'coverage',
  '.next', '.nuxt', '.cache', '.venv', 'venv', '__pycache__', '.idea', '.vscode',
]);

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.py', '.go', '.rs', '.java', '.kt']);

const BUILD_DIRS = new Set(['lib', 'dist', 'build', 'out', 'esm', 'cjs']);

const MAX_FILE_BYTES = 512 * 1024; // 超大文件（压缩产物、数据文件）跳过

/** 递归列出代码文件（相对路径）。 */
export function walk(root, { maxFiles = 5000, skipDirs = SKIP_DIRS } = {}) {
  const out = [];
  const stack = [root];

  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 无权限目录直接跳过，不中断整体索引
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.') {
        if (e.isDirectory()) continue;
      }
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (!skipDirs.has(e.name)) stack.push(abs);
        continue;
      }
      if (!e.isFile()) continue;
      if (!CODE_EXT.has(extname(e.name).toLowerCase())) continue;
      let size;
      try {
        size = statSync(abs).size;
      } catch {
        continue;
      }
      if (size > MAX_FILE_BYTES) continue;
      out.push({ abs, rel: toPosix(relative(root, abs)), size });
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

function toPosix(p) {
  return p.split('\\').join('/');
}

/**
 * 同内容的两份文件，哪份更该留作索引？
 * 源码目录优先，构建产物目录降级，层级浅的优先。
 */
function moreLikeSource(a, b) {
  const score = (rel) => {
    let s = 0;
    if (/(^|\/)src\//.test(rel)) s += 3;
    if (/(^|\/)(lib|dist|build|out|esm|cjs)\//.test(rel)) s -= 3;
    if (/(^|\/)(test|tests|spec|__tests__)\//.test(rel)) s -= 1;
    return s - rel.split('/').length * 0.1;
  };
  return score(a) > score(b);
}

/**
 * 从 startLine 起找与第一个 '{' 配对的 '}' 所在行。
 * 简化处理：不解析字符串/注释里的花括号（已知局限）。
 */
function matchBrace(lines, startLine) {
  let depth = 0;
  let seen = false;
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === '{') {
        depth++;
        seen = true;
      } else if (ch === '}') {
        depth--;
      }
    }
    if (seen && depth <= 0) return i;
  }
  return Math.min(lines.length - 1, startLine + 200);
}

const JS_SYMBOL = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z0-9_$]+)/;
const JS_ASSIGN = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\(|function)/;
const PY_SYMBOL = /^(\s*)(?:class|def|async\s+def)\s+([A-Za-z0-9_]+)/;

/** 按符号切块；切不出来就退化成行窗口。 */
export function chunkFile(rel, content) {
  const lang = languageOf(rel);
  const lines = content.split('\n');
  const chunks = [];
  const covered = new Set();

  const push = (name, kind, start, end) => {
    const text = lines.slice(start, end + 1).join('\n');
    if (!text.trim()) return;
    for (let i = start; i <= end; i++) covered.add(i);
    chunks.push({ name, kind, start: start + 1, end: end + 1, text });
  };

  if (lang === 'js' || lang === 'ts') {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = JS_SYMBOL.exec(line) || JS_ASSIGN.exec(line);
      if (!m) continue;
      const name = m[1];
      const end = matchBrace(lines, i);
      if (end > i) push(name, 'symbol', i, end);
      i = end;
    }
  } else if (lang === 'py') {
    for (let i = 0; i < lines.length; i++) {
      const m = PY_SYMBOL.exec(lines[i]);
      if (!m) continue;
      const indent = m[1].length;
      let end = i;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (!l.trim()) continue;
        const cur = l.length - l.trimStart().length;
        if (cur <= indent) break;
        end = j;
      }
      push(m[2], 'symbol', i, end);
      i = end;
    }
  }

  // 顶部 import / 声明区：单独成块，检索依赖关系时有用
  const headEnd = Math.min(lines.length - 1, 40);
  if (headEnd > 0 && !covered.has(0)) push('<文件头>', 'header', 0, headEnd);

  if (chunks.length === 0) {
    // 退化：120 行以内整文件一块，否则 80 行窗口
    if (lines.length <= 120) {
      push('<整个文件>', 'file', 0, lines.length - 1);
    } else {
      for (let s = 0; s < lines.length; s += 80) {
        push(`<L${s + 1}>`, 'window', s, Math.min(lines.length - 1, s + 79));
      }
    }
  }
  return chunks;
}

const IMPORT_RE = /(?:from\s+|require\(\s*|import\s+)['"]([^'"]+)['"]/g;

/** 抽相对导入，解析成索引内的相对路径。 */
export function buildGraph(files, contents) {
  const known = new Set(files.map((f) => f.rel));
  const graph = {};

  for (const f of files) {
    const src = contents.get(f.rel) ?? '';
    const edges = new Set();
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      if (spec.endsWith('.css') || spec.endsWith('.json')) continue;

      const base = posix.normalize(posix.join(posix.dirname(f.rel), spec));
      const candidates = [
        base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, `${base}.cjs`,
        `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.mjs`,
      ];
      const hit = candidates.find((c) => known.has(c));
      if (hit && hit !== f.rel) edges.add(hit);
    }
    if (edges.size) graph[f.rel] = [...edges];
  }
  return graph;
}

function termCounts(text) {
  const counts = {};
  for (const t of tokenize(text)) counts[t] = (counts[t] ?? 0) + 1;
  return counts;
}

/**
 * 建索引。
 * @param {string} root 仓库根目录（绝对路径）
 * @returns {object} 索引对象，可直接 JSON 序列化
 */
export function buildIndex(root) {
  // 仓库里同时存在 src/ 与 lib/ 时，lib/ 几乎必然是构建产物（打包后与源码内容不同，
  // 靠内容哈希去重抓不到），直接排除；否则保留（有些项目 lib/ 就是源码）。
  const hasSourceTree = existsSync(join(root, 'src')) || existsSync(join(root, 'packages')) || existsSync(join(root, 'app'));
  const skipDirs = hasSourceTree ? new Set([...SKIP_DIRS, ...BUILD_DIRS]) : SKIP_DIRS;

  const allFiles = walk(root, { skipDirs });
  const contents = new Map();

  for (const f of allFiles) {
    try {
      contents.set(f.rel, readFileSync(f.abs, 'utf8'));
    } catch {
      continue;
    }
  }

  // 内容去重：构建产物（lib/ dist/）常与 src/ 逐字节相同，不去重会让同一个函数
  // 在结果里占三个名额。同内容只保留「最像源码」的那份。
  const byHash = new Map();
  for (const [rel, content] of contents) {
    const h = createHash('sha1').update(content).digest('hex');
    const prev = byHash.get(h);
    if (prev && !moreLikeSource(rel, prev.rel)) continue;
    byHash.set(h, { rel, content });
  }

  const kept = new Set([...byHash.values()].map((x) => x.rel));
  const files = allFiles.filter((f) => kept.has(f.rel));
  const dropped = allFiles.length - files.length;

  const rawChunks = [];
  for (const f of files) {
    const content = contents.get(f.rel);
    for (const c of chunkFile(f.rel, content)) rawChunks.push({ file: f.rel, ...c });
  }

  const chunks = rawChunks.map((c, i) => ({
    i,
    file: c.file,
    name: c.name,
    kind: c.kind,
    start: c.start,
    end: c.end,
    len: c.text.split(/\s+/).length,
    terms: termCounts(`${c.name} ${c.text}`),
    text: c.text.length > 4000 ? c.text.slice(0, 4000) : c.text,
  }));

  // 文档频率，供 BM25 用
  const df = {};
  for (const c of chunks) for (const t of Object.keys(c.terms)) df[t] = (df[t] ?? 0) + 1;

  return {
    version: 1,
    root,
    builtAt: new Date().toISOString(),
    digest: createHash('sha1').update(chunks.map((c) => `${c.file}:${c.start}:${c.len}`).join('|')).digest('hex').slice(0, 12),
    stats: {
      files: files.length,
      duplicates: dropped,
      chunks: chunks.length,
      avgLen: Math.round(chunks.reduce((s, c) => s + c.len, 0) / (chunks.length || 1)),
    },
    files: files.map((f) => ({ path: f.rel, size: f.size })),
    graph: buildGraph(files, contents),
    df,
    chunks,
  };
}

export function saveIndex(index, file) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(index), 'utf8');
  return file;
}

export function loadIndex(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}
