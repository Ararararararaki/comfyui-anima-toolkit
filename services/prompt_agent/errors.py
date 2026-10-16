"""Errors safe to display in the node and HTTP responses."""


class AgentError(ValueError):
    """An operation failed without committing a new working prompt."""


class SessionConflict(AgentError):
    """A stale or concurrent edit needs the current revision before retrying."""
