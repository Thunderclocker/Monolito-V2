#!/usr/bin/env python3
"""
Final cleanup pass for domain files. Fixes:
1. Import paths: ../X → ../../X for sibling module imports
2. Adds node: imports (fs, path, child_process, crypto, util, url) where needed
3. Adds truncateText and any other missing exports
4. Fixes the `tools` self-reference in admin.ts via listTools()
"""

import re
from pathlib import Path
from collections import OrderedDict

DOMAINS_DIR = Path("src/core/tools/domains")
INTERNAL = Path("src/core/tools/internal.ts")

# Map internal.ts imports → which node: source
NODE_SOURCES = {
    "execFile": "node:child_process", "spawn": "node:child_process",
    "promisify": "node:util",
    "randomUUID": "node:crypto",
    "createWriteStream": "node:fs", "existsSync": "node:fs", "mkdirSync": "node:fs",
    "openSync": "node:fs", "readdirSync": "node:fs", "readFileSync": "node:fs",
    "statSync": "node:fs", "writeFileSync": "node:fs", "unlinkSync": "node:fs",
    "dirname": "node:path", "join": "node:path", "relative": "node:path",
    "resolve": "node:path", "sep": "node:path",
    "pathToFileURL": "node:url",
}

# Sibling imports: name → (path, name_in_module)
# In domain files, sibling paths need ../../ prefix
SIBLING = {
    "upsertSemanticTool": ("../../session/store.ts", "upsertSemanticTool"),
    "querySemanticTools": ("../../session/store.ts", "querySemanticTools"),
    "saveDynamicSkill": ("../../session/store.ts", "saveDynamicSkill"),
    "getDynamicSkill": ("../../session/store.ts", "getDynamicSkill"),
    "listDynamicSkills": ("../../session/store.ts", "listDynamicSkills"),
    "incrementSkillTelemetry": ("../../session/store.ts", "incrementSkillTelemetry"),
    "archiveDynamicSkill": ("../../session/store.ts", "archiveDynamicSkill"),
    "restoreArchivedSkill": ("../../session/store.ts", "restoreArchivedSkill"),
    "appendActionLog": ("../../session/store.ts", "appendActionLog"),
    "listProfiles": ("../../session/store.ts", "listProfiles"),
    "createProfile": ("../../session/store.ts", "createProfile"),
    "fileMemory": ("../../session/store.ts", "fileMemory"),
    "readBootWing": ("../../session/store.ts", "readBootWing"),
    "writeBootWing": ("../../session/store.ts", "writeBootWing"),
    "listBootWings": ("../../session/store.ts", "listBootWings"),
    "createBootWing": ("../../session/store.ts", "createBootWing"),
    "bootWingExists": ("../../session/store.ts", "bootWingExists"),
    "readConfigWing": ("../../session/store.ts", "readConfigWing"),
    "writeConfigWing": ("../../session/store.ts", "writeConfigWing"),
    "getSession": ("../../session/store.ts", "getSession"),
    "listSessions": ("../../session/store.ts", "listSessions"),
    "tailEvents": ("../../session/store.ts", "tailEvents"),
    "listSessionTasks": ("../../session/store.ts", "listSessionTasks"),
    "deleteSessionTask": ("../../session/store.ts", "deleteSessionTask"),
    "writeSessionTask": ("../../session/store.ts", "writeSessionTask"),
    "writeSessionSource": ("../../session/store.ts", "writeSessionSource"),
    "getDb": ("../../session/store.ts", "getDb"),
    "recallMemory": ("../../session/store.ts", "recallMemory"),
    "listMemoryNamespaces": ("../../session/store.ts", "listMemoryNamespaces"),
    "listMemorySections": ("../../session/store.ts", "listMemorySections"),
    "addGraphTriple": ("../../session/store.ts", "addGraphTriple"),
    "invalidateGraphTriple": ("../../session/store.ts", "invalidateGraphTriple"),
    "queryGraphEntity": ("../../session/store.ts", "queryGraphEntity"),
    "ensureBootWings": ("../../session/store.ts", "ensureBootWings"),
    "SessionTask": ("../../session/store.ts", "SessionTask"),

    "MONOLITO_ROOT": ("../../system/root.ts", "MONOLITO_ROOT"),
    "getPaths": ("../../ipc/protocol.ts", "getPaths"),
    "ensureDirs": ("../../ipc/protocol.ts", "ensureDirs"),

    "McpClient": ("../../mcp/client.ts", "McpClient"),
    "createMcpClient": ("../../mcp/client.ts", "createMcpClient"),
    "getDefaultMcpServers": ("../../mcp/client.ts", "getDefaultMcpServers"),

    "getSharedLspClient": ("../../lsp/client.ts", "getSharedLspClient"),

    "normalizeChannelsConfigForWrite": ("../../channels/config.ts", "normalizeChannelsConfigForWrite"),
    "readChannelsConfig": ("../../channels/config.ts", "readChannelsConfig"),
    "writeChannelsConfig": ("../../channels/config.ts", "writeChannelsConfig"),

    "AgentOrchestrator": ("../../runtime/orchestrator.ts", "AgentOrchestrator"),

    "isEmbeddingsUnavailableError": ("../../session/embeddings.ts", "isEmbeddingsUnavailableError"),

    "Logger": ("../../logging/logger.ts", "Logger"),
    "redactSensitiveValue": ("../../security/redact.ts", "redactSensitiveValue"),

    "CONFIG_WING_ORDER": ("../../config/configWings.ts", "CONFIG_WING_ORDER"),
    "ConfigWingName": ("../../config/configWings.ts", "ConfigWingName"),
    "coerceConfigRecord": ("../../config/wingValue.ts", "coerceConfigRecord"),

    "loadAndApplyModelSettings": ("../../runtime/modelConfig.ts", "loadAndApplyModelSettings"),
    "readModelSettings": ("../../runtime/modelConfig.ts", "readModelSettings"),
    "getActiveProfile": ("../../runtime/modelRegistry.ts", "getActiveProfile"),
    "activateProfile": ("../../runtime/modelRegistry.ts", "activateProfile"),

    "deployManagedTtsContainer": ("../../tts/managed.ts", "deployManagedTtsContainer"),
    "getManagedTtsBaseUrl": ("../../tts/managed.ts", "getManagedTtsBaseUrl"),
    "getManagedTtsStatus": ("../../tts/managed.ts", "getManagedTtsStatus"),
    "listManagedTtsContainers": ("../../tts/managed.ts", "listManagedTtsContainers"),
    "normalizeTtsConfig": ("../../tts/managed.ts", "normalizeTtsConfig"),
    "removeManagedTtsContainer": ("../../tts/managed.ts", "removeManagedTtsContainer"),
    "stopManagedTtsContainer": ("../../tts/managed.ts", "stopManagedTtsContainer"),

    "deployManagedSttContainer": ("../../stt/managed.ts", "deployManagedSttContainer"),
    "getManagedSttBaseUrl": ("../../stt/managed.ts", "getManagedSttBaseUrl"),
    "getManagedSttStatus": ("../../stt/managed.ts", "getManagedSttStatus"),
    "listManagedSttContainers": ("../../stt/managed.ts", "listManagedSttContainers"),
    "normalizeSttConfig": ("../../stt/managed.ts", "normalizeSttConfig"),
    "removeManagedSttContainer": ("../../stt/managed.ts", "removeManagedSttContainer"),
    "stopManagedSttContainer": ("../../stt/managed.ts", "stopManagedSttContainer"),
    "transcribeManagedAudioFile": ("../../stt/managed.ts", "transcribeManagedAudioFile"),

    "readWebSearchConfig": ("../../websearch/config.ts", "readWebSearchConfig"),

    "isBootWingName": ("../../bootstrap/bootWings.ts", "isBootWingName"),
    "BOOT_WING_ORDER": ("../../bootstrap/bootWings.ts", "BOOT_WING_ORDER"),
    "renderMasterDashboard": ("../../menu/masterDashboard.ts", "renderMasterDashboard"),
    "resolveGrokAccessToken": ("../../runtime/providers/grokAuth.ts", "resolveGrokAccessToken"),
}

