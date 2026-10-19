/**
 * dsh-code-ctx —— 代码库上下文引擎（DSH 宿主插件）
 *
 * 解决的是 agent 的一个真实痛点：给它整个仓库会撑爆上下文，只看当前文件又会漏掉关键依赖。
 * 本插件给 agent/用户一个「按问题找文件」的入口：
 *
 *   斜杠命令  /ctx <问题>        → 返回最该看的文件与函数（带命中理由）
 *   HTTP      GET  /dsh-code-ctx/search?q=...&top=8
 *             POST /dsh-code-ctx/index   强制重建索引
 *             GET  /dsh-code-ctx/stats
 *
 * 索引根目录优先级：请求参数 > 环境变量 DSH_CODE_CTX_ROOT > $DSH_HOME/code-ctx/config.json
 *                  > 宿主进程 cwd（通常就是当前工作区）
 *
 * 索引常驻内存，默认 10 分钟过期；`/ctx build` 或 POST /index 可强制重建。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { buildIndex } from './indexer.js';
import { search } from './search.js';

export const name = 'code-ctx';
export const inject = ['webServer', 'commands', 'tools'];

const ROUTE_PREFIX = '/dsh-code-ctx';
const TTL_MS = 10 * 60 * 1000;

/** @type {Map<string, {index: object, at: number}>} */
const cache = new Map();

function configFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'code-ctx', 'config.json');
}

function resolveRoot(explicit) {
  if (explicit) return resolve(explicit);
  if (process.env.DSH_CODE_CTX_ROOT) return resolve(process.env.DSH_CODE_CTX_ROOT);
  try {
    const cfg = JSON.parse(readFileSync(configFile(), 'utf8'));
    if (cfg && typeof cfg.root === 'string' && cfg.root) return resolve(cfg.root);
  } catch {
    // 没有配置文件是正常情况，静默回落到 cwd
  }
  return process.cwd();
}

