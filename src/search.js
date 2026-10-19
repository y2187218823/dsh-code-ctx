/**
 * 检索：BM25 + 符号名加权 + 依赖图扩散。
 *
 * 三个信号为什么要叠：
 *   BM25   —— 主体相关性，判断这段代码在讲什么
 *   符号名 —— 用户搜 "parseConfig" 时，函数名叫 parseConfig 的必须排最前
 *   依赖图 —— 改 bug 常常要看「调用它的地方」，命中的文件把邻居一起带出来
 *
 * 没做向量检索：CPU 上跑 embedding 会让索引时间翻十倍，而标识符在这类任务里
 * 本来就比语义更可靠。要加也是加在「注释/文档」上，见 README 的后续计划。
 */
import { queryTerms } from './text.js';

const K1 = 1.2;
const B = 0.75;

// 路径降权：真实项目里，测试/示例/类型声明常常比实现本身「更爱提关键词」，
// 不压一下会把真正的源码挤下去。vite 压测实测：问 websocket hmr，
// 前三条全是 playground 测试和 .d.ts，真正的 server/ws.ts 一条都没进。
const TEST_PATH = /(^|\/)(__tests__|tests?|spec|playground|fixtures?|examples?|benchmarks?|e2e)\//i;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const TYPE_FILE = /\.d\.[cm]?ts$/i;

/** @returns {{mul: number, why: string[]}} */
function pathPenalty(file) {
  let mul = 1;
  const why = [];
  if (TEST_PATH.test(file) || TEST_FILE.test(file)) {
    mul *= 0.55;
    why.push('测试降权');
  }
  if (TYPE_FILE.test(file)) {
    mul *= 0.6;
    why.push('类型降权');
  }
  return { mul, why };
}

/** 单个块的 BM25 得分。 */
function bm25(chunk, terms, df, n, avgdl) {
  let score = 0;
  const hit = [];
  for (const t of terms) {
    const tf = chunk.terms[t];
    if (!tf) continue;
    const idf = Math.log(1 + (n - (df[t] ?? 0) + 0.5) / ((df[t] ?? 0) + 0.5));
    score += (idf * (tf * (K1 + 1))) / (tf + K1 * (1 - B + (B * chunk.len) / avgdl));
    hit.push(t);
  }
  return { score, hit };
}

/**
 * @param {object} index buildIndex() 的产物
 * @param {string} query
 * @param {{top?: number, expand?: boolean}} [opts]
 */
export function search(index, query, opts = {}) {
  const top = opts.top ?? 8;
  const expand = opts.expand ?? true;
  const terms = queryTerms(query);
  if (!terms.length) return [];

  const n = index.chunks.length;
  const avgdl = index.stats.avgLen || 1;
  const rows = [];

  for (const c of index.chunks) {
    const { score: base, hit } = bm25(c, terms, index.df, n, avgdl);
    if (base <= 0) continue;

    let score = base;
    const why = ['bm25'];

    // 符号名命中：强信号
    const nameLower = c.name.toLowerCase();
    if (terms.some((t) => nameLower.includes(t))) {
      score *= 1.6;
      why.push('符号名');
    }
    // 路径命中：中等信号
    const fileLower = c.file.toLowerCase();
    if (terms.some((t) => fileLower.includes(t))) {
      score *= 1.2;
      why.push('路径');
    }
    // 文件头 / 整文件块降权：它们信息密度低，容易挤掉真正的函数
    if (c.kind === 'header' || c.kind === 'file') {
      score *= 0.5;
      why.push('降权');
    }
    // 测试 / 示例 / 类型声明降权
    const pen = pathPenalty(c.file);
    if (pen.mul !== 1) {
      score *= pen.mul;
      why.push(...pen.why);
    }

    rows.push({ chunk: c, score, why, hit });
  }

  if (!rows.length) return [];

  // 依赖图扩散：先按文件聚合，取 top 文件的邻居，给邻居块加分
  if (expand) {
    const fileScore = new Map();
    for (const r of rows) {
      fileScore.set(r.chunk.file, Math.max(fileScore.get(r.chunk.file) ?? 0, r.score));
    }
    const topFiles = [...fileScore.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const bonus = new Map();

    for (const [file, s] of topFiles) {
      const neighbors = index.graph[file] ?? [];
      // 反向边也要：A import B 时，B 改了会影响 A
      const reverse = Object.entries(index.graph)
        .filter(([, outs]) => outs.includes(file))
        .map(([src]) => src);

      for (const nb of new Set([...neighbors, ...reverse])) {
        bonus.set(nb, Math.max(bonus.get(nb) ?? 0, s * 0.18));
      }
    }

    for (const r of rows) {
      const add = bonus.get(r.chunk.file);
      if (add) {
        r.score += add;
        if (!r.why.includes('依赖图')) r.why.push('依赖图');
      }
    }
  }

  rows.sort((a, b) => b.score - a.score);

  // 同一文件最多留 2 段，避免一个文件把名额占满
  const perFile = new Map();
  const picked = [];
  for (const r of rows) {
    const used = perFile.get(r.chunk.file) ?? 0;
    if (used >= 2) continue;
    perFile.set(r.chunk.file, used + 1);
    picked.push(r);
    if (picked.length >= top) break;
  }

  return picked.map((r) => ({
    file: r.chunk.file,
    symbol: r.chunk.name,
    kind: r.chunk.kind,
    lines: `${r.chunk.start}-${r.chunk.end}`,
    score: Number(r.score.toFixed(3)),
    why: r.why.join(' + '),
    matched: r.hit,
    preview: r.chunk.text.slice(0, 220).replace(/\n{2,}/g, '\n'),
  }));
}
