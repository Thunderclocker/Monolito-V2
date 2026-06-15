#!/usr/bin/env python3
"""
Splits src/core/tools/registry.ts into multiple domain files.

Strategy:
- Lines 1-1080: shared helpers, types, Zod schemas → moves to internal.ts
- Lines 1081-4829: the rawTools array. Each tool object (77 total) is extracted
  to a domain file based on its name.
- Lines 4830-end: the public API (getTool, listTools, listModelTools,
  indexSemanticTools, indexRalphRules) → stays in registry.ts.

Domain groups (in order of file naming):
- shell      : schedule_task, Bash
- mcp        : ListMcpResourcesTool, ReadMcpResourceTool, LspQuery
- web        : WebFetch, WebSearch, ImageSearch
- file       : pwd, list_files, Read, Write, Edit, Glob, Grep
- git        : GitStatus, GitDiff, GitDiffCached, GitAdd, GitCommit
- telegram   : TelegramSend, TelegramSendAudio, TelegramSendVoice, TelegramSendPhoto,
               TelegramSendDocument, TelegramGetFile, DownloadFile, TelegramDownloadFile
- media      : TtsService*, SttService*, TranscribeAudio, GenerateSpeech,
               VisionAnalyze, GenerateImage
- memory     : BootRead, BootListWings, BootCreateWing, BootWrite,
               WorkspaceMemoryFiling, WorkspaceMemoryRecall, KgAdd, KgInvalidate, KgQuery
- forensics  : SessionForensics
- delegation : AgentSpawn, list_active_workers, delegate_background_task, AgentSendMessage,
               AgentStop, TriggerBackgroundStudy, AgentList, ProfileCreate
- config     : tool_manage_config
- todo       : TodoWrite, TodoList
- admin      : system_status, system_reboot, QuerySessionStatus, QueryCost,
               QuerySessionStats, CompactSession, show_master_dashboard, search_tools
- skills     : CreateSkill, ListSkills, DeleteSkill, ArchiveSkill, RestoreSkill, skill_view
"""

import re
from pathlib import Path

REGISTRY = Path("src/core/tools/registry.ts")
OUT_DIR = Path("src/core/tools/domains")

# Map: tool name → domain file basename
TOOL_DOMAIN = {
    "schedule_task": "shell",
    "Bash": "shell",
    "ListMcpResourcesTool": "mcp",
    "ReadMcpResourceTool": "mcp",
    "LspQuery": "mcp",
    "WebFetch": "web",
    "WebSearch": "web",
    "ImageSearch": "web",
    "pwd": "file",
    "list_files": "file",
    "Read": "file",
    "Write": "file",
    "Edit": "file",
    "Glob": "file",
    "Grep": "file",
    "GitStatus": "git",
    "GitDiff": "git",
    "GitDiffCached": "git",
    "GitAdd": "git",
    "GitCommit": "git",
    "TelegramSend": "telegram",
    "TelegramSendAudio": "telegram",
    "TelegramSendVoice": "telegram",
    "TelegramSendPhoto": "telegram",
    "TelegramSendDocument": "telegram",
    "TelegramGetFile": "telegram",
    "DownloadFile": "telegram",
    "TelegramDownloadFile": "telegram",
    "SttServiceStatus": "media",
    "SttServiceDeploy": "media",
    "SttServiceStop": "media",
    "SttServiceRemove": "media",
    "SttServiceList": "media",
    "TranscribeAudio": "media",
    "TtsServiceStatus": "media",
    "TtsServiceDeploy": "media",
    "TtsServiceStop": "media",
    "TtsServiceRemove": "media",
    "TtsServiceList": "media",
    "GenerateSpeech": "media",
    "VisionAnalyze": "media",
    "GenerateImage": "media",
    "BootRead": "memory",
    "BootListWings": "memory",
    "BootCreateWing": "memory",
    "BootWrite": "memory",
    "WorkspaceMemoryFiling": "memory",
    "WorkspaceMemoryRecall": "memory",
    "KgAdd": "memory",
    "KgInvalidate": "memory",
    "KgQuery": "memory",
    "SessionForensics": "forensics",
    "AgentSpawn": "delegation",
    "list_active_workers": "delegation",
    "delegate_background_task": "delegation",
    "AgentSendMessage": "delegation",
    "AgentStop": "delegation",
    "TriggerBackgroundStudy": "delegation",
    "AgentList": "delegation",
    "ProfileCreate": "delegation",
    "tool_manage_config": "config",
    "TodoWrite": "todo",
    "TodoList": "todo",
    "system_status": "admin",
    "system_reboot": "admin",
    "QuerySessionStatus": "admin",
    "QueryCost": "admin",
    "QuerySessionStats": "admin",
    "CompactSession": "admin",
    "show_master_dashboard": "admin",
    "search_tools": "admin",
    "CreateSkill": "skills",
    "ListSkills": "skills",
    "DeleteSkill": "skills",
    "ArchiveSkill": "skills",
    "RestoreSkill": "skills",
    "skill_view": "skills",
}

# Human-friendly titles for each domain (for export naming)
DOMAIN_TITLES = {
    "shell": "shell",
    "mcp": "mcp",
    "web": "web",
    "file": "file",
    "git": "git",
    "telegram": "telegram",
    "media": "media",
    "memory": "memory",
    "forensics": "forensics",
    "delegation": "delegation",
    "config": "config",
    "todo": "todo",
    "admin": "admin",
    "skills": "skills",
}

