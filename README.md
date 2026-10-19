# dsh-code-ctx

[![CI](https://github.com/y2187218823/dsh-code-ctx/actions/workflows/ci.yml/badge.svg)](https://github.com/y2187218823/dsh-code-ctx/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![runtime deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen.svg)](package.json)

**给 AI agent 一副「知道该看哪个文件」的眼睛。**

Agent 改 bug 时最大的瓶颈不是模型，是「该看哪几个文件」——给整个仓库会撑爆上下文，
只看当前文件又漏掉关键依赖。这个插件把「读哪些文件」从 O(全仓库) 降到 O(top-k)。

一个 DSH 插件：注册成 agent 工具（它会自己调用），同时提供斜杠命令与 HTTP 接口。

```
repo_search("notify session 过滤")
  → src/host/notify-events.ts:53-60   shouldNotifySession   (22.07)  [bm25 + 符号名 + 路径]
  → src/host/notify-events.ts:91-123  reduceNotifyFrame     (16.20)  [bm25 + 符号名 + 依赖图]
```

## 评测（vite，110 条真实 commit）

代码检索没有现成 benchmark，所以用 commit 自带的结构自建了一套：
**commit message 当查询，「这次改了哪些文件」当标准答案**——正好对应「问题 → 该改哪里」。

| k（读几个文件） | recall（全部真值） | recall（只算实现文件） |
|---|---|---|
| 4 | 0.357 | 0.633 |
| **8** | **0.431** | **0.724** |
| 16 | 0.542 | 0.834 |
| 32 | 0.644 | 0.899 |

`hit@8 = 0.809` —— 给一句改动意图，top-8 里至少命中一个真实改动文件的概率是 **81%**。

> 这张表才是这个东西的全部意义。没有它，下面所有设计都只是「我觉得这样更好」。

## 安装

```powershell
dsh plugin --profile desktop add file:D:/path/to/code-ctx
```

重启 DSH 后自动生效。索引根目录按优先级解析：

1. 请求参数 `?root=`
2. 环境变量 `DSH_CODE_CTX_ROOT`
3. `$DSH_HOME/code-ctx/config.json` 的 `{"root": "..."}`
4. 宿主进程 cwd

> **一定要配第 3 条。** 桌面版宿主的 cwd 通常不是你的项目目录，索引会是空的。

## 用法

| 入口 | 说明 |
|---|---|
| agent 工具 `repo_search` | agent 自己判断何时调用 |
| `/ctx <问题>` | 手动查询 |
| `/ctx build` | 强制重建索引 |
| `GET /dsh-code-ctx/search?q=...` | HTTP 查询 |
| `POST /dsh-code-ctx/index` | 强制重建 |
| `GET /dsh-code-ctx/stats` | 索引状态 |

也可以完全脱离 DSH 用 CLI：

```powershell
node bin/cli.js index <仓库路径> --out .code-ctx/demo.json
node bin/cli.js search "websocket hmr" --index .code-ctx/demo.json --top 8
```

## 工作原理

```
遍历文件 ──► 按符号切块 ──► 词元统计 + 依赖图 ──► 索引
                                    │
查询 ──► BM25 ──► 符号名/路径加权 ──► 依赖图扩散 ──► 排序去重
```

三个信号叠加：

- **BM25** —— 这段代码在讲什么
- **符号名加权** —— 搜 `parseConfig` 时，函数就叫这名字的必须排最前
- **依赖图扩散** —— 改 bug 常要看「谁调用了它」，正向 import + 反向被 import 都带出来

用正则 + 括号配对做切块，不依赖 tree-sitter（免编译原生模块）。代价见「已知局限」。

## 设计决策与踩过的坑

1. **不做向量检索（默认）**。实测用 `all-MiniLM-L6-v2` 融进来只涨 **3.3 个百分点**
   （recall 0.431→0.465），代价是索引 0.5s→115s、依赖 5MB→463MB。而且权重越高越差：
   α=1.0 时 recall 掉回 0.434 —— **向量在代码检索里只能当配角**，权重一高就把精确标识符匹配冲掉了。
   实验脚本保留在 `tools/embed-eval.mjs`。
2. **测试/类型声明要降权**。问「websocket hmr」时，`ws.d.ts` 和 playground 测试会把
   真正的 `server/ws.ts` 挤下去（它们「更爱提关键词」）。按路径降权后第 1 条就对了。
3. **构建产物要排除**。`lib/` 是打包后的单文件，和 `src/` 内容不同，内容哈希去重抓不到，
   同一个函数会占三个名额 → 存在 `src/` 时直接排除 `lib/ dist/ build/ out/`。
4. **评测口径差点骗了自己**。初版取 top-K 个*代码块*，去重成文件后往往不足 K 个，
   等于把「top-8 文件」压成「top-5 文件」。改成按文件数算之后 recall 从 0.369 到 0.431
   —— **指标定义错了，后面调什么都白费**。
5. **空索引要报出来**。根目录配错时索引是空的，工具只回「没命中」，看起来像检索质量差。
   现在会明确告诉你「索引是空的、根目录是哪儿、怎么改」。

## 已知局限

- 正则切块扛不住字符串/注释里的花括号，超长函数会被切歪
- 零词面重叠的语义查询召回差（「normalize served output files」→ `bundledDev.ts` 这类），
  这是纯词法检索的天花板
- 没有增量索引，每次全量重建（1412 文件约 0.5s，可接受）
- commit message 是作者视角，和用户描述症状的措辞分布不同，评测存在系统性偏差

## 路线图

- [ ] tree-sitter 切块
- [ ] 增量索引（按文件 hash 只重建变化的）
- [ ] 返回值直接带代码片段，省掉 agent 再读一次
- [ ] 查询改写：用小模型把自然语言意图扩成代码词汇

## License

MIT —— 见 [LICENSE](LICENSE)
