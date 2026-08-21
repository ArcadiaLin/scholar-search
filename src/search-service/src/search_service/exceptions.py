"""Custom exceptions for the search service."""


class SearchServiceError(Exception):
    """Base exception for search service errors."""


class ConfigError(SearchServiceError):
    """Raised when configuration is invalid or cannot be loaded."""


class PluginError(SearchServiceError):
    """Raised when a source plugin fails to load or is misconfigured."""


class SourceError(SearchServiceError):
    """Raised when a source plugin encounters a runtime error during search."""

    def __init__(self, source: str, error_type: str, message: str) -> None:
        super().__init__(message)
        self.source = source
        self.error_type = error_type
        self.message = message


class LLMError(SearchServiceError):
    """Raised when an LLM provider encounters a runtime error."""


class LLMConfigError(ConfigError):
    """Raised when LLM provider configuration is invalid."""
