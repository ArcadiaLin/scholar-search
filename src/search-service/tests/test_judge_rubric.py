"""The rubric: labels, weighted composition, cut points.

Pure arithmetic, and it is in code rather than in the model on purpose - which is
what these tests are really pinning down. If the composition lived in the prompt,
"the same grades give the same tier" would be a hope rather than a property.
"""

from __future__ import annotations

import pytest

from search_service.judge.rubric import (
    RELEVANCE_GRADES,
    RUBRIC_VERSION,
    Criterion,
    compose_score,
    grade_of,
    normalize_weights,
    tier_of,
)


def test_the_four_labels_and_their_grades():
    assert RELEVANCE_GRADES == {
        "Perfectly Relevant": 3,
        "Highly Relevant": 2,
        "Somewhat Relevant": 1,
        "Not Relevant": 0,
    }
    assert RUBRIC_VERSION == "r3"


def test_an_unknown_label_is_none_rather_than_zero():
    # Zero would be a verdict; None says the model answered a different question.
    assert grade_of("Quite Relevant") is None
    assert grade_of(" Highly Relevant ") == 2


def test_composition_is_the_weighted_mean_of_grades_over_three():
    criteria = [Criterion("a", "", 0.5), Criterion("b", "", 0.5)]
    # 3/3 * 0.5 + 0/3 * 0.5
    assert compose_score(criteria, {"a": 3, "b": 0}) == pytest.approx(0.5)
    assert compose_score(criteria, {"a": 3, "b": 3}) == pytest.approx(1.0)
    assert compose_score(criteria, {"a": 0, "b": 0}) == 0.0


def test_composition_is_capped_at_one():
    criteria = [Criterion("a", "", 2.0)]
    assert compose_score(criteria, {"a": 3}) == 1.0


def test_a_missing_grade_contributes_nothing():
    # And that is exactly why `judge_one` refuses an incomplete answer instead of
    # composing over the gap: here the gap silently reads as a zero.
    criteria = [Criterion("a", "", 0.5), Criterion("b", "", 0.5)]
    assert compose_score(criteria, {"a": 3}) == pytest.approx(0.5)


@pytest.mark.parametrize(
    ("score", "tier"),
    [
        (0.0, "not_relevant"),
        (0.24, "not_relevant"),
        (0.25, "somewhat_relevant"),
        (0.66, "somewhat_relevant"),
        (0.67, "highly_relevant"),
        (0.98, "highly_relevant"),
        (0.99, "perfectly_relevant"),
        (1.0, "perfectly_relevant"),
    ],
)
def test_the_cut_points_are_prototype_4_2s(score, tier):
    assert tier_of(score) == tier


def test_one_criterion_at_highly_relevant_lands_just_under_the_highly_relevant_cut():
    """A consequence of §4.2's cut points, spelled out so nobody "fixes" it.

    2/3 = 0.6667 < 0.67, so with a single criterion only "Perfectly Relevant"
    reaches the upper two tiers. That is what the specified cuts say; the place to
    change it is the cut points, deliberately, not a rounding tweak here.
    """
    single = [Criterion("a", "", 1.0)]
    assert compose_score(single, {"a": 2}) == pytest.approx(2 / 3)
    assert tier_of(compose_score(single, {"a": 2})) == "somewhat_relevant"
    assert tier_of(compose_score(single, {"a": 3})) == "perfectly_relevant"


def test_weights_are_normalized_so_a_tier_means_the_same_across_queries():
    # Without this, the cut points would mean different things for a three-criterion
    # query and an eight-criterion one, and their tiers could not be averaged.
    three = normalize_weights([Criterion(f"c{i}", "", 1.0) for i in range(3)])
    eight = normalize_weights([Criterion(f"c{i}", "", 1.0) for i in range(8)])
    assert sum(c.weight for c in three) == pytest.approx(1.0)
    assert sum(c.weight for c in eight) == pytest.approx(1.0)
    # All criteria satisfied is a perfect score either way.
    assert compose_score(three, dict.fromkeys((c.key for c in three), 3)) == pytest.approx(1.0)
    assert compose_score(eight, dict.fromkeys((c.key for c in eight), 3)) == pytest.approx(1.0)


def test_normalization_keeps_relative_importance():
    weights = {c.key: c.weight for c in normalize_weights([Criterion("a", "", 3.0), Criterion("b", "", 1.0)])}
    assert weights["a"] == pytest.approx(0.75)
    assert weights["b"] == pytest.approx(0.25)


def test_all_zero_weights_fall_back_to_equal_shares():
    # A carrier entry says not to zero a criterion out; if one arrives anyway, an
    # equal share is better than a division by zero or a silent all-zero score.
    weights = normalize_weights([Criterion("a", "", 0.0), Criterion("b", "", 0.0)])
    assert [c.weight for c in weights] == [0.5, 0.5]
