#!/usr/bin/env python3
"""Fix domain file import paths and missing helpers."""

import re
import subprocess
from pathlib import Path

DOMAINS_DIR = Path("src/core/tools/domains")
INTERNAL = Path("src/core/tools/internal.ts")

def find_undefined_identifiers(file_path: Path) -> set:
    """Run typecheck, parse errors, find undefined identifiers in this file."""
    result = subprocess.run(
        ["npx", "tsc", "--noEmit"],
        capture_output=True, text=True, timeout=60
    )
    errors = result.stdout
    undefined = set()
    for line in errors.split("\n"):
        # Match: src/core/tools/domains/admin.ts(173,28): error TS2304: Cannot find name 'tools'.
        m = re.match(rf"{re.escape(str(file_path))}\(\d+,\d+\): error TS2304: Cannot find name '(\w+)'", line)
        if m:
            undefined.add(m.group(1))
    return undefined

def find_missing_modules(file_path: Path) -> set:
    """Run typecheck, find missing module imports in this file."""
    result = subprocess.run(
        ["npx", "tsc", "--noEmit"],
        capture_output=True, text=True, timeout=60
    )
    errors = result.stdout
    missing = set()
    for line in errors.split("\n"):
        m = re.match(rf"{re.escape(str(file_path))}\(\d+,\d+\): error TS2307: Cannot find module '([^']+)'", line)
        if m:
            missing.add(m.group(1))
    return missing

def get_all_helpers_in_internal() -> set:
    """Get all exported names from internal.ts."""
    text = INTERNAL.read_text()
    # Find all `export function/const/let NAME`
    names = set()
    for m in re.finditer(r'^export\s+(?:async\s+)?function\s+(\w+)', text, re.M):
        names.add(m.group(1))
    for m in re.finditer(r'^export\s+const\s+(\w+)', text, re.M):
        names.add(m.group(1))
    for m in re.finditer(r'^export\s+let\s+(\w+)', text, re.M):
        names.add(m.group(1))
    return names

ALL_HELPERS = get_all_helpers_in_internal()
print(f"Found {len(ALL_HELPERS)} exports in internal.ts")

def fix_import_paths():
    """Fix `./internal.ts` → `../internal.ts` in all domain files."""
    for f in DOMAINS_DIR.glob("*.ts"):
        text = f.read_text()
        new_text = text.replace('from "./internal.ts"', 'from "../internal.ts"')
        if new_text != text:
            f.write_text(new_text)
            print(f"  fixed path in {f.name}")

def find_used_identifiers(file_path: Path) -> set:
    """Find all identifiers used in the file that match known helpers."""
    text = file_path.read_text()
    # Strip strings and comments
    text = re.sub(r'"(?:[^"\\]|\\.)*"', '""', text)
    text = re.sub(r"'(?:[^'\\]|\\.)*'", "''", text)
    text = re.sub(r"`(?:[^`\\]|\\.)*`", "``", text)
    text = re.sub(r"//[^\n]*", "", text)
    text = re.sub(r"/\*[\s\S]*?\*/", "", text)
    found = set(re.findall(r'\b([A-Za-z_$][A-Za-z0-9_$]*)\b', text))
    return found

def update_imports_for_file(file_path: Path, used_helpers: set, used_modules: set):
    """Update the import statements in a domain file."""
    text = file_path.read_text()
    lines = text.split("\n")

    # Find the existing imports block
    new_lines = []
    i = 0
    while i < len(lines):
        line = lines[i]
        # Skip existing import blocks from internal.ts and registry.ts
        if line.startswith("import {") and (i + 1 < len(lines) and "from \"../internal.ts\"" in lines[i+1] if i+1 < len(lines) else False):
            # Skip the whole multi-line import
            # Find the end (line with from ...)
            while i < len(lines) and not lines[i].rstrip().endswith("} from \"../internal.ts\""):
                i += 1
            i += 1  # skip the closing line
            continue
        if line.strip() == 'import type { ToolDefinition } from "../registry.ts"':
            i += 1
            continue
        new_lines.append(line)
        i += 1

    # Now find the insertion point (before the `export const`)
    result = []
    inserted = False
    for line in new_lines:
        if not inserted and line.startswith("export const "):
            # Add our imports
            if used_helpers:
                result.append('import {')
                for h in sorted(used_helpers):
                    result.append(f"  {h},")
                result.append('} from "../internal.ts"')
            if used_modules:
                result.append("")
                for mod in sorted(used_modules):
                    result.append(f'import "{mod}"')
            result.append('import type { ToolDefinition } from "../registry.ts"')
            result.append("")
            inserted = True
        result.append(line)

    file_path.write_text("\n".join(result))

def main():
    # Step 1: fix import paths
    print("=== Step 1: Fix import paths ===")
    fix_import_paths()

    # Step 2: for each file, find undefined identifiers and add to imports
    print("\n=== Step 2: Add missing imports ===")
    for f in sorted(DOMAINS_DIR.glob("*.ts")):
        # First get the actually-used identifiers (heuristic based on ALL_HELPERS)
        used_in_file = find_used_identifiers(f)
        used_helpers = used_in_file & ALL_HELPERS
        # We don't need to import types (they're type-only)
        # Skip ToolDefinition since it's imported separately
        used_helpers = used_helpers - {"ToolDefinition"}
        # Skip values that are actually defined in the file (we can't know this without
        # more analysis, but importing them anyway is harmless)
        update_imports_for_file(f, used_helpers, set())
        print(f"  {f.name}: added {len(used_helpers)} helper imports")

if __name__ == "__main__":
    main()