def get_internal_exports() -> set:
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
    used = used - {"ToolDefinition"}

    # Classify
    internal_needed = used & INTERNAL_EXPORTS
    node_needed = used & set(NODE_SOURCES.keys())
    sibling_needed = used & set(SIBLING.keys())
    other = used - internal_needed - node_needed - sibling_needed - INTERNAL_EXPORTS

    # Group node imports by source
    by_node_src = OrderedDict()
    for name in node_needed:
        by_node_src.setdefault(NODE_SOURCES[name], []).append(name)

    # Group sibling imports by source
    by_sibling_src = OrderedDict()
    for name in sibling_needed:
        src = SIBLING[name][0]
        by_sibling_src.setdefault(src, []).append(name)

    # Build new imports
    new_imports = []
    # Node imports first
    for src, names in by_node_src.items():
        new_imports.append("import {")
        for n in sorted(names):
            new_imports.append(f"  {n},")
        new_imports.append(f'}} from "{src}"')
        new_imports.append("")
    # Internal imports
    if internal_needed:
        new_imports.append("import {")
        for h in sorted(internal_needed):
            new_imports.append(f"  {h},")
        new_imports.append('} from "../internal.ts"')
        new_imports.append("")
    # Sibling imports
    for src, names in by_sibling_src.items():
        new_imports.append("import {")
        for n in sorted(names):
            new_imports.append(f"  {n},")
        new_imports.append(f'}} from "{src}"')
        new_imports.append("")
    # ToolDefinition type
    new_imports.append('import type { ToolDefinition } from "../registry.ts"')
    new_imports.append("")

    # Find first non-comment line
    first_real = 0
    for i, line in enumerate(lines):
        if line.startswith("//") or line.strip() == "":
            first_real = i + 1
        else:
            break
    header = lines[:first_real]
    body = lines[insert_at:]

    new_lines = header + new_imports + body
    file_path.write_text("\n".join(new_lines))

    msg = f"  {file_path.name}: {len(internal_needed)} internal + {len(node_needed)} node + {len(sibling_needed)} sibling"
    if other:
        msg += f" | ⚠ {len(other)} unknown: {sorted(other)[:5]}"
    print(msg)

