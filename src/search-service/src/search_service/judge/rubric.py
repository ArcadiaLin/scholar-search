"""The grading rubric: labels, weighted composition, and the four tiers.

``docs/prototype.md`` §4.2 specifies this precisely, and the specification is
followed rather than reinvented. Two parts of it are load-bearing:

**No total score.** The model grades each derived criterion separately and the
composition happens here, in code. That buys three things a single "how relevant
is this, 0-1" question cannot: the answer is **attributable** (which criterion
failed is a fact, not an inference), the criteria can be **weighted** by
importance, and each criterion can demand its own evidence snippet.

**The composition is arithmetic, not judgement.**

$$
s_{\\mathrm{judge}}(p) = \\min\\Big(1, \\sum_{c} w_c \\cdot \\frac{r_c(p)}{3}\\Big)
$$

then discretised at 0.25 / 0.67 / 0.99 back into four tiers, the same four the
training labels use. Keeping this out of the model is what makes a re-run with the
same cached grades produce the same tier.
"""

from __future__ import annotations

from dataclasses import dataclass

#: Bumped when the label set, the composition, or the cut points change. A stored
#: judgement is only comparable to another with the same rubric version.
RUBRIC_VERSION = "r3"

#: The four labels, and the 0-3 grade each denotes. Spelled as the model is asked
#: to spell them, because the parser matches on this text.
RELEVANCE_GRADES: dict[str, int] = {
    "Perfectly Relevant": 3,
    "Highly Relevant": 2,
    "Somewhat Relevant": 1,
    "Not Relevant": 0,
}

#: Composite-score cut points, ``prototype.md`` §4.2. Read as: below 0.25 is not
#: relevant, and only a near-perfect composite earns the top tier.
TIER_CUTS: tuple[float, float, float] = (0.25, 0.67, 0.99)

TIERS = ("not_relevant", "somewhat_relevant", "highly_relevant", "perfectly_relevant")

#: The tiers a `RankedPaper` can carry. The judge's four collapse onto these three
#: because the ranked-paper contract predates the rubric and is not S12's to change.
RANKED_TIER_BY_JUDGE_TIER: dict[str, str] = {
    "perfectly_relevant": "highly_relevant",
    "highly_relevant": "highly_relevant",
    "somewhat_relevant": "partially_relevant",
    "not_relevant": "not_relevant",
}


@dataclass(frozen=True)
class Criterion:
    """One derived criterion: what to check, and how much it counts."""

    key: str
    description: str
    weight: float


@dataclass(frozen=True)
class CriterionGrade:
    """One criterion's verdict for one paper."""

    key: str
    relevance: str
    grade: int
    #: Verbatim from the paper, and short. A paraphrase is not evidence.
    snippet: str


def grade_of(relevance: str) -> int | None:
    """The 0-3 grade for a label, or ``None`` when the label is not one of ours.

    ``None`` rather than a default: a label the rubric does not define means the
    model answered a different question, and scoring it as zero would bury that.
    """
    return RELEVANCE_GRADES.get(relevance.strip())


def compose_score(criteria: list[Criterion], grades: dict[str, int]) -> float:
    """The weighted composite of per-criterion grades, capped at 1.

    A criterion with no grade contributes nothing. That is deliberate and it is
    why ``judge_one`` refuses a paper whose grades are incomplete instead of
    composing over the gap: a missing criterion would silently read as a zero.
    """
    total = 0.0
    for criterion in criteria:
        grade = grades.get(criterion.key)
        if grade is None:
            continue
        total += criterion.weight * (grade / 3.0)
    return min(1.0, total)


def tier_of(score: float) -> str:
    """Discretise a composite score back into one of the four tiers."""
    low, mid, high = TIER_CUTS
    if score < low:
        return "not_relevant"
    if score < mid:
        return "somewhat_relevant"
    if score < high:
        return "highly_relevant"
    return "perfectly_relevant"


def normalize_weights(criteria: list[Criterion]) -> list[Criterion]:
    """Rescale weights to sum to 1, so a tier means the same thing across queries.

    Without this the cut points would mean different things for a query with three
    criteria and one with eight, and two queries' tiers would not be comparable -
    which is the whole basis on which they are averaged.
    """
    total = sum(max(0.0, criterion.weight) for criterion in criteria)
    if total <= 0:
        share = 1.0 / len(criteria) if criteria else 0.0
        return [Criterion(c.key, c.description, share) for c in criteria]
    return [Criterion(c.key, c.description, max(0.0, c.weight) / total) for c in criteria]
