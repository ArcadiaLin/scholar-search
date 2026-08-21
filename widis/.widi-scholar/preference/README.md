# 偏好载体：布局与版本约定

这个目录是 $PH_k$ 的实际载体——形式化里"跨 episode 的偏好状态"在这个仓库里
就是这里的文件加上它们的 git 历史。为什么它不是一个代码模块，见
`docs/develop/mapping.md` §2.4。

本文件只讲**载体与约定**。条目内容是 S5 的事。

## 布局

```
widis/.widi-scholar/preference/
├── README.md        本文件。不注入任何 agent 的上下文。
├── np-agent.md      $NP_k^{agent}$：检索策略先验，逐条可读、可改、可关。
└── np-judge.md      $NP_k^{judge}$：判别准则先验。
```

**两个载体的消费者不同，这决定了它们的通路不同**：

| | `np-agent.md` | `np-judge.md` |
| --- | --- | --- |
| 谁读 | 检索 agent | Search Service 的判别层 |
| 怎么到 | `profiles/search.md` 的 `projectContext`，进系统提示词 | `config.yaml` 的 `judge.carrier` 指针，进判别 prompt |
| 版本行 | `<!-- np-version: k -->` | `<!-- npj-version: k -->` |
| 版本的作用 | 标记条目集合的第几版 | 同上，**另外**：判别层把文件内容哈希进 `criteria_version` |

第二个载体为什么不直接写进 `config.yaml`：那会抹掉 `Configure` 这条边——
$NP^{judge}$ 与 $HP$ 就成了同一个东西。理由全文见
`../../../docs/develop/decisions.md` **D-24**。

`np-agent.md` 由 `profiles/search.md` 的 `projectContext` 引用：

```yaml
projectContext: [preference/np-agent.md]
```

路径相对 agent dir（`widis/.widi-scholar/`）解析。WIDI 的资源加载顺序是
agent dir 优先、然后 cwd 及其祖先目录，所以这个相对路径落在本目录内，
不会被仓库根目录下的同名文件影响。

`README.md` **不**在 `projectContext` 里，因此不进任何 agent 的上下文。
这是刻意的：约定是给人看的，不该占 Agent 的上下文预算。

## 版本怎么表示

`np-agent.md` 的正文第一行有一个版本行：

```
<!-- np-version: 0 -->
```

约定：

1. **版本号是单调整数**，从 `0` 开始。`0` 表示"载体已存在，但还没有任何条目"——
   也就是 S4 结束时的状态。
2. **每次改动条目就 +1**，并且**单独一个 commit**，message 首行包含 `[NP v<k>]`。
   一次 commit 只推进一个版本。这条与"一个 stage 一个 commit"冲突时，
   本条优先——理由见 `../../../docs/develop/decisions.md` **D-23**。
   **唯一的例外是载体的第 1 版**：它没有前一版可 diff，
   而且新载体通常与读它的代码同时才有意义，所以 v1 可以与代码同一个 commit。
3. 版本号只在**条目集合**变化时推进。改错别字、调整本文件的说明文字不算。

为什么用注释而不是 YAML frontmatter：这个文件会被整体注入系统提示词，
frontmatter 会被原样注入成一段看起来像元数据的噪音。HTML 注释在 markdown 里
同样是可见文本，但读起来是一行说明而不是一段结构。

## 怎么回放到某一版

版本存储就是 git，没有第二份。

```bash
# 第 k 版是哪个 commit
git log --oneline -- widis/.widi-scholar/preference/np-agent.md
git log --oneline --grep='\[NP v3\]' -- widis/.widi-scholar/preference/np-agent.md

# 看第 k 版的内容
git show <commit>:widis/.widi-scholar/preference/np-agent.md

# 在工作区回放到第 k 版（只动这一个文件）
git checkout <commit> -- widis/.widi-scholar/preference/np-agent.md

# 两版之间差了什么
git diff <commit-v2> <commit-v3> -- widis/.widi-scholar/preference/np-agent.md
```

