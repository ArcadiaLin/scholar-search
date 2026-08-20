# Search Service 字段说明

本文档列出三个上游 API 的原始返回字段、当前插件已提取的字段，以及聚合后的统一返回字段。供手动选择需要保留/扩展的字段时参考。

---

## 1. OpenAlex `/works` 原始字段

来源：[OpenAlex Work Object 文档](https://github.com/ourresearch/openalex-docs/blob/main/api-entities/works/work-object/README.md)

OpenAlex 的 `Work` 对象包含以下顶层字段（调用时不带 `select` 会全部返回）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | OpenAlex ID，URI 形式 |
| `doi` | string | DOI（含 `https://doi.org/` 前缀） |
| `title` | string | 论文标题 |
| `display_name` | string | 与 `title` 相同 |
| `publication_year` | int | 发表年份 |
| `publication_date` | string | 发表日期，ISO 8601 |
| `type` | string | 作品类型（article、preprint、review 等） |
| `raw_type` | string | 上游原始类型 |
| `abstract_inverted_index` | object | 摘要的倒排索引 |
| `authorships` | list | 作者及机构信息 |
| `primary_location` | object | 主要发表位置（landing_page_url、pdf_url、source 等） |
| `locations` | list | 所有可获取位置 |
| `best_oa_location` | object | 最佳 OA 位置 |
| `open_access` | object | OA 状态（is_oa、oa_status、oa_url） |
| `cited_by_count` | int | 被引次数 |
| `referenced_works` | list | 该论文引用的 OpenAlex ID 列表 |
| `related_works` | list | 相关论文 OpenAlex ID 列表 |
| `concepts` | list | 概念/主题标签 |
| `topics` | list | 主题（最多 3 个） |
| `primary_topic` | object | 排名第一的主题 |
| `keywords` | list | 关键词短语 |
| `biblio` | object | volume、issue、first_page、last_page |
| `counts_by_year` | list | 近十年每年的被引次数 |
| `citation_normalized_percentile` | object | 引用百分位 |
| `fwci` | float | Field Weighted Citation Impact |
| `grants` | list | 资助信息 |
| `mesh` | list | PubMed MeSH 标签 |
| `apc_list` / `apc_paid` | object | 文章处理费 |
| `indexed_in` | list | 索引来源 |
| `is_retracted` | bool | 是否被撤稿 |
| `is_paratext` | bool | 是否副文本 |
| `language` | string | 语言 ISO 639-1 |
| `license` | string | 许可证 |
| `ids` | object | 外部 ID 集合（openalex、doi、mag、pmid、pmcid、arxiv） |
| `corresponding_author_ids` | list | 通讯作者 ID |
| `corresponding_institution_ids` | list | 通讯机构 ID |
| `countries_distinct_count` | int | 不同国家数 |
| `institutions_distinct_count` | int | 不同机构数 |
| `locations_count` | int | locations 数量 |
| `sustainable_development_goals` | list | SDG 目标 |
| `created_date` / `updated_date` | string | 数据创建/更新时间 |

### 当前 OpenAlex 插件已提取的字段

代码位置：`src/search_service/plugins/openalex.py`

| 统一字段 | OpenAlex 原始字段 |
|----------|-------------------|
| `paper_id` | `doi` > `ids.arxiv` > `id` |
| `title` | `display_name` / `title` |
| `authors` | `authorships[].author.display_name` |
| `abstract` | 由 `abstract_inverted_index` 重建 |
| `published` | `publication_date` 或 `publication_year` |
| `year` | `publication_year` |
| `doi` | `doi` |
| `arxiv_id` | `ids.arxiv` |
| `openalex_id` | `id` |
| `urls.paper` | `primary_location.landing_page_url` |
| `urls.pdf` | `primary_location.pdf_url` 或 `open_access.oa_url` |
| `source` | 固定 `"openalex"` |
| `source_rank` | 结果在返回列表中的索引 |
| `raw` | 除已提取字段外的其他 OpenAlex 字段（保留 `ids` 中的 `mag`/`pmid`/`pmcid` 等，移除已提取的 `arxiv`） |

---

## 2. arXiv Atom API 原始字段

来源：[arXiv API User's Manual](https://arxiv.org/help/api/user-manual)

arXiv 返回 Atom feed，每个 `<entry>` 包含以下字段：

| 字段 | 说明 |
|------|------|
| `<title>` | 论文标题 |
| `<id>` | 论文 URI，如 `http://arxiv.org/abs/1706.03762` |
| `<published>` | 第一版提交时间 |
| `<updated>` | 当前版本提交时间 |
| `<summary>` | 摘要 |
| `<author>` / `<name>` | 作者名 |
| `<arxiv:affiliation>` | 作者机构（可选） |
| `<category>` | arXiv/ACM/MSC 分类 |
| `<arxiv:primary_category>` | 主分类 |
| `<arxiv:comment>` | 作者注释（可选） |
| `<arxiv:journal_ref>` | 期刊引用（可选） |
| `<arxiv:doi>` | DOI（可选） |
| `<link rel="alternate">` | 摘要页 HTML 链接 |
| `<link rel="related" title="pdf">` | PDF 链接 |
| `<link rel="related" title="doi">` | DOI 解析链接（可选） |

Feed 级元数据：`<opensearch:totalResults>`、`<opensearch:startIndex>`、`<opensearch:itemsPerPage>`。

### 当前 arXiv 插件已提取的字段

代码位置：`src/search_service/plugins/arxiv.py`

| 统一字段 | arXiv 原始字段 |
|----------|----------------|
| `paper_id` | 从 `<id>` 提取的 arXiv ID |
| `title` | `<title>` |
| `authors` | `<author><name>` 列表 |
| `abstract` | `<summary>` |
| `published` | `<published>` |
| `year` | 从 `<published>` 前 4 位解析 |
| `doi` | 暂未提取（当前占位，可从 `<arxiv:doi>` 扩展） |
| `arxiv_id` | 从 `<id>` 提取 |
| `urls.paper` | `https://arxiv.org/abs/{arxiv_id}` |
| `urls.pdf` | `https://arxiv.org/pdf/{arxiv_id}.pdf` |
| `urls.html` | `https://arxiv.org/html/{arxiv_id}` |
| `source` | 固定 `"arxiv"` |
| `source_rank` | 结果在返回列表中的索引 |
| `raw` | 除已提取字段外的其他 arXiv 字段，如 `<updated>`、`<category>`、`<arxiv:primary_category>`、`<arxiv:comment>`、`<arxiv:journal_ref>`、`<arxiv:doi>`、`<arxiv:affiliation>` |

---

## 3. Serper `/search` 原始字段

Serper.dev 返回标准 Google SERP JSON。常见顶层字段如下：

| 字段 | 说明 |
|------|------|
| `searchParameters` | 查询参数（q、gl、hl、type、num 等） |
| `organic` | 自然搜索结果列表 |
| `knowledgeGraph` | 知识图谱（如有） |
| `answerBox` | 答案框（如有） |
| `peopleAlsoAsk` | 相关问题 |
| `relatedSearches` | 相关搜索 |
| `topStories` | 顶部新闻 |
| `images` | 图片结果 |
| `videos` | 视频结果 |
| `places` | 地图/地点结果 |

`organic` 条目中的字段：

| 字段 | 说明 |
|------|------|
| `title` | 结果标题 |
| `link` | 结果链接 |
| `snippet` | 摘要片段 |
| `displayedLink` | 展示链接 |
| `position` | 排名位置 |
| `date` | 结果日期（如有） |
| `sitelinks` | 站点链接 |
| `rating` | 评分（如有） |

### 当前 Serper 插件已提取的字段

代码位置：`src/search_service/plugins/serper.py`

| 统一字段 | Serper 原始字段 |
|----------|-----------------|
| `paper_id` | 从 `link` 提取 DOI 或 arXiv ID，否则用 `serper:{link}` |
| `title` | `title` |
| `authors` | 未提取 |
| `abstract` | `snippet` |
| `published` / `year` | 未提取 |
| `doi` | 从 `link` 提取 |
| `arxiv_id` | 从 `link` 提取 |
| `urls.paper` / `urls.pdf` / `urls.html` | 根据 `link` 是否以 `.pdf` 结尾分配 |
| `source` | 固定 `"serper"` |
| `source_rank` | `organic` 列表中的索引 |
| `raw` | 除 `title`/`link`/`snippet` 外的其他 organic 字段，如 `displayedLink`、`position`、`date`、`sitelinks`、`rating` |

---

## 4. 聚合后的统一字段（`SearchResultItem`）

代码位置：`src/search_service/models.py`

| 字段 | 类型 | 说明 |
|------|------|------|
| `paper_id` | string | 跨源稳定 ID，优先级：DOI > arXiv ID > 源原生 ID |
| `title` | string | 论文标题 |
| `authors` | list[string] \| null | 作者列表 |
| `abstract` | string \| null | 摘要 |
| `published` | string \| null | 发表日期/年份 |
| `year` | int \| null | 发表年份 |
| `doi` | string \| null | DOI |
| `arxiv_id` | string \| null | arXiv ID |
| `openalex_id` | string \| null | OpenAlex ID |
| `urls` | object | `{paper, pdf, html}`，可能为 null |
| `source` | string | 结果来源插件名；单源结果为具体来源（如 `"openalex"`），多源合并后为 `"merged"` |
| `source_rank` | int \| null | 该结果在源内的原始排序 |
| `raw` | object \| null | 除已提取字段外，上游 API 返回的其余原始字段；多源合并时为 `{source: raw_data}` 字典 |

### 聚合时的字段合并规则

- 去重 key：`paper_id`；无 `paper_id` 时用归一化 title 兜底。
- 同一论文的多源结果会合并成一条，元数据优先级：`openalex` > `arxiv` > `serper`。
- URL 取并集，优先：`arxiv` PDF > `serper` link > `openalex` open_access/landing_page。
- `source` 字段：仅当多个源返回同一论文时才标记为 `"merged"`；单一来源时保留原始来源名。
- `raw` 字段：单一来源时保留该源整理后的原始字段；多源合并时保留 `{source: raw_data}`，便于追溯每个源返回的完整信息。

## 5. 最终 HTTP 响应字段（`SearchResponse`）

代码位置：`src/search_service/models.py`

| 字段 | 类型 | 说明 |
|------|------|------|
| `query` | string | 原始查询 |
| `mode` | string | `"metadata"` 或 `"fulltext"` |
| `results` | list[SearchResultItem] | 聚合去重后的结果 |
| `total` | int | `results` 的长度 |
| `source_counts` | object | 各来源贡献的结果数 |
| `errors` | list[SourceError] | 失败源及错误类型/消息 |
| `elapsed_ms` | int | 耗时毫秒 |
| `cached` | bool | 是否来自缓存 |

`SourceError` 字段：

| 字段 | 说明 |
|------|------|
| `source` | 插件名 |
| `error_type` | `timeout` / `rate_limit` / `auth` / `http` / `parse` / `disabled` / `unknown` |
| `message` | 错误描述 |

---

## 6. 待选扩展字段建议

如果你希望从 OpenAlex 中补充更多字段到统一 schema，常见可选字段包括：

- `cited_by_count`（被引量）
- `concepts` / `topics` / `keywords`（主题/关键词）
- `biblio`（卷期页码）
- `open_access.oa_status`（OA 状态）
- `is_retracted`（是否撤稿）
- `referenced_works` / `related_works`（引用/相关论文 ID 列表）
- `primary_location.source.display_name`（期刊/会议名）
- `language`

扩展方式：修改 `SearchResultItem` 增加字段，并在对应插件的解析函数中填充。
