"""Prompt Agent adapter for the shared installed WD14 engine."""
try:
    from ... import local_tagger as _engine
except ImportError:  # Standalone offline contract tests use a synthetic Agent package.
    from services import local_tagger as _engine
from ..errors import AgentError

available_models = _engine.available_models

async def interrogate_wd14(image: bytes, options: dict) -> dict:
    try:
        return await _engine.interrogate_wd14(image, options)
    except _engine.LocalTaggerError as error:
        raise AgentError(str(error)) from None
