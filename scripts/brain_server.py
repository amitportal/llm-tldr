#!/usr/bin/env python3
"""
TLDR Brain Server - Wrapper for backwards compatibility

This script wraps the tldr.brain_server module for standalone execution.
For pip installations, use: tldr brain serve [path]

Usage:
    python scripts/brain_server.py
"""

import sys
from pathlib import Path

# Add parent directory to path for local development
scripts_dir = Path(__file__).parent
project_root = scripts_dir.parent
if str(project_root) not in sys.path:
    sys.path.insert(0, str(project_root))

# Import from the canonical module
from tldr.server import create_app

if __name__ == "__main__":
    app = create_app()
    app.run(debug=True, port=5000)
