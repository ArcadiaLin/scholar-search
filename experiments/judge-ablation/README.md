# judge-ablation：J0 对 J2 的判别消融

一条命令，两个 arm，同一个召回集：

```bash
# Search Service 要在跑（judge_level 由请求决定，不需要改 config）
uv run python experiments/judge-ablation/run.py \
  --queries experiments/judge-ablation/queries.accept.json \
  --k 10 --out runs/judge-ablation/<name>
```

| arm | `judge_level` | 是什么 |
| --- | --- | --- |
| J0 | `off` | RRF 融合给出的召回顺序 |
| J2 | `l3b` | **同一批候选**，按加权准则逐条判别后重排 |

## 为什么两组必须一起报

`../../docs/prototype.md` §6 把这件事写成硬要求，而 `../../docs/develop/plan.md`
§5.6 说明它对本项目**不是理论风险**：AutoScholarQuery 的 gold 是 LLM 从论文相关工作
章节生成的。用 LLM judge 去排一个 LLM 生成的 gold，J2 相对 J0 的提升里会混进
一部分同源偏差。**只报 J2 的数字是在报一个含未知偏差的量。**

这也是本目录存在的唯一理由——如果只需要"接上判别器之后分数变高了"，
`experiments/eval-runner` 就够了。

## 三个容易读错的地方

**`k` 必须小于候选集。** 若 $k \ge$ 候选数，两组的 top-$k$ 是同一个集合，
Recall@k 必然相同，与判别器好坏无关。默认 `--k 10`，而召回上限跟着
`config.yaml` 的 `judge.max_papers_l3b`（30）走。见 D-27——第一次跑的时候
正是撞在这上面。

**查询是夹具，不是数据集问句。** `queries.accept.json` 里每条同时有
`query`（原问句，进记录）与 `searchQuery`（实际发出的）。覆盖是必须的：
原问句在当前实现下召回为 0（F-12 的 OpenAlex 400、F-13 的长句 AND 过严），
两组都是 0 分，比较无信息。记录里两者都留，所以这些数字不会被读成
"数据集问句上的成绩"。见 D-26。

**这不是端到端数字。** 它测判别器对排序做了什么，不测 agent 带着判别器做得如何。
后者在 `../eval-runner/`。两者不能互相替代，也不能混着报。

## 记录了什么

`ablation.json`：每条查询、每个 arm 的

- `judge`：完整的判别账目——`level` / `requested_level` / `supported` /
  `considered` / `judged` / `cache_hits` / `rubric_version` / `criteria_version` /
  `model_version`。三个 version 是"这个数字的测量仪器是什么"的答案；
- `score`：`order`（top-k 的有序 id，**这是"两组分数相同"与"判别器什么都没改"
  的区分依据**）、`hits` / `missed` / `recall` / `precision` / `f1`、
  以及 `unscorable_predictions`（提交了但不带 arXiv id、因此无法对这份 gold
  计分的条数——剔除它们会虚高 precision）；
- `failures`：Service 侧的分类失败，原样带出。失败不静默剔除。

`runs/` 在 `.gitignore` 里；本目录只提交脚本与夹具。