/** 取索引；过期或缺失则重建。 */
function getIndex(root, { force = false } = {}) {
  const hit = cache.get(root);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return { index: hit.index, rebuilt: false };
  const index = buildIndex(root);
  cache.set(root, { index, at: Date.now() });
  return { index, rebuilt: true };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function formatRows(query, rows) {
  if (!rows.length) return `没有命中「${query}」。换个说法，或先 /ctx build 重建索引。`;
  const lines = rows.map((r, i) => `${i + 1}. ${r.file}:${r.lines}  ${r.symbol}  (${r.score})  [${r.why}]`);
  return `「${query}」\n${lines.join('\n')}`;
}

/**
 * @param {any} ctx cordis 上下文
 */
export function apply(ctx) {
  // HTTP 路由
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          try {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            const sub = url.pathname.slice(ROUTE_PREFIX.length) || '/';

            if (sub === '/search' && req.method === 'GET') {
              const q = url.searchParams.get('q') ?? '';
              const top = Number(url.searchParams.get('top') ?? 8);
              const root = resolveRoot(url.searchParams.get('root'));
              const { index, rebuilt } = getIndex(root);
              return sendJson(res, 200, {
                query: q,
                root,
                rebuilt,
                stats: index.stats,
                results: search(index, q, { top }),
              });
            }

            if (sub === '/index' && req.method === 'POST') {
              const root = resolveRoot(url.searchParams.get('root'));
              const { index } = getIndex(root, { force: true });
              return sendJson(res, 200, { ok: true, root, stats: index.stats, builtAt: index.builtAt });
            }

            if (sub === '/stats' && req.method === 'GET') {
              const root = resolveRoot(url.searchParams.get('root'));
              const { index, rebuilt } = getIndex(root);
              return sendJson(res, 200, {
                root,
                rebuilt,
                builtAt: index.builtAt,
                stats: index.stats,
                edges: Object.keys(index.graph).length,
              });
            }

            return sendJson(res, 404, { error: 'unknown route', prefix: ROUTE_PREFIX });
          } catch (e) {
            return sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
        },
      }),
    'dsh-code-ctx: http routes',
  );

  // 斜杠命令
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'ctx',
        description: '按问题在代码库里找最该看的文件（/ctx build 重建索引）',
        input: { hint: '[问题描述] 或 build' },
        handler: ({ rawInput }) => {
          const arg = (rawInput ?? '').trim();
          if (!arg) {
            return { kind: 'info', text: '用法：/ctx <问题描述>；/ctx build 重建索引' };
          }

          const root = resolveRoot();
          if (arg === 'build' || arg === 'rebuild') {
            const { index } = getIndex(root, { force: true });
            return {
              kind: 'success',
              text: `索引已重建：${index.stats.files} 个文件 / ${index.stats.chunks} 个代码块`,
            };
          }

          if (!existsSync(root)) {
            return { kind: 'error', text: `索引根目录不存在：${root}` };
          }

          const { index, rebuilt } = getIndex(root);
          const rows = search(index, arg, { top: 8 });
          return { kind: 'success', text: formatRows(arg, rows) + (rebuilt ? '\n（首次索引已建立）' : '') };
        },
      }),
    'dsh-code-ctx: /ctx command',
  );

  // 工具：让 agent **自己**在需要定位代码时调用，而不是等用户敲 /ctx。
  //
  // 两处刻意的设计：
  // 1) 动态导入 @deepseek-ai/dsh-tools —— 它打包在 DSH 的 asar 里，从插件目录
  //    解析不一定成功。拿不到 defineTool 就直接注册裸描述对象（结构一致），
  //    拿不到 tools 服务就整体跳过，绝不让插件加载失败。
  // 2) 注册放在 try/catch 里：工具是本插件的增强项，命令和 HTTP 才是主体，
  //    不能因为工具注册失败把主体一起拖垮。
  ctx.effect(
    () => {
      let disposed = false;

      void (async () => {
        let defineTool = null;
        try {
          ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
        } catch {
          // asar 外部解析不到是预期情况，退回裸对象
        }
        if (disposed || !ctx.tools?.register) return;

        const spec = {
          name: 'repo_search',
          description:
            '在代码库里按问题检索最相关的文件与函数，返回文件路径、符号名、行号与命中理由' +
            '（词法检索 + 依赖图扩散）。修改代码、定位报错、了解某功能在哪实现时先用它，' +
            '避免盲目 list/读文件。中文英文描述都行。',
          parameters: {
            query: { type: 'string', required: true, description: '要解决的问题，或要找的代码语义' },
            top: { type: 'number', description: '返回条数，默认 8' },
          },
          output: {
            schema: {
              type: 'object',
              properties: { summary: { type: 'string', required: true } },
              additionalProperties: false,
            },
            render: (_args, value) => [{ type: 'text', text: value.summary }],
          },
          async execute(args) {
            const root = resolveRoot();
            if (!existsSync(root)) {
              return { summary: `索引根目录不存在：${root}\n请在 $DSH_HOME/code-ctx/config.json 里设置正确的 root。` };
            }
            const { index } = getIndex(root);

            // 空索引是真实发生过的故障：桌面版宿主的 cwd 不是工作区，
            // 而那里的 node_modules 又被跳过，索引几乎是空的 —— 结果只报「没命中」，
            // 看起来像检索不准，实际是根本没东西可检索。必须把原因说出来。
            if (index.stats.files === 0) {
              return {
                summary:
                  `索引是空的（根目录 ${root}）。\n` +
                  `多半是根目录选错了 —— 请在 $DSH_HOME/code-ctx/config.json 里把 root 指向你的项目目录，` +
                  `或用环境变量 DSH_CODE_CTX_ROOT 指定。`,
              };
            }

            const rows = search(index, String(args.query ?? ''), { top: Number(args.top) || 8 });
            if (!rows.length) {
              return {
                summary:
                  `在 ${root}（${index.stats.files} 个文件 / ${index.stats.chunks} 个代码块）里没有命中「${args.query}」。\n` +
                  `换种说法试试，或用 /ctx build 重建索引。`,
              };
            }
            const lines = rows.map(
              (r, i) => `${i + 1}. ${r.file}:${r.lines}  ${r.symbol}  (${r.score})  [${r.why}]`,
            );
            return { summary: `索引根目录 ${root}\n${lines.join('\n')}` };
          },
        };

        try {
          ctx.tools.register(defineTool ? defineTool(spec) : spec);
        } catch (e) {
          console.warn('[dsh-code-ctx] 工具注册失败：' + (e instanceof Error ? e.message : String(e)));
        }
      })();

      return () => {
        disposed = true;
      };
    },
    'dsh-code-ctx: repo_search tool',
  );
}
