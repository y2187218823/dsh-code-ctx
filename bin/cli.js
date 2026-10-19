#!/usr/bin/env node
/**
 * 命令行入口。
 *
 *   node bin/cli.js index <目录> [--out .code-ctx/index.json]
 *   node bin/cli.js search "查询" [--index .code-ctx/index.json] [--top 8] [--json]
 *   node bin/cli.js stats  [--index ...]
 */
import { resolve, join } from 'node:path';
import { buildIndex, saveIndex, loadIndex } from '../src/indexer.js';
import { search } from '../src/search.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const has = (name) => process.argv.includes(`--${name}`);
const action = process.argv[2];
const DEFAULT_INDEX = join(process.cwd(), '.code-ctx', 'index.json');

function fmt(ms) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

if (action === 'index') {
  const root = resolve(process.argv[3] ?? '.');
  const out = resolve(arg('out', DEFAULT_INDEX));
  const t0 = Date.now();
  const index = buildIndex(root);
  saveIndex(index, out);
  console.log(`索引完成  ${fmt(Date.now() - t0)}`);
  console.log(`  文件 ${index.stats.files}  代码块 ${index.stats.chunks}  平均长度 ${index.stats.avgLen} 词`);
  console.log(`  根目录 ${index.root}`);
  console.log(`  输出   ${out}`);
} else if (action === 'search') {
  const query = process.argv.slice(3).filter((a) => !a.startsWith('--') && a !== arg('index') && a !== arg('top')).join(' ');
  if (!query) {
    console.error('用法: node bin/cli.js search "查询词" [--index 路径] [--top 8]');
    process.exit(1);
  }
  const index = loadIndex(resolve(arg('index', DEFAULT_INDEX)));
  const t0 = Date.now();
  const rows = search(index, query, { top: Number(arg('top', 8)) });
  const ms = Date.now() - t0;

  if (has('json')) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    if (!rows.length) {
      console.log(`没有命中「${query}」`);
    } else {
      console.log(`「${query}」 → ${rows.length} 条  (${fmt(ms)})\n`);
      rows.forEach((r, i) => {
        console.log(`${String(i + 1).padStart(2)}. ${r.score.toFixed(2)}  ${r.file}:${r.lines}`);
        console.log(`    ${r.symbol}   [${r.why}]  匹配: ${r.matched.join(',')}`);
      });
    }
  }
} else if (action === 'stats') {
  const index = loadIndex(resolve(arg('index', DEFAULT_INDEX)));
  console.log(JSON.stringify({ root: index.root, builtAt: index.builtAt, ...index.stats, edges: Object.keys(index.graph).length }, null, 2));
} else {
  console.log('用法:\n  node bin/cli.js index <目录> [--out 路径]\n  node bin/cli.js search "查询" [--index 路径] [--top 8] [--json]\n  node bin/cli.js stats');
  process.exit(action ? 1 : 0);
}
