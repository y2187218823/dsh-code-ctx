/**
 * 实验：给检索加一路向量分数，看能不能救回零词面重叠的查询。
 *
 * 做法（分三步，可单独跑）：
 *   1. build  —— 把所有代码块过一遍 embedding 模型，缓存到 .code-ctx/emb-<name>.json
 *   2. eval   —— 用同一批 commit 评测集，比较「纯 BM25」和「BM25 + 向量」的 recall@k
 *
 * 向量只用来补词法检索的短板，所以融合时按名次融合（RRF），不直接加分数，
 * 避免两种分数量纲不同、把 BM25 的结果冲垮。
 *
 * 用法：
 *   set HF_ENDPOINT=https://hf-mirror.com
 *   node tools/embed-eval.mjs --index .code-ctx/vite.json --report eval/vite-report.json
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { search } from '../src/search.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const INDEX = arg('index', '.code-ctx/vite.json');
const REPORT = arg('report', 'eval/vite-report.json');
const MODEL = arg('model', 'Xenova/all-MiniLM-L6-v2');
const CACHE = arg('cache', '.code-ctx/emb-vite.json');
const K = Number(arg('k', 8));
const ALPHA = Number(arg('alpha', 0.5)); // RRF 里向量那一路的权重

const index = JSON.parse(readFileSync(INDEX, 'utf8'));
const report = JSON.parse(readFileSync(REPORT, 'utf8'));

/** 送进模型的文本：符号名 + 代码（截断）。纯代码对语义模型不友好，先带上名字。 */
function chunkText(c) {
  return `${c.name}\n${c.text}`.slice(0, 1200);
}

async function loadExtractor() {
  const { pipeline, env } = await import('@huggingface/transformers');
  // 国内直连 huggingface.co 不通，必须显式指向镜像。
  // 注意：HF_ENDPOINT 环境变量在这个版本里不生效，只能改 env.remoteHost。
  env.remoteHost = process.env.HF_ENDPOINT || 'https://hf-mirror.com';
  env.remotePathTemplate = '{model}/resolve/{revision}/';
  env.cacheDir = '.hf-cache';
  env.allowLocalModels = false;
  return pipeline('feature-extraction', MODEL, { dtype: 'q8' });
}

async function embedAll(extractor, texts, batch = 16) {
  const out = [];
  for (let i = 0; i < texts.length; i += batch) {
    const slice = texts.slice(i, i + batch);
    const tensor = await extractor(slice, { pooling: 'mean', normalize: true });
    const dim = tensor.dims[tensor.dims.length - 1];
    const data = tensor.data;
    for (let r = 0; r < slice.length; r++) {
      out.push(Array.from(data.slice(r * dim, (r + 1) * dim)));
    }
    if ((i + batch) % 320 === 0) process.stdout.write(`  已编码 ${Math.min(i + batch, texts.length)}/${texts.length}\n`);
  }
  return out;
}

function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s; // 模型输出已归一化，点积即余弦
}

// ---------- 1. 建向量（有缓存就复用） ----------
let vectors;
if (existsSync(CACHE)) {
  const cached = JSON.parse(readFileSync(CACHE, 'utf8'));
  if (cached.model === MODEL && cached.chunks === index.chunks.length) {
    vectors = cached.vectors;
    console.log(`复用缓存向量：${vectors.length} 条`);
  }
}

const t0 = Date.now();
if (!vectors) {
  const extractor = await loadExtractor();
  console.log(`模型已加载（${MODEL}），开始编码 ${index.chunks.length} 个代码块…`);
  vectors = await embedAll(extractor, index.chunks.map(chunkText));
  writeFileSync(CACHE, JSON.stringify({ model: MODEL, chunks: index.chunks.length, vectors }), 'utf8');
  console.log(`编码完成：${vectors.length} 条，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// ---------- 2. 评测 ----------
const isTest = (f) => /(__tests__|\.spec\.|\.test\.|playground\/)/.test(f);

async function run({ withVectors }) {
  const extractor = withVectors ? await loadExtractor() : null;
  const recalls = [];
  const hits = [];

  for (const row of report.rows) {
    // 词法那一路：多取一些候选，后面融合要用名次
    const lex = search(index, row.query, { top: 64 });
    const lexFiles = [...new Set(lex.map((h) => h.file))];

    let files = lexFiles;
    if (withVectors) {
      const q = await extractor([row.query], { pooling: 'mean', normalize: true });
      const qv = Array.from(q.data);
      const sims = vectors.map((v, i) => ({ i, s: cosine(qv, v) }));
      sims.sort((a, b) => b.s - a.s);
      const vecFiles = [];
      for (const { i } of sims) {
        const f = index.chunks[i].file;
        if (!vecFiles.includes(f)) vecFiles.push(f);
        if (vecFiles.length >= 64) break;
      }

      // RRF 融合：两路各按名次给分，不用原始分值（量纲不同）
      const score = new Map();
      lexFiles.forEach((f, r) => score.set(f, (score.get(f) ?? 0) + 1 / (60 + r + 1)));
      vecFiles.forEach((f, r) => score.set(f, (score.get(f) ?? 0) + ALPHA / (60 + r + 1)));
      files = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
    }

    const top = files.slice(0, K);
    const found = row.truth.filter((f) => top.includes(f));
    recalls.push(found.length / row.truth.length);
    hits.push(found.length ? 1 : 0);
  }

  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  return { recall: avg(recalls), hit: avg(hits) };
}

const base = await run({ withVectors: false });
const hybrid = await run({ withVectors: true });

console.log(`\n样本 ${report.rows.length} 条，top-${K}`);
console.log(`  纯词法      recall ${base.recall.toFixed(3)}   hit ${base.hit.toFixed(3)}`);
console.log(`  词法+向量   recall ${hybrid.recall.toFixed(3)}   hit ${hybrid.hit.toFixed(3)}`);
console.log(`  提升        ${((hybrid.recall - base.recall) * 100).toFixed(1)} 个百分点`);
