/**
 * 真实 commit 评测：用 commit message 当查询，用「这次改了哪些文件」当标准答案。
 *
 * 为什么这样评：代码检索没有现成的 benchmark，而 commit 天生自带「问题 → 该改哪里」
 * 的配对关系。人在 commit message 里写的是「我要解决什么」，diff 里是「实际动了哪儿」，
 * 正好对应我们的输入和期望输出。
 *
 * 用法：
 *   node tools/eval-github.mjs --repo vitejs/vite --index .code-ctx/vite.json --n 120
 *
 * 注意：commit 列表走 GitHub API（有速率限制），每个 commit 的 diff 走
 * github.com/{repo}/commit/{sha}.diff（普通网页，不计入 API 配额）。
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { search } from '../src/search.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const REPO = arg('repo', 'vitejs/vite');
const INDEX_PATH = arg('index', '.code-ctx/vite.json');
const N = Number(arg('n', 120));
const OUT = arg('out', 'eval/report.json');
const TOPK = Number(arg('topk', 8));

const index = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
const known = new Set(index.files.map((f) => f.path));

// 只保留「描述问题」的 commit：去掉发布、依赖升级、纯合并这类没有语义的。
// 第二轮补充：初版只过滤了 chore/docs/build/ci 开头，实测发现大量
// 「update all non-major dependencies」这类依赖升级混进来——它们改的是
// 模板/锁文件，message 和 diff 天然对不上，纯属标签噪声。
const SKIP =
  /^(chore|docs|build|ci|test)\b|^Merge |^revert|^release|^fix typo|renovate|dependenc|bump |update all/i;

function cleanQuery(message) {
  const first = message.split('\n')[0].trim();
  return first
    .replace(/^(feat|fix|refactor|perf|test|style)(\([^)]*\))?:\s*/i, '')
    .replace(/\(#\d+\)\s*$/, '') // 去掉 PR 编号，它对检索无意义
    .trim();
}

async function fetchCommits() {
  const out = [];
  for (let page = 1; out.length < N && page <= 5; page++) {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/commits?per_page=100&page=${page}`,
      { headers: { accept: 'application/vnd.github+json', 'user-agent': 'code-ctx-eval' } },
    );
    if (!res.ok) throw new Error(`commits API ${res.status}: ${await res.text()}`);
    const rows = await res.json();
    if (!rows.length) break;
    for (const r of rows) {
      const msg = r.commit?.message ?? '';
      if (!r.sha || SKIP.test(msg.trim())) continue;
      const q = cleanQuery(msg);
      if (q.length < 12) continue; // 太短的 message 当不了查询
      out.push({ sha: r.sha, query: q, date: r.commit?.author?.date });
      if (out.length >= N) break;
    }
  }
  return out;
}

/** 拉一个 commit 的 diff，取改动的文件路径。带本地缓存，重跑不用重新下载。 */
async function fetchFiles(sha) {
  const cacheFile = `eval/cache/${sha}.json`;
  try {
    return JSON.parse(readFileSync(cacheFile, 'utf8'));
  } catch {
    // 没缓存，走网络
  }

  const res = await fetch(`https://github.com/${REPO}/commit/${sha}.diff`, {
    headers: { 'user-agent': 'code-ctx-eval' },
  });
  if (!res.ok) return null;
  const text = await res.text();
  const files = new Set();
  for (const m of text.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    const path = m[2].trim();
    if (known.has(path)) files.add(path);
  }
  const out = [...files];
  mkdirSync('eval/cache', { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(out), 'utf8');
  return out;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (i < items.length) {
        const idx = i++;
        try {
          out[idx] = await fn(items[idx], idx);
        } catch {
          out[idx] = null;
        }
      }
    }),
  );
  return out;
}

const commits = await fetchCommits();
console.log(`候选 commit：${commits.length}`);

const filesByCommit = await mapLimit(commits, 6, async (c, i) => {
  const files = await fetchFiles(c.sha);
  if ((i + 1) % 20 === 0) console.log(`  已取 ${i + 1}/${commits.length}`);
  return files;
});

const cases = [];
// create-vite 的模板表、playground 的测试夹具：改的是数据不是逻辑，
// 拿它们当检索题会系统性低估（query 说「支持 TanStack」，diff 只是往数组里加一行）
const TRIVIAL = /^(playground|packages\/create-vite)\//;

commits.forEach((c, i) => {
  const truth = filesByCommit[i];
  if (!truth || truth.length === 0) return;
  if (truth.length > 15) return; // 一次改几十个文件的 commit 不适合当检索题
  if (truth.every((f) => TRIVIAL.test(f))) return;
  cases.push({ ...c, truth });
});
console.log(`可用于评测的样本：${cases.length}\n`);

// 跑检索
// 注意 k 的口径：**按文件算**，不是按代码块算。
// 初版直接取 top-K 个 chunk，去重成文件后往往不足 K 个，
// 相当于偷偷把「top-8 文件」压成了「top-5 文件」，指标被系统性低估。
const PULL = Math.max(64, TOPK * 8);
const rows = [];
for (const c of cases) {
  const hits = search(index, c.query, { top: PULL });
  const allFiles = [...new Set(hits.map((h) => h.file))];
  const hitFiles = allFiles.slice(0, TOPK);
  const found = c.truth.filter((f) => hitFiles.includes(f));
  const rank = c.truth.map((f) => hitFiles.indexOf(f)).filter((x) => x >= 0);
  rows.push({
    query: c.query,
    truth: c.truth,
    top: hitFiles,
    recall: found.length / c.truth.length,
    hit: found.length > 0 ? 1 : 0,
    mrr: rank.length ? 1 / (Math.min(...rank) + 1) : 0,
  });
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const recall = avg(rows.map((r) => r.recall));
const hit = avg(rows.map((r) => r.hit));
const mrr = avg(rows.map((r) => r.mrr));

const k = TOPK;
console.log(`样本 ${rows.length} 条，top-${k}`);
console.log(`  recall@${k} : ${recall.toFixed(3)}`);
console.log(`  hit@${k}    : ${hit.toFixed(3)}  （至少命中一个真实改动文件的比例）`);
console.log(`  MRR        : ${mrr.toFixed(3)}`);

console.log('\n命中示例：');
rows.filter((r) => r.hit).slice(0, 3).forEach((r) => {
  console.log(`  ✓ ${r.query}`);
  console.log(`    真实改动: ${r.truth.join(', ')}`);
});
console.log('\n未命中示例：');
rows.filter((r) => !r.hit).slice(0, 3).forEach((r) => {
  console.log(`  ✗ ${r.query}`);
  console.log(`    真实改动: ${r.truth.join(', ')}`);
});

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify(
    { repo: REPO, index: INDEX_PATH, topk: k, samples: rows.length, recall, hit, mrr, rows },
    null,
    2,
  ),
  'utf8',
);
console.log(`\n明细已写入 ${OUT}`);
