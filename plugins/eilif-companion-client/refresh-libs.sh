#!/usr/bin/env bash
# Refresh the compile-time reference DLLs in libs/ from the live game + a BepInEx pack.
# These are references ONLY (never shipped) and MUST be re-copied after every Valheim patch
# (game DLLs) so the plugin compiles against the current API. Re-run, then `dotnet build -c Release`.
#
# Client-side twin of ../eilif-companion/refresh-libs.sh (same toolchain, same BepInEx pack).
# Difference: no Splatform.dll — this plugin never builds a UserInfo, it only reads Minimap fog.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIBS="$HERE/libs"
mkdir -p "$LIBS"

# --- Game assemblies (current install; update path if Steam moves) ---
MANAGED="${VALHEIM_MANAGED:-$HOME/snap/steam/common/.local/share/Steam/steamapps/common/Valheim/valheim_Data/Managed}"
GAME_DLLS=(assembly_valheim.dll UnityEngine.dll UnityEngine.CoreModule.dll)

if [[ ! -d "$MANAGED" ]]; then
  echo "ERROR: Valheim Managed dir not found: $MANAGED" >&2
  echo "Set VALHEIM_MANAGED=/path/to/valheim_Data/Managed and re-run." >&2
  exit 1
fi

for f in "${GAME_DLLS[@]}"; do
  cp -v "$MANAGED/$f" "$LIBS/$f"
done

# --- BepInEx reference DLLs (BepInExPack_Valheim 5.4.2333, matches the Eilif server + pack) ---
BEPINEX_VER="5.4.2333"
BEPINEX_URL="https://thunderstore.io/package/download/denikson/BepInExPack_Valheim/${BEPINEX_VER}/"
if [[ ! -f "$LIBS/BepInEx.dll" || ! -f "$LIBS/0Harmony.dll" || "${FORCE_BEPINEX:-0}" == "1" ]]; then
  TMP="$(mktemp -d)"
  echo "Downloading BepInExPack_Valheim ${BEPINEX_VER}..."
  curl -sSL "$BEPINEX_URL" -o "$TMP/bepinex.zip"
  unzip -o -q "$TMP/bepinex.zip" -d "$TMP/x"
  CORE="$TMP/x/BepInExPack_Valheim/BepInEx/core"
  cp -v "$CORE/BepInEx.dll" "$LIBS/BepInEx.dll"
  cp -v "$CORE/0Harmony.dll" "$LIBS/0Harmony.dll"
  rm -rf "$TMP"
else
  echo "BepInEx.dll + 0Harmony.dll already present (set FORCE_BEPINEX=1 to re-fetch)."
fi

echo "libs/ refreshed. Now: dotnet build -c Release"
