# Multi-stage build for the Scholar Search Service.

FROM python:3.12-slim AS builder

WORKDIR /app

# Install uv.
RUN pip install --no-cache-dir uv

# Copy dependency metadata and install into a virtual environment.
COPY pyproject.toml uv.lock ./
RUN uv sync --no-dev

# ---

FROM python:3.12-slim AS runtime

WORKDIR /app

# Copy the virtual environment from the builder stage.
COPY --from=builder /app/.venv /app/.venv

# Copy application code and default configuration.
COPY src ./src
COPY config.yaml ./config.yaml

# Activate the virtual environment.
ENV PATH="/app/.venv/bin:$PATH"
ENV PYTHONPATH="/app/src"

EXPOSE 8000

CMD ["uvicorn", "search_service.main:app", "--host", "0.0.0.0", "--port", "8000"]