最后一条是这套约定真正要保住的东西：**"第 2 版和第 3 版差在哪"必须是一个
`git diff` 就能回答的问题**。这也是为什么载体是 markdown 而不是序列化状态。

## 怎么关掉一条 / 全部

逐条关闭是 `prototype.md` §7.3 要求的形式，也是 S5 消融实验的操作面：

- **关掉一条**：把该条目行首加 `<!-- off -->` 前缀（保留文本，便于 diff 看出
  是被关掉而不是被删掉）。
- **关掉全部**：把 `projectContext` 从 `profiles/search.md` 里去掉，
  或者把条目区整段注释掉。前者更干净，因为它同时证明了"载体被移除时
  agent 行为确实变化"。

S5 的验收判据是：**全关 vs 全开，同一查询的轨迹形状明显不同**。
如果没有差别，说明策略还藏在 profile body 或工具序列里，
S3/S5 有一处没做对（`docs/skill-decomposition.md` §0）。

## 写作规程

三条纪律。第一条是许可证问题，后两条来自 2026-08-21 的三次会话，
每一条都有一次真实的违反或拦截作依据（`../../../docs/reviewer-design.md` §3.1）。

### 纪律一：不得逐字复制上游 skill

这个文件里的条目是对策略**思想**的重述与重新分层，
**不得逐字复制** MetaScientist 的 skill 原文（`prototype.md` §7.3 末节的许可证前置条件）。

### 纪律二：不带着答案找问题

从一次失败的会话里提炼条目时，人是看得见标准答案的，
于是很容易写出一条"看起来通用、实际是从答案倒推"的条目。

**这真实发生过并被当场拦下。** agent 在 98ar 会话末尾提炼的第一条是：

> 当问题中提到 region-based methods for X 时……要考虑它可能指的是
> region-based **active learning**——即用区域/超像素来做主动学习的样本选择。

这条写进本文件后，在那道题上会立刻"生效"，但它学到的不是策略，
是**那一道题的答案**。用户当时的一句"不要"就是一次手工的反泄漏检查。

**可执行的判据**：条目里出现的每一个领域术语，
都必须在**问题原文或该次轨迹**里出现过。
标准答案里有、轨迹里没有的词，不得进入条目。

这一条目前只能靠人执行——判断一个术语来自哪里需要那次会话的上下文。
下面的纪律三是它可自动化的那一半。

### 纪律三：$t$ 尺度可以针对本查询，$k$ 尺度不可以

Reviewer 在 episode 内给出的建议（$A_t$）**可以且应该**具体到本查询：
"去试这个完整短语"是合法建议。而本文件里的条目是 $NP_k$，跨 episode 复用，
**必须**是通用策略——不得包含具体论文标题、arXiv id，或某个具体查询串。

这一条有 lint：`node scripts/preference-lint.mjs` 检查
`preference/np-*.md` 的条目正文里不出现 arXiv id 形态的字符串
（`2101.00001`、`arXiv:2101.00001`、`10.48550/arXiv....`）。
`npm run check` 会跑它。标注 `kind: example` 的条目豁免，但必须带 `origin`。

lint 只能拦住 id 这一种形态；一条含具体标题或具体查询串的条目它拦不住，
那仍然要靠评审。

## 条目分组（A / B）

`np-agent.md` 从第 2 版起分成两组，判据一句话：
**一条条目可绑定，当且仅当关掉它会让轨迹不同。**

- **A 组**带 `observable:` 元数据，指明它断言 $\bar{\tau}_t$ 的哪个字段。
  偏好实验的消融**只作用于这一组**。
- **B 组**标 `observable: none` 并写清为什么绑不了，**排除在消融之外**。

为什么不是"精简到 N 条"：原来的问法问错了，答案不该是一个数字而该是一个划分。
这样处理不丢失条目的出处，消融作用在一个良定义的集合上，
而"把某条从 B 提到 A"成了一条可增量推进的工作队列。

值得注意的是，这与消融实验本身的判据是同一条——
如果一批条目多数不可绑定，"全部关掉后轨迹不变"就是**预期结果**，
而不是实现出了问题。
