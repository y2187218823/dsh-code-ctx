/**
 * 无 DSH 环境下的插件自测：用一个假 ctx 收下 register 调用，
 * 再直接调命令 handler 和 HTTP handler，验证插件逻辑本身跑得通。
 *
 *   node test/harness.mjs <仓库路径>
 */
import { apply } from '../src/plugin.js';

const root = process.argv[2];
if (!root) {
  console.error('用法: node test/harness.mjs <仓库路径>');
  process.exit(1);
}
process.env.DSH_CODE_CTX_ROOT = root;

let route;
let command;
let tool;
const ctx = {
  // ctx.effect(fn) 在真实 DSH 里返回 disposer；这里立即执行即可
  effect: (fn) => {
    const d = fn();
    return typeof d === 'function' ? d : () => {};
  },
  webServer: {
    register: (r) => {
      route = r;
      return () => {};
    },
  },
  commands: {
    register: (c) => {
      command = c;
      return () => {};
    },
  },
  tools: {
    register: (t) => {
      tool = t;
      return () => {};
    },
  },
};

apply(ctx);
// 工具注册走的是动态 import，等一拍让它落地
await new Promise((r) => setTimeout(r, 300));

console.log('route   :', route?.path, route?.kind);
console.log('command :', '/' + command?.name, '-', command?.description);
console.log('tool    :', tool?.name, '-', (tool?.description ?? '').slice(0, 30) + '…');
console.log('tool out:', tool?.output?.schema ? JSON.stringify(tool.output.schema.properties) : '无');

if (tool) {
  console.log('\n--- tool repo_search("notify session 过滤") ---');
  const out = await tool.execute({ query: 'notify session 过滤', top: 3 });
  console.log(String(out.summary).split('\n').slice(0, 4).join('\n'));
  console.log('--- render ---');
  console.log(JSON.stringify(tool.output.render({}, out)).slice(0, 120));
}

console.log('\n--- /ctx build ---');
console.log(command.handler({ rawInput: 'build' }).text);

console.log('\n--- /ctx notify session 过滤 ---');
console.log(command.handler({ rawInput: 'notify session 过滤' }).text);

console.log('\n--- GET /dsh-code-ctx/search ---');
const res = {
  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  },
  end(body) {
    this.body = body;
  },
};
await route.handler(
  { url: '/dsh-code-ctx/search?q=balance%20refresh&top=3', method: 'GET' },
  res,
);
const payload = JSON.parse(res.body);
console.log('status :', res.status);
console.log('stats  :', JSON.stringify(payload.stats));
payload.results.forEach((r, i) => console.log(`  ${i + 1}. ${r.file}:${r.lines} ${r.symbol} (${r.score})`));

console.log('\n--- GET /dsh-code-ctx/stats ---');
const res2 = { writeHead() {}, end(b) { this.body = b; } };
await route.handler({ url: '/dsh-code-ctx/stats', method: 'GET' }, res2);
console.log(res2.body);
