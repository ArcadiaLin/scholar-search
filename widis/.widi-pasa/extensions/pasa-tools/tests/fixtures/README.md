# pasa-tools 测试 fixture

真实响应，录制于 2026-08-15。测试默认不联网（`AGENTS.md` §7），
这些文件是三个解析器的唯一输入。

| 文件 | 来源 | 用途 |
| --- | --- | --- |
| `arxiv-id-list.xml` | `https://export.arxiv.org/api/query?id_list=2501.10120,2009.02040&max_results=2` | Atom 多条目解析 |
| `arxiv-title-search.xml` | `https://export.arxiv.org/api/query?search_query=ti:"Multivariate Time-series Anomaly Detection via Graph Attention Network"&start=0&max_results=5&sortBy=relevance` | 标题搜索与精确匹配判定 |
| `arxiv-empty-feed.xml` | `https://export.arxiv.org/api/query?id_list=9999.99999&max_results=1` | 不存在的 ID：arXiv 返回 **200 加空 feed**，不是 404 |
| `ar5iv-2307.00235.html` | `https://ar5iv.labs.arxiv.org/html/2307.00235` | ar5iv 章节与引用抽取。这是官方 `utils.py` 末尾自测用的同一篇论文 |
| `serper-search.json` | `POST https://google.serper.dev/search`，`q` 为 `graph attention network multivariate time series anomaly detection before:2023-10-24 site:arxiv.org`，`num: 10` | serper 响应归约为 arXiv 命中；10 条 organic 中有一条重复 ID |

重新录制时必须同步更新本表的日期和查询，并复核受影响的断言：
fixture 变了而断言没动，等于把回归当成了通过。

`serper-search.json` 不含任何凭据——API key 只出现在请求头，不在响应体里。

覆盖不到的边界（限流、超时、字段缺失、畸形链接）用测试内构造的
最小输入表达，不需要录制。

本目录被 `scripts/widis-quality.mjs` 整体排除在 lint 与 format 之外。
这些是录制的字节，不是源码：`npm run format` 一旦改写它们，
测试断言的就不再是 ar5iv 真实返回的东西。
（biome 确实会去 lint ar5iv 页面内联的 `<script>`，那不是我们的代码。）
