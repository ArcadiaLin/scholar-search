本地启动一个 http 服务：编程语言不限，python 适合科学计算 + 算法设计，因此可以优先python

允许 widi extension register tool，访问这个服务，进行检索

这个检索服务，聚合了 openalex、arxiv、serper 等在线检索 API

并且作为信息检索服务，拥有类似 pagerank 等算法的 rerank 算法，明天和mj讨论

这个检索服务提供若干 endpoint 例如，

search/metadata
search/fulltext（相当于聚合过的 api，不需要体现出原始检索采用的 api）

目前只想到这两个

search service = ？(openalex api + arixiv api) hp

元数据 -> 共被引、耦合、被引量、作者h指数，等等，耦合到什么程度作为检索返回

pagerank，