def find_tool_boundaries(lines):
    """Find (start_line, end_line, name) for each tool object inside rawTools.

    A tool object starts at a line like "  {" (2 spaces + brace) followed
    by "    name: "X"" on the next line. The object ends when we see "  },"
    at the same indentation as the opening brace.
    """
    boundaries = []
    in_array = False
    i = 0
    while i < len(lines):
        line = lines[i]
        if not in_array:
            if re.match(r'^const rawTools: ToolDefinition\[\] = \[$', line):
                in_array = True
            i += 1
            continue
        # We're inside the array. Look for tool start.
        m = re.match(r'^  \{$', line)
        if m:
            start = i
            # Next non-blank line should have the name
            j = i + 1
            while j < len(lines) and lines[j].strip() == "":
                j += 1
            name_m = re.match(r'\s+name:\s+"([^"]+)"', lines[j])
            if not name_m:
                print(f"WARN: tool starting at line {i+1} has no name on next line")
                i += 1
                continue
            name = name_m.group(1)
            # Now find the end: "  }," or "  }"
            k = j
            depth = 0
            # Track brace depth starting from the opening "  {"
            # We know the opening is on line `i`. The name line doesn't have braces
            # in the value typically. Let's track braces from `i` forward.
            for k in range(i, len(lines)):
                # Count { and } on this line, ignoring strings (rough)
                line_text = lines[k]
                # Strip out string contents (single/double/backtick quotes)
                line_no_strings = re.sub(r'"(?:[^"\\]|\\.)*"', '""', line_text)
                line_no_strings = re.sub(r"'(?:[^'\\]|\\.)*'", "''", line_no_strings)
                line_no_strings = re.sub(r'`(?:[^`\\]|\\.)*`', '``', line_no_strings)
                opens = line_no_strings.count("{")
                closes = line_no_strings.count("}")
                depth += opens - closes
                if depth == 0 and k > i:
                    # This line closes the object
                    boundaries.append((start, k, name))
                    i = k + 1
                    break
            else:
                # Shouldn't happen
                i += 1
        else:
            i += 1
    return boundaries

def main():
    text = REGISTRY.read_text()
    lines = text.split("\n")
    print(f"Total lines in registry.ts: {len(lines)}")

    # Find rawTools array range
    raw_start = None
    raw_end = None
    for i, line in enumerate(lines):
        if raw_start is None and re.match(r'^const rawTools: ToolDefinition\[\] = \[$', line):
            raw_start = i
        if raw_start is not None and i > raw_start and re.match(r'^]$', line):
            raw_end = i
            break
    print(f"rawTools array: lines {raw_start+1} to {raw_end+1}")

    # Find tool boundaries
    boundaries = find_tool_boundaries(lines)
    print(f"Found {len(boundaries)} tool objects")
    assert len(boundaries) == 77, f"Expected 77 tools, got {len(boundaries)}"

    # Group by domain
    domain_tools = {}  # domain -> list of (start, end, name)
    for start, end, name in boundaries:
        if name not in TOOL_DOMAIN:
            print(f"WARN: tool '{name}' not in TOOL_DOMAIN map")
            continue
        domain = TOOL_DOMAIN[name]
        domain_tools.setdefault(domain, []).append((start, end, name))

    # Verify all tools are mapped
    unmapped = [name for _, _, name in boundaries if name not in TOOL_DOMAIN]
    if unmapped:
        print(f"ERROR: unmapped tools: {unmapped}")
        return

    # Group domains by file (in our case, one file per domain)
    print("\n=== Domain grouping ===")
    for domain, tools in domain_tools.items():
        names = [n for _, _, n in tools]
        print(f"  {domain} ({len(tools)}): {', '.join(names)}")

    # Write each domain file
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for domain, tools in domain_tools.items():
        file_path = OUT_DIR / f"{domain}.ts"
        title = DOMAIN_TITLES[domain]
        var_name = f"{title}Tools"

        # Build the file content
        out_lines = [
            f"// Auto-generated by scripts/split_registry.py — do not edit manually.",
            f"// Domain: {title} ({len(tools)} tools)",
            "",
            "import type { ToolDefinition } from \"../registry.ts\"",
            "",
            f"export const {var_name}: ToolDefinition[] = [",
        ]
        for idx, (start, end, name) in enumerate(tools):
            # Extract tool lines, strip leading 2-space indent (was for rawTools array,
            # now they're at top level inside our new array)
            for ln in range(start, end + 1):
                line = lines[ln]
                if line.startswith("  "):
                    out_lines.append(line[2:])  # remove 2-space indent
                else:
                    out_lines.append(line)
            # Add comma between tools (the last one in the source may not have one)
            if idx < len(tools) - 1:
                if not out_lines[-1].rstrip().endswith(","):
                    out_lines[-1] = out_lines[-1].rstrip() + ","
            out_lines.append("")  # blank line between tools

        out_lines.append("]")
        out_lines.append("")

        file_path.write_text("\n".join(out_lines))
        print(f"  wrote {file_path} ({len(out_lines)} lines)")

if __name__ == "__main__":
    main()