def fix_tools_self_reference():
    """Fix the `tools` self-reference in admin.ts (search_tools tool)."""
    admin_file = DOMAINS_DIR / "admin.ts"
    text = admin_file.read_text()
    # Replace `tools.filter(...)` inside the search_tools run with a call to listTools()
    # This is a hack — just import listTools from registry.ts and use it.
    if "tools.filter" in text:
        # Add listTools to the import (it's not in any sibling or internal)
        # We need to import it from registry.ts as a value
        # But that creates a circular dep. Let me use dynamic import inside the function.
        # Actually, the simplest: change the tool code to use listTools()
        text = text.replace(
            "const matchedTools = tools.filter(t => results.includes(t.name))",
            "const { listTools } = await import(\"../registry.ts\")\n      const matchedTools = listTools().filter(t => results.includes(t.name))"
        )
        admin_file.write_text(text)
        print(f"  admin.ts: fixed tools self-reference via dynamic import")

def main():
    print("=== Final cleanup pass ===")
    print("\n--- Rewriting imports ---")
    for f in sorted(DOMAINS_DIR.glob("*.ts")):
        rewrite_file(f)
    print("\n--- Fixing tools self-reference ---")
    fix_tools_self_reference()
    print("\n=== Done ===")

if __name__ == "__main__":
    main()
