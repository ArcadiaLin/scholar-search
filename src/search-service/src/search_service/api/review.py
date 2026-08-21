"""Sidecar Reviewer configuration.

``GET /review-config`` returns the detector thresholds the scholar-search
extension needs, and nothing else. It exists because those thresholds are $HP_k$
and ``config.yaml`` is their only authoritative carrier, while their consumer is a
TypeScript extension whose only other configuration channel is environment
variables (``docs/develop/decisions.md`` D-15).

**This endpoint is data, not behaviour.** The detectors themselves stay in the
extension: they read ``PublicSearchTrace``, a type assembled from WIDI's event
stream, and mirroring that schema here would bind this service to WIDI's event
shape - which is exactly what ``docs/search-service.md`` opens by forbidding.
Thresholds are cheap to send across a process boundary; a trajectory is not.
"""

from __future__ import annotations

from fastapi import APIRouter, Request

from search_service.schemas import ReviewConfigResponse

router = APIRouter(tags=["review"])


@router.get("/review-config", response_model=ReviewConfigResponse)
async def get_review_config(request: Request) -> ReviewConfigResponse:
    """Return the Reviewer detector thresholds in force."""
    thresholds = request.app.state.config.get_review_config()
    return ReviewConfigResponse(
        thresholds=thresholds,
        # Said out loud because it decides how much a tuned number is worth: none
        # of these is derived from anything yet (``docs/reviewer-design.md`` §8).
        provenance="config.yaml `review:` section; values are placeholders pending an HP search",
    )
