#!/usr/bin/env python3
"""Clean up duplicate import statements and add missing non-helper imports."""

import re
from pathlib import Path
from collections import OrderedDict

DOMAINS_DIR = Path("src/core/tools/domains")
INTERNAL = Path("src/core/tools/internal.ts")

# Mappings for things that need to be imported from OTHER modules (not internal.ts)
# Based on the original registry.ts imports
SIBLING_IMPORTS = {
    "upsertSemanticTool": "../session/store.ts",
    "querySemanticTools": "../session/store.ts",
    "saveDynamicSkill": "../session/store.ts",
    "getDynamicSkill": "../session/store.ts",
    "listDynamicSkills": "../session/store.ts",
    "incrementSkillTelemetry": "../session/store.ts",
    "archiveDynamicSkill": "../session/store.ts",
    "restoreArchivedSkill": "../session/store.ts",
    "appendActionLog": "../session/store.ts",
    "listProfiles": "../session/store.ts",
    "createProfile": "../session/store.ts",
    "fileMemory": "../session/store.ts",
    "readBootWing": "../session/store.ts",
    "writeBootWing": "../session/store.ts",
    "listBootWings": "../session/store.ts",
    "createBootWing": "../session/store.ts",
    "bootWingExists": "../session/store.ts",
    "readConfigWing": "../session/store.ts",
    "writeConfigWing": "../session/store.ts",
    "getSession": "../session/store.ts",
    "listSessions": "../session/store.ts",
    "tailEvents": "../session/store.ts",
    "listSessionTasks": "../session/store.ts",
    "deleteSessionTask": "../session/store.ts",
    "writeSessionTask": "../session/store.ts",
    "writeSessionSource": "../session/store.ts",
    "getDb": "../session/store.ts",
    "recallMemory": "../session/store.ts",
    "listWings": "../session/store.ts",
    "listRooms": "../session/store.ts",
    "addGraphTriple": "../session/store.ts",
    "invalidateGraphTriple": "../session/store.ts",
    "queryGraphEntity": "../session/store.ts",
    "ensureBootWings": "../session/store.ts",
    "SessionTask": "../session/store.ts",

    "MONOLITO_ROOT": "../system/root.ts",
    "getPaths": "../ipc/protocol.ts",
    "ensureDirs": "../ipc/protocol.ts",

    "McpClient": "../mcp/client.ts",
    "createMcpClient": "../mcp/client.ts",
    "getDefaultMcpServers": "../mcp/client.ts",

    "getSharedLspClient": "../lsp/client.ts",

    "normalizeChannelsConfigForWrite": "../channels/config.ts",
    "readChannelsConfig": "../channels/config.ts",
    "writeChannelsConfig": "../channels/config.ts",

    "AgentOrchestrator": "../runtime/orchestrator.ts",

    "isEmbeddingsUnavailableError": "../session/embeddings.ts",

    "Logger": "../logging/logger.ts",
    "redactSensitiveValue": "../security/redact.ts",

    "CONFIG_WING_ORDER": "../config/configWings.ts",
    "ConfigWingName": "../config/configWings.ts",
    "coerceConfigRecord": "../config/wingValue.ts",

    "loadAndApplyModelSettings": "../runtime/modelConfig.ts",
    "readModelSettings": "../runtime/modelConfig.ts",
    "getActiveProfile": "../runtime/modelRegistry.ts",
    "activateProfile": "../runtime/modelRegistry.ts",

    "deployManagedTtsContainer": "../tts/managed.ts",
    "getManagedTtsBaseUrl": "../tts/managed.ts",
    "getManagedTtsStatus": "../tts/managed.ts",
    "listManagedTtsContainers": "../tts/managed.ts",
    "normalizeTtsConfig": "../tts/managed.ts",
    "removeManagedTtsContainer": "../tts/managed.ts",
    "stopManagedTtsContainer": "../tts/managed.ts",

    "deployManagedSttContainer": "../stt/managed.ts",
    "getManagedSttBaseUrl": "../stt/managed.ts",
    "getManagedSttStatus": "../stt/managed.ts",
    "listManagedSttContainers": "../stt/managed.ts",
    "normalizeSttConfig": "../stt/managed.ts",
    "removeManagedSttContainer": "../stt/managed.ts",
    "stopManagedSttContainer": "../stt/managed.ts",
    "transcribeManagedAudioFile": "../stt/managed.ts",

    "deploySearxng": "../websearch/managed.ts",
    "SEARXNG_URL": "../websearch/managed.ts",
    "readWebSearchConfig": "../websearch/config.ts",

    "isBootWingName": "../bootstrap/bootWings.ts",
    "BOOT_WING_ORDER": "../bootstrap/bootWings.ts",
    "renderMasterDashboard": "../menu/masterDashboard.ts",
    "resolveGrokAccessToken": "../runtime/providers/grokAuth.ts",
    "fetchOllamaModels": "../websearch/managed.ts",
}

