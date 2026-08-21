<!-- npj-version: 1 -->

# 判别准则先验

这份文件是**判别**策略的载体——$NP_k^{judge}$。它与检索策略（`np-agent.md`）分开，
因为两者的消费者不同：`np-agent.md` 注入检索 agent 的系统提示词，
本文件由 Search Service 读取，经 `Configure` 进入 $\theta^S_k$，
出现在判别层发给模型的 prompt 里。通路见 `../../../docs/develop/decisions.md` D-24。

改本文件等于**换评测口径**。判别层把本文件的内容哈希进 `criteria_version`，
所以任何改动都会让新的判别结果与旧的不可比——这不是副作用，是要求：
`../../../docs/prototype.md` §4.2 明说"准则文本与权重随 `criteria_version` 冻结，
改准则等于换评测口径"。

条目里**不含任何阈值、切点或篇数**。四档的切点（0.25 / 0.67 / 0.99）、
判别篇数（$N_{judge}$）、temperature 都属于 $HP_k$，在 `config.yaml` 的 `judge:` 段。
这里只写语义：怎么派生准则、怎么判一档、什么算证据。

条目格式与 `np-agent.md` 一致：

```
- [id] 条目正文。
  <!-- observable: 判别输出里哪个字段会因它而变，或 none -->
```

## 怎么派生准则

- [derive-from-the-question-not-the-field] 准则要从**这一个提问**派生，
  不是从它所属的领域派生。"关于语义分割"不是准则，它对整个领域为真；
  "把超像素当作分割的基本单元"是准则，因为一篇论文可以明确不满足它。
  一条对所有候选都为真的准则不产生区分度，只消耗预算。
  <!-- observable: criteria 的条数与文本 -->

- [split-the-conjunctions] 提问里的每一个连接词通常藏着一条独立准则。
  "用图像块和超像素做基于区域的分割"至少是三条：用图像块、用超像素、
  方法是基于区域的。合成一条会让一篇只满足其中之一的论文拿到
  和满足全部的论文相近的分数。
  <!-- observable: criteria 的条数 -->

- [name-the-task-explicitly] 任务本身总是一条准则，即使提问没有强调它。
  一篇方法对但任务不对的论文（同样的超像素技巧用在别的任务上）
  是最容易被词面相似度放过去的一类，而它不是答案。
  <!-- observable: criteria 里是否存在任务准则 -->

- [weight-by-what-the-asker-emphasised] 权重跟着提问的重心走，不平均分配。
  提问里作为中心名词出现的东西权重高，作为修饰语出现的权重低。
  但**不要把任何一条压到零**——那等于把它从准则里删掉，
  而删掉一条准则和给它零权重在 `criteria_version` 上是两件不同的事。
  <!-- observable: criteria 的 weight 分布 -->

- [do-not-derive-from-the-candidates] 准则只看提问，不看候选集。
  看过候选之后写准则，写出来的是"这批结果的共同点"，
  于是判别层会给自己的召回打高分。
  <!-- observable: none — 这是对派生过程的约束，输出里看不出来 -->

## 怎么判一档

- [grade-against-the-criterion-alone] 每条准则单独判，不看别的准则的结果，
  也不看同批的其他候选。判别的输入按设计就是（一条准则，一篇的证据文本），
  没有同批其他候选——因为一旦能比较，模型给出的就是排名而不是判断，
  而排名在不同批次之间不可比。
  <!-- observable: criteria 里每条的 relevance 相互独立 -->

- [evidence-decides-the-grade] 找不到逐字证据就不给高档。
  一篇论文"看起来应该"满足某条准则，与它的摘要里能指出满足在哪里，
  是两种不同的情况；前者最高只能是 Somewhat Relevant。
  <!-- observable: 每条准则的 snippet 是否非空 -->

- [absent-is-not-negative] 摘要里没提到，不等于论文不满足。
  摘要是有长度限制的，方法细节经常不在里面。这种情况判 Somewhat Relevant
  并在 snippet 里说明"摘要未涉及"，不要判 Not Relevant——
  后者是"这篇明确做的是别的事"才用的档。
  <!-- observable: relevance 的分布 -->

- [wrong-task-is-not-relevant] 方法对、任务错，判 Not Relevant，不是 Somewhat。
  这一条与上一条是一对：**缺信息**往中间靠，**信息明确且不符**往下走。
  把两者混在一起，判别层就失去了它唯一比词面相似度强的地方。
  <!-- observable: relevance 的分布 -->

## 什么算证据

- [snippet-must-be-verbatim] snippet 必须从证据文本里逐字复制。
  改写过的片段无法核对，而无法核对的证据在归因分析里等于没有证据。
  <!-- observable: snippet 是否为证据文本的子串 -->

- [snippet-should-be-short] 尽量短——一句话以内，需要跨句时用 ` ... ` 拼接。
  一段长引文说明的是"这一整段有关系"，而准则问的是"哪一句让它满足"。
  <!-- observable: snippet 的长度 -->
