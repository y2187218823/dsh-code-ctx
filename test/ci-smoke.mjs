/**
 * CI 冒烟测试：不依赖任何 shell 重定向，本地和 GitHub Actions 跑的是同一份逻辑。
 *
 * 断言三件事：
 *   1. 仓库能被索引（不是空的）
 *   2. CLI 能建索引并查询
 *   3. 查 "bm25" 时 src/search.js 必须出现在 top-5（回归保护：切块/打分改动别把核心文件弄丢）
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'ctx-ci-'));
const indexFile = join(tmp, 'index.json');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
};

const run = (...args) =>
  execFileSync(process.execPath, ['bin/cli.js', ...args], { cwd: root, encoding: 'utf8' });

try {
  const indexOut = run('index', '.', '--out', indexFile);
  const files = Number(/文件 (\d+)/.exec(indexOut)?.[1] ?? 0);
  const chunks = Number(/代码块 (\d+)/.exec(indexOut)?.[1] ?? 0);
  check('索引非空', files > 0 && chunks > 0, `${files} 文件 / ${chunks} 代码块`);

  const stats = JSON.parse(run('stats', '--index', indexFile));
  check('stats 可读', typeof stats.files === 'number', `${stats.files} 文件`);

  const rows = JSON.parse(run('search', 'bm25', '--index', indexFile, '--top', '5', '--json'));
  check('查询有结果', rows.length > 0, `${rows.length} 条`);

  const hit = rows.some((r) => r.file.includes('search.js'));
  check('核心文件未被挤出 top-5', hit, rows.map((r) => r.file).join(', '));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failed) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