def get_internal_exports() -> set:
    """Get the set of names actually exported from internal.ts."""
    text = INTERNAL.read_text()
    names = set()
    for m in re.finditer(r'^export\s+(?:async\s+)?function\s+(\w+)', text, re.M):
        names.add(m.group(1))
    for m in re.finditer(r'^export\s+const\s+(\w+)', text, re.M):
        names.add(m.group(1))
    for m in re.finditer(r'^export\s+let\s+(\w+)', text, re.M):
        names.add(m.group(1))
    return names

INTERNAL_EXPORTS = get_internal_exports()
print(f"internal.ts has {len(INTERNAL_EXPORTS)} exports")

def find_used_identifiers(file_path: Path) -> set:
    text = file_path.read_text()
    text = re.sub(r'"(?:[^"\\]|\\.)*"', '""', text)
    text = re.sub(r"'(?:[^'\\]|\\.)*'", "''", text)
    text = re.sub(r"`(?:[^`\\]|\\.)*`", "``", text)
    text = re.sub(r"//[^\n]*", "", text)
    text = re.sub(r"/\*[\s\S]*?\*/", "", text)
    return set(re.findall(r'\b([A-Za-z_$][A-Za-z0-9_$]*)\b', text))

def rewrite_file(file_path: Path):
    """Rewrite the imports of a domain file from scratch."""
    text = file_path.read_text()
    lines = text.split("\n")

    # Find the "export const XxxTools: ToolDefinition[] = [" line
    insert_at = None
    for i, line in enumerate(lines):
        if line.startswith("export const ") and "ToolDefinition[]" in line:
            insert_at = i
            break
    if insert_at is None:
        print(f"  WARN: couldn't find export const in {file_path.name}")
        return

    # Find used identifiers
    used = find_used_identifiers(file_path)

    # Skip ToolDefinition since it's a type and we use `import type`
    used = used - {"ToolDefinition"}

    # Classify: internal.ts vs sibling
    internal_needed = used & INTERNAL_EXPORTS
    sibling_needed = used & set(SIBLING_IMPORTS.keys())
    other = used - internal_needed - sibling_needed - INTERNAL_EXPORTS

    # Group sibling imports by source file
    by_source = OrderedDict()
    for name in sibling_needed:
        src = SIBLING_IMPORTS[name]
        by_source.setdefault(src, []).append(name)

    # Build the new imports block
    new_imports = []
    if internal_needed:
        new_imports.append("import {")
        for h in sorted(internal_needed):
            new_imports.append(f"  {h},")
        new_imports.append('} from "../internal.ts"')
        new_imports.append("")

    for src, names in by_source.items():
        new_imports.append("import {")
        for n in sorted(names):
            new_imports.append(f"  {n},")
        new_imports.append(f'}} from "{src}"')
        new_imports.append("")

    new_imports.append('import type { ToolDefinition } from "../registry.ts"')
    new_imports.append("")

    # Now rebuild the file: keep header comments, then imports, then everything from `export const` onwards
    # Find the first comment line
    first_real = 0
    for i, line in enumerate(lines):
        if line.startswith("//"):
            first_real = i + 1
        else:
            break
    header = lines[:first_real]
    body = lines[insert_at:]

    new_lines = header + [""] + new_imports + body
    file_path.write_text("\n".join(new_lines))

    if other:
        print(f"  {file_path.name}: ⚠ {len(other)} unknown identifiers: {sorted(other)[:5]}")
    else:
        print(f"  {file_path.name}: {len(internal_needed)} internal + {len(sibling_needed)} sibling imports")

def main():
    print("=== Rewriting domain imports cleanly ===")
    for f in sorted(DOMAINS_DIR.glob("*.ts")):
        rewrite_file(f)

if __name__ == "__main__":
    main()
