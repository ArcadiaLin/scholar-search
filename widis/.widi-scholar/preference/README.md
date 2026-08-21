# 偏好载体：布局与版本约定

这个目录是 $PH_k$ 的实际载体——形式化里"跨 episode 的偏好状态"在这个仓库里
就是这里的文件加上它们的 git 历史。为什么它不是一个代码模块，见
`docs/07-widi-mapping.md` §2.4。

本文件只讲**载体与约定**。条目内容是 S5 的事。

## 布局

```
widis/.widi-scholar/preference/
├── README.md        本文件。不注入任何 agent 的上下文。
└── np-agent.md      $NP_k^{agent}$：策略先验，逐条可读、可改、可关。
```

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
   一次 commit 只推进一个版本。
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
S3/S5 有一处没做对（`05-skill-decomposition.md` §0）。

## 一条纪律

这个文件里的条目是对策略**思想**的重述与重新分层，
**不得逐字复制** MetaScientist 的 skill 原文（`prototype.md` §7.3 末节的许可证前置条件）。
