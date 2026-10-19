/**
 * 文本处理：分词与语言判定。
 *
 * 代码检索和自然语言检索不一样：标识符是强信号。
 * `parseConfig` 这种词，用户大概率会搜 "config"、"parse" 或 "parseConfig"，
 * 所以要把驼峰、下划线拆开，同时保留原始整体作为一个词元（增强精确匹配）。
 */

const CJK = /[\u4e00-\u9fa5]/;
const WORD = /[A-Za-z_$][A-Za-z0-9_$]*|[\u4e00-\u9fa5]+/g;

const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'has', 'have',
  'not', 'but', 'you', 'all', 'can', 'her', 'his', 'one', 'our', 'out', 'use', 'get', 'set',
  'const', 'let', 'var', 'function', 'return', 'import', 'export', 'class', 'new', 'await',
  'async', 'true', 'false', 'null', 'undefined', 'typeof', 'instanceof', 'this', 'super',
]);

/**
 * 轻量词干化：只处理英文里最常见的几种屈折/派生后缀。
 *
 * 为什么需要：查询里写的是自然语言（"served output files"），
 * 而代码和注释里是 `serveOutput`、`file`。不做词干，`files`/`file`、
 * `served`/`serve`、`normalize`/`normalized` 会被当成四个毫不相干的词，
 * 白白丢掉命中。实测这类形态差异占了零命中样本的不小一部分。
 *
 * 故意做得很保守：宁可少合并，也不要把 `css` 削成 `cs` 制造假匹配。
 */
export function stem(word) {
  if (word.length < 4) return word;
  if (/(ss|us|is|ous)$/.test(word)) return word; // class / status / analysis / famous
  if (/ies$/.test(word)) return word.slice(0, -3) + 'y'; // properties -> property
  if (/ing$/.test(word) && word.length > 5) return word.slice(0, -3); // serving -> serv
  if (/ed$/.test(word) && word.length > 4) return word.slice(0, -2); // served -> serv
  if (/es$/.test(word) && word.length > 4) return word.slice(0, -2); // boxes -> box
  if (/s$/.test(word)) return word.slice(0, -1); // files -> file
  return word;
}

/**
 * 把一段文本切成检索词元。
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const out = [];
  const lower = text.toLowerCase();

  // 整体词元（保留原样，用于精确匹配）
  for (const m of lower.matchAll(WORD)) {
    out.push(m[0]);
    const s = stem(m[0]);
    if (s !== m[0]) out.push(s); // 词干作为额外词元，不替换原词
  }

  // 拆开的子词（驼峰 / 下划线）
  for (const m of text.matchAll(WORD)) {
    const raw = m[0];
    if (CJK.test(raw)) continue;
    const parts = raw
      .split(/[_$]+/)
      .flatMap((p) => p.split(/(?=[A-Z])/))
      .map((p) => p.toLowerCase())
      .filter(Boolean);
    if (parts.length > 1) {
      for (const p of parts) {
        out.push(p);
        const s = stem(p);
        if (s !== p) out.push(s);
      }
    }
  }

  return out.filter((t) => t.length > 1 && !STOP.has(t));
}

/** 按扩展名判定语言。 */
export function languageOf(file) {
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
  if (['.ts', '.tsx'].includes(ext)) return 'ts';
  if (['.js', '.mjs', '.cjs', '.jsx'].includes(ext)) return 'js';
  if (ext === '.py') return 'py';
  if (['.go'].includes(ext)) return 'go';
  if (['.rs'].includes(ext)) return 'rs';
  if (['.java', '.kt'].includes(ext)) return 'java';
  return null;
}

/** 双语查询：中文部分整体当一个词，英文仍拆词。 */
export function queryTerms(query) {
  const terms = [...new Set(tokenize(query))];
  return terms;
}
