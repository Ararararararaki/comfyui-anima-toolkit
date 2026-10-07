"""Stable resource root for relocated backend implementations.

Data remains in the installation root; moving code never migrates user files.
"""
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent

def plugin_root():
    return str(PLUGIN_ROOT)
