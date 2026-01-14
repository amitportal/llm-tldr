#!/usr/bin/env python3
"""
TLDR Brain - Standalone Script Wrapper

This script wraps the tldr.brain module for standalone execution.
For pip installations, use: tldr brain build [path]

Usage:
    python scripts/build_brain.py [path] [-o OUTPUT] [--lang LANG]
    
Examples:
    # Build for current directory
    python scripts/build_brain.py .
    
    # Build for specific path
    python scripts/build_brain.py /path/to/project
    
    # Custom output
    python scripts/build_brain.py . -o brain.json
"""

import sys
from pathlib import Path

# Add parent directory to path for local development
scripts_dir = Path(__file__).parent
project_root = scripts_dir.parent
if str(project_root) not in sys.path:
    sys.path.insert(0, str(project_root))

# Import from the canonical module
from tldr.brain import build_brain_for_project, main

# Re-export for backwards compatibility
__all__ = ['build_brain_for_project']


if __name__ == "__main__":
    main()
