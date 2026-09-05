#!/usr/bin/env bash
# Rebuild all four custom BepInEx plugins against a given set of game assemblies, and
# prove the result is deployable. Written for launch day: Valheim 1.0 bumps
# assembly_valheim.dll, every plugin has to be recompiled against the new one, and the
# whole job has to happen inside one stopped window.
#
#   bash scripts/rebuild-plugins.sh --dry-run                 # print the plan, touch nothing
#   bash scripts/rebuild-plugins.sh                           # rebuild from the live Steam install
#   bash scripts/rebuild-plugins.sh --yes                     # ... without the typed confirmation
#   bash scripts/rebuild-plugins.sh --libs /path/to/Managed   # rebuild from an explicit Managed dir
#   bash scripts/rebuild-plugins.sh --sandbox /tmp/rb         # build COPIES; repo dist/ untouched
#   bash scripts/rebuild-plugins.sh --only eilif-companion    # one plugin
#   bash scripts/rebuild-plugins.sh --skip-refresh            # keep libs/ as they are
#   bash scripts/rebuild-plugins.sh --source-revision <sha>   # reproduce a committed DLL exactly
#   bash scripts/rebuild-plugins.sh --stage                   # ... then stage the artifacts
#   bash scripts/rebuild-plugins.sh --stage ~/eilif-launch-dlls   # ... into a named dir
#
# --stage takes an optional directory for the SERVER DLLs; without one it uses
# $EILIF_STAGE_DIR, or $TMPDIR/eilif-launch-dlls. Client DLLs always go into the repo's
# plugins/thunderstore/, so that argument does not affect them.
#
# What it does per plugin, in this order:
#   1. refresh-libs.sh   — re-copies the game assemblies into the plugin's own libs/.
#                          Each plugin's script documents its own source path via
#                          VALHEIM_MANAGED, defaulting to the snap Steam install:
#                          ~/snap/steam/common/.local/share/Steam/steamapps/common/Valheim/valheim_Data/Managed
#                          --libs <dir> overrides that for every plugin at once. Each
#                          script also pulls BepInEx 5.4.2333's BepInEx.dll + 0Harmony.dll
#                          from Thunderstore the first time, then leaves them alone.
#   2. dotnet build -c Release  — the csproj's CopyToDist target overwrites dist/<Name>.dll,
#                          which IS the deployable artifact (this is intended, not a leak).
#   3. md5 + size of dist/<Name>.dll before and after, so a rebuild that changed nothing is
#                          visibly a no-op. All four csprojs set <Deterministic>true</Deterministic>
#                          and <DebugType>none</DebugType>, and the build is genuinely reproducible:
#                          the same source compiled twice, even from two different directories,
#                          produces a BYTE-IDENTICAL DLL (measured 2026-09-04: 0 differing bytes).
#
#                          ONE THING BREAKS THAT, and it is not a timestamp or the MVID. The .NET 8
#                          SDK bundles SourceLink, so a build run inside a git work tree stamps
#                          AssemblyInformationalVersion = "<Version>+<HEAD sha>". The committed
#                          dist/EilifBoards.dll carries "0.2.0+9be27ee…" (the pack-v11 commit); the
#                          identical source built outside a work tree carries plain "0.2.0", and
#                          the two DLLs differ in 566 bytes with the SAME size. Passing
#                          --source-revision 9be27ee… reproduces the committed file exactly, which
#                          is how that was proved.
#
#                          So: a changed md5 after an in-place rebuild means the source changed OR
#                          HEAD moved, and the script CANNOT tell you which from size and stamp
#                          alone. PE sections are 512-byte aligned (all four DLLs are exact
#                          multiples), so a small code edit routinely leaves the size unchanged —
#                          and on launch day HEAD will have moved too, so the stamp differs either
#                          way. Same size + different stamp is therefore "MAY be stamp-only", never
#                          a verdict. The one way to actually prove it is a second build:
#                          --source-revision <the before DLL's sha> into a --sandbox, then compare
#                          md5 with the before value. (Deliberately not automatic: CopyToDist
#                          overwrites dist/ on every build, so proving it in place would leave the
#                          OLD-stamped DLL sitting in the deployable slot.) The md5 is still exactly
#                          what you compare against the copy on the box, since that came from dist/.
#   4. version string     — the csproj <Version> must appear in the built DLL, so a stale
#                          artifact can never be mistaken for the new one.
#   5. ValueTuple check   — the Unity Mono runtime that ships with Valheim has no
#                          System.ValueTuple, so any (a, b) tuple in the source compiles fine
#                          here and then throws TypeLoadException in game. A hit here FAILS the
#                          build; the fix is a small struct or out params, never a NuGet package.
#
# Then it prints the staging summary: where each DLL goes, and what has to be true first.
#
# --stage does the copying that summary describes, and nothing beyond this machine:
#   * SERVER DLLs (Companion, Boards) are copied into the staging dir with their md5
#     and the exact SFTP destination path printed next to each. The upload itself is
#     still by hand, inside the panel's stopped window, because Windows file-locks a
#     loaded DLL and the lock outlives the process by a few seconds.
#   * CLIENT DLLs (Paths, CompanionClient) are copied into
#     plugins/thunderstore/<Name>-<ver>/, seeded from the newest existing package dir
#     when that version is new, and the manifest's version_number is bumped after a
#     typed confirmation. README.md, CHANGELOG.md and the manifest description are
#     NOT written for you: a seeded package dir carries the PREVIOUS version's
#     store page, and the script names all three so they cannot be forgotten.
#     Charlie uploads the zip; this script never touches Thunderstore.
#   * Nothing is staged at all if any plugin failed its checks, gate before copy.
# --dry-run --stage prints that whole plan and writes nothing.
#
# Requires: dotnet 8 (~/.dotnet), bash, md5sum, strings (binutils).
# Network: `dotnet build` restores Microsoft.NETFramework.ReferenceAssemblies, so it only
# stays offline while that package is in ~/.nuget/packages — the plan below says whether it
# is. Also fetches BepInEx.dll + 0Harmony.dll if libs/ lacks them or FORCE_BEPINEX=1. On
# launch night this runs inside the stopped window, where a surprise nuget.org round trip is
# the last thing anyone needs.
#
# Related: each plugin's BUILD.md (per-plugin gotchas and the launch-day sequence),
# scripts/launch-preflight.mjs (does the box actually have these versions loaded),
# scripts/verify-restart.sh (what the last Stop->Start armed).

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Build order: clients first, then the two server-side plugins, so that if the run is cut
# short the things that must be uploaded inside the stopped window are the freshest.
ALL_PLUGINS=(eilif-paths eilif-companion-client eilif-companion eilif-boards)

# Where each artifact goes once built. GTX nest dir is IP_PORT-derived (see verify-restart.sh).
NEST="191.101.30.229_6028"
declare -A SIDE=(
  [eilif-paths]=CLIENT
  [eilif-companion-client]=CLIENT
  [eilif-companion]=SERVER
  [eilif-boards]=SERVER
)
# SERVER plugins: the exact SFTP path the DLL overwrites, relative to the SFTP
# user's home. The plugin FOLDER name is not always the assembly name, so it is
# spelled out rather than derived.
declare -A SFTP_DEST=(
  [eilif-companion]="${NEST}/BepInEx/plugins/EilifCompanion/EilifCompanion.dll"
  [eilif-boards]="${NEST}/BepInEx/plugins/EilifBoards/EilifBoards.dll"
)
# CLIENT plugins: the Thunderstore package name, which is also the
# plugins/thunderstore/<Name>-<ver>/ staging directory name.
declare -A TS_PACKAGE=(
  [eilif-paths]=EilifPaths
  [eilif-companion-client]=EilifCompanionClient
)
declare -A STAGING=(
  [eilif-paths]="CLIENT · Thunderstore Eilif/EilifPaths + the r2modman pack pin"
  [eilif-companion-client]="CLIENT · Thunderstore Eilif/EilifCompanionClient + the r2modman pack pin"
  [eilif-companion]="SERVER · SFTP over ${SFTP_DEST[eilif-companion]}"
  [eilif-boards]="SERVER · SFTP over ${SFTP_DEST[eilif-boards]}"
)

# ── args ────────────────────────────────────────────────────────────────────
LIBS_SRC=""
SANDBOX=""
DRY_RUN=0
SKIP_REFRESH=0
ONLY=""
SOURCE_REV=""
ASSUME_YES=0
STAGE=0
# Defaults to a temp dir so a bare --stage never writes somewhere surprising. On
# launch morning pass the session scratchpad explicitly, so the coordinator and
# this script are looking at the same files.
STAGE_DIR="${EILIF_STAGE_DIR:-${TMPDIR:-/tmp}/eilif-launch-dlls}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --libs) LIBS_SRC="${2:-}"; shift 2 ;;
    --stage)
      STAGE=1
      # Optional value: only swallow the next argument if it is not another flag.
      if [[ -n "${2:-}" && "${2:0:1}" != "-" ]]; then STAGE_DIR="$2"; shift 2; else shift; fi ;;
    --sandbox) SANDBOX="${2:-}"; shift 2 ;;
    --only) ONLY="${2:-}"; shift 2 ;;
    --source-revision) SOURCE_REV="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-refresh) SKIP_REFRESH=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help)
      sed -n '2,86p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

PLUGINS=()
if [[ -n "$ONLY" ]]; then
  IFS=',' read -ra want <<< "$ONLY"
  for w in "${want[@]}"; do
    found=0
    for p in "${ALL_PLUGINS[@]}"; do [[ "$p" == "$w" ]] && { PLUGINS+=("$p"); found=1; }; done
    [[ $found == 1 ]] || { echo "unknown plugin: $w" >&2; exit 2; }
  done
else
  PLUGINS=("${ALL_PLUGINS[@]}")
fi

DEFAULT_MANAGED="$HOME/snap/steam/common/.local/share/Steam/steamapps/common/Valheim/valheim_Data/Managed"
MANAGED="${LIBS_SRC:-${VALHEIM_MANAGED:-$DEFAULT_MANAGED}}"

export DOTNET_ROOT="${DOTNET_ROOT:-$HOME/.dotnet}"
export PATH="$DOTNET_ROOT:$PATH"
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_NOLOGO=1

# ── helpers ─────────────────────────────────────────────────────────────────
BOLD=""; RED=""; GRN=""; YLW=""; DIM=""; OFF=""
if [[ -t 1 ]]; then BOLD=$'\e[1m'; RED=$'\e[31m'; GRN=$'\e[32m'; YLW=$'\e[33m'; DIM=$'\e[90m'; OFF=$'\e[0m'; fi

FAILURES=0
declare -A RESULT_LINE=()
# What --stage later copies. Recorded here rather than recomputed, because in
# --sandbox mode the artifact to stage is the freshly built one under the
# sandbox, not the repo's dist/.
declare -A BUILT_NAME=() BUILT_VER=() BUILT_DLL=() BUILT_OK=()

hr() { printf '%s\n' "${DIM}$(printf '─%.0s' {1..78})${OFF}"; }
say() { printf '%s\n' "$*"; }

assembly_name() { grep -o '<AssemblyName>[^<]*' "$1" | sed 's/.*>//'; }
version_of()    { grep -o '<Version>[^<]*' "$1" | sed 's/.*>//'; }

md5_of() { [[ -f "$1" ]] && md5sum "$1" | cut -d' ' -f1 || echo "-"; }
size_of() { [[ -f "$1" ]] && stat -c%s "$1" || echo "-"; }

# AssemblyInformationalVersion as compiled in: "0.2.0" or "0.2.0+<git sha>". This, not the
# md5, is the human-readable identity of a built DLL — and it is why an in-place rebuild
# changes the md5 whenever HEAD has moved, with no source change at all.
stamp_of() {
  [[ -f "$1" ]] || { echo "-"; return; }
  { strings -a "$1"; strings -el "$1"; } | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+\+[0-9a-f]{40}$' | head -1 && return
  echo "no git stamp"
}

manifest_version() { [[ -f "$1" ]] && sed -n 's/.*"version_number"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -1; }

# The newest existing plugins/thunderstore/<Pkg>-<ver>/ (or the unsuffixed
# <Pkg>/), used to seed a new version directory. Sorted by version, not by mtime:
# a directory someone touched last is not the one whose README is newest.
newest_package_dir() {
  local pkg="$1" d best=""
  for d in "$REPO/plugins/thunderstore/$pkg"-*/ "$REPO/plugins/thunderstore/$pkg"/; do
    [[ -d "$d" && -f "$d/manifest.json" ]] || continue
    best+="$(manifest_version "$d/manifest.json")|${d%/}"$'\n'
  done
  printf '%s' "$best" | grep -v '^$' | sort -t'|' -k1,1V | tail -1 | cut -d'|' -f2-
}

# ── plan ────────────────────────────────────────────────────────────────────
say ""
say "${BOLD}Plugin rebuild — ${#PLUGINS[@]} plugin(s), $( [[ $DRY_RUN == 1 ]] && echo 'DRY RUN (nothing is written)' || echo 'live build' )${OFF}"
say "  game assemblies : $MANAGED"
if [[ -d "$MANAGED" ]]; then
  say "                    $(md5_of "$MANAGED/assembly_valheim.dll" | cut -c1-12)… assembly_valheim.dll ($(size_of "$MANAGED/assembly_valheim.dll") bytes)"
else
  say "                    ${RED}MISSING${OFF} — set --libs <valheim_Data/Managed> (or VALHEIM_MANAGED)"
fi
say "  build root      : ${SANDBOX:-$REPO/plugins (IN PLACE — dist/ will be overwritten)}"
say "  dotnet          : $(dotnet --version 2>/dev/null || echo 'NOT FOUND')"
# `dotnet build` restores Microsoft.NETFramework.ReferenceAssemblies. Say up front whether
# that is cached, rather than discovering a nuget.org round trip mid-stopped-window.
REFPKG_VER="$(grep -ho 'Microsoft.NETFramework.ReferenceAssemblies" Version="[^"]*' "$REPO/plugins"/*/*.csproj 2>/dev/null | sed 's/.*Version="//' | head -1)"
REFPKG_DIR="${NUGET_PACKAGES:-$HOME/.nuget/packages}/microsoft.netframework.referenceassemblies/${REFPKG_VER:-1.0.3}"
if [[ -d "$REFPKG_DIR" ]]; then
  say "  nuget           : ReferenceAssemblies ${REFPKG_VER:-1.0.3} cached — restore stays offline"
else
  say "  nuget           : ${YLW}ReferenceAssemblies ${REFPKG_VER:-1.0.3} NOT cached${OFF} — the first build will reach nuget.org"
fi
say ""
say "${BOLD}Plan${OFF}"
i=0
for p in "${PLUGINS[@]}"; do
  i=$((i + 1))
  csproj="$(ls "$REPO/plugins/$p"/*.csproj 2>/dev/null | head -1)"
  name="$(assembly_name "$csproj")"; ver="$(version_of "$csproj")"
  say "  $i. $p ($name $ver)"
  say "     ${DIM}refresh-libs.sh  →  dotnet build -c Release  →  md5/size diff  →  version + ValueTuple check${OFF}"
  say "     ${DIM}staging: ${STAGING[$p]}${OFF}"
  if [[ $STAGE == 1 ]]; then
    if [[ "${SIDE[$p]}" == SERVER ]]; then
      say "     ${DIM}--stage: cp → $STAGE_DIR/$name.dll, print md5 + SFTP dest ${SFTP_DEST[$p]}${OFF}"
    else
      pkg="${TS_PACKAGE[$p]}"; tsdir="$REPO/plugins/thunderstore/$pkg-$ver"
      if [[ -d "$tsdir" ]]; then
        cur="$(manifest_version "$tsdir/manifest.json")"
        say "     ${DIM}--stage: cp → plugins/thunderstore/$pkg-$ver/$name.dll (manifest says ${cur:-none}, wants $ver)${OFF}"
      else
        seed="$(newest_package_dir "$pkg")"
        say "     ${DIM}--stage: create plugins/thunderstore/$pkg-$ver/ from ${seed##*/}, cp DLL, prompt to bump manifest to $ver${OFF}"
      fi
    fi
  fi
done
say ""
if [[ $STAGE == 1 ]]; then
  say "${BOLD}Staging destination${OFF}  $STAGE_DIR ${DIM}(server DLLs; client DLLs go into plugins/thunderstore/)${OFF}"
  say ""
fi

if [[ $DRY_RUN == 1 ]]; then
  hr
  say "${BOLD}Dry run — nothing was refreshed, built, copied or uploaded.${OFF}"
  say "Re-run without --dry-run to execute. Reminders that are not automated here:"
  say "  · SERVER DLLs swap only while the GTX panel is STOPPED (Windows file-locks loaded DLLs)."
  say "  · Upload with a retrying loop: the lock can linger a few seconds after the process exits."
  say "  · Re-mint the modpack only AFTER any new client version is live on Thunderstore AND"
  say "    indexed in the community listing, or the pack imports as \"mod not found\"."
  if [[ $STAGE == 1 ]]; then
    say "  · --stage copies files and edits one manifest. It never uploads: the SFTP push is"
    say "    by hand in the stopped window, and the Thunderstore upload is Charlie's account."
  fi
  say ""
  exit 0
fi

if [[ ! -d "$MANAGED" ]]; then
  say "${RED}Game assemblies not found at $MANAGED${OFF}"
  say "Pass --libs /path/to/valheim_Data/Managed (on launch day: the 1.0 install, after Steam updates)."
  exit 1
fi

# In place is the default because that is what launch day needs — but it overwrites four
# git-tracked DLLs and re-copies each libs/ from whatever the Steam install currently holds,
# so a bare run on the wrong day rebuilds everything against the wrong game version. The
# repo's other destructive tool (launch-wipe.mjs) makes you type WIPE for the same reason.
if [[ -z "$SANDBOX" && $ASSUME_YES == 0 ]]; then
  say "${YLW}IN-PLACE rebuild — these tracked artifacts will be overwritten:${OFF}"
  for p in "${PLUGINS[@]}"; do
    csproj="$(ls "$REPO/plugins/$p"/*.csproj 2>/dev/null | head -1)"
    [[ -n "$csproj" ]] && say "  plugins/$p/dist/$(assembly_name "$csproj").dll"
  done
  say "${DIM}--sandbox <dir> builds copies instead · --dry-run prints the plan · --yes skips this prompt${OFF}"
  if [[ -t 0 ]]; then
    printf 'Type REBUILD to continue: '
    read -r confirm
    if [[ "$confirm" != "REBUILD" ]]; then
      say "${RED}Aborted — nothing was refreshed, built or copied.${OFF}"
      exit 1
    fi
  else
    say "${RED}Refusing: stdin is not a terminal and --yes was not passed.${OFF}"
    exit 1
  fi
  say ""
fi

if [[ -n "$SANDBOX" ]]; then
  mkdir -p "$SANDBOX"
  say "${YLW}Sandbox mode:${OFF} each plugin is copied to $SANDBOX/<plugin> and built there."
  say "${DIM}The repo's plugins/*/dist stays untouched, so the md5 comparison below is repo-dist vs freshly-built.${OFF}"
  say ""
fi

# ── build ───────────────────────────────────────────────────────────────────
for p in "${PLUGINS[@]}"; do
  hr
  src="$REPO/plugins/$p"
  if [[ -n "$SANDBOX" ]]; then
    work="$SANDBOX/$p"
    rm -rf "$work"
    cp -r "$src" "$work"
    # A stale obj/ carries the previous build's absolute paths; a clean one is cheap.
    rm -rf "$work/obj" "$work/bin"
  else
    work="$src"
  fi

  csproj="$(ls "$work"/*.csproj 2>/dev/null | head -1)"
  if [[ -z "$csproj" ]]; then
    say "${RED}FAIL${OFF} $p — no .csproj found in $work"
    RESULT_LINE[$p]="${RED}FAIL${OFF} no csproj"
    FAILURES=$((FAILURES + 1))
    continue
  fi
  name="$(assembly_name "$csproj")"
  ver="$(version_of "$csproj")"
  dll="$work/dist/$name.dll"
  # "before" is always the committed artifact, even in sandbox mode.
  before_md5="$(md5_of "$src/dist/$name.dll")"
  before_size="$(size_of "$src/dist/$name.dll")"
  before_stamp="$(stamp_of "$src/dist/$name.dll")"

  say "${BOLD}$p${OFF}  ${DIM}($name $ver)${OFF}"
  say "  before : $before_md5  $before_size bytes  ${DIM}[$before_stamp]${OFF}"

  # 1. refresh-libs.sh — each plugin copies only the assemblies it references.
  if [[ $SKIP_REFRESH == 1 ]]; then
    say "  libs   : ${DIM}skipped (--skip-refresh)${OFF}"
  else
    if ! out="$(VALHEIM_MANAGED="$MANAGED" bash "$work/refresh-libs.sh" 2>&1)"; then
      say "  libs   : ${RED}refresh-libs.sh FAILED${OFF}"
      printf '%s\n' "$out" | sed 's/^/           /'
      RESULT_LINE[$p]="${RED}FAIL${OFF} refresh-libs"
      FAILURES=$((FAILURES + 1))
      continue
    fi
    copied="$(printf '%s\n' "$out" | grep -c "^'" || true)"
    say "  libs   : refreshed from $MANAGED ($copied assemblies copied)"
  fi

  # 2. build
  build_args=("$csproj" -c Release --nologo)
  [[ -n "$SOURCE_REV" ]] && build_args+=("-p:SourceRevisionId=$SOURCE_REV")
  if ! out="$(dotnet build "${build_args[@]}" 2>&1)"; then
    say "  build  : ${RED}FAILED${OFF}"
    printf '%s\n' "$out" | grep -E "error|Error" | head -12 | sed 's/^/           /'
    RESULT_LINE[$p]="${RED}FAIL${OFF} compile error"
    FAILURES=$((FAILURES + 1))
    continue
  fi
  warns="$(printf '%s\n' "$out" | grep -cE "warning [A-Z]+[0-9]+" || true)"
  say "  build  : ok ($warns warning(s))"

  if [[ ! -f "$dll" ]]; then
    say "  after  : ${RED}dist/$name.dll was not produced${OFF}"
    RESULT_LINE[$p]="${RED}FAIL${OFF} no dist DLL"
    FAILURES=$((FAILURES + 1))
    continue
  fi

  # 3. md5 + size after
  after_md5="$(md5_of "$dll")"
  after_size="$(size_of "$dll")"
  after_stamp="$(stamp_of "$dll")"
  if [[ "$before_md5" == "$after_md5" ]]; then
    changed="${DIM}unchanged (byte-identical rebuild)${OFF}"
  elif [[ "$before_size" == "$after_size" && "$before_stamp" != "$after_stamp" ]]; then
    # Same size AND a different git stamp is consistent with a stamp-only change — but it does
    # NOT prove one: PE sections are 512-byte aligned, so a small code edit often lands at the
    # same size, and on launch day HEAD has moved too. Report the shape, name the proof.
    # The proof command needs the FULL 40-char sha: the stamp is the literal string
    # "<Version>+<sha>", so a truncated one produces different bytes and would read as a
    # code change. Printed on its own line below, not squeezed into the summary.
    before_sha="${before_stamp#*+}"
    changed="${YLW}md5 moved, size identical, stamp differs (MAY be stamp-only)${OFF}"
  else
    delta=$((after_size - before_size))
    changed="${YLW}CHANGED${OFF} (${delta:+$( ((delta >= 0)) && echo "+")}$delta bytes)"
  fi
  say "  after  : $after_md5  $after_size bytes  ${DIM}[$after_stamp]${OFF}  $changed"
  if [[ -n "${before_sha:-}" ]]; then
    say "  prove  : ${DIM}size and stamp cannot tell a stamp-only change from a code change. Rebuild this"
    say "           source with the OLD sha and compare: matches $before_md5 = stamp only.${OFF}"
    say "           ${DIM}bash scripts/rebuild-plugins.sh --only $p --sandbox /tmp/rb-proof --skip-refresh \\${OFF}"
    say "           ${DIM}  --libs '$MANAGED' --source-revision $before_sha${OFF}"
    before_sha=""
  fi

  # 4. version string present in the built DLL
  if strings -a "$dll" | grep -qF "$ver" || strings -el "$dll" | grep -qF "$ver"; then
    say "  version: ${GRN}$ver found in the DLL${OFF}"
    ver_ok=1
  else
    say "  version: ${RED}$ver NOT found in the DLL${OFF} — stale artifact, or <Version> was not compiled in"
    ver_ok=0
    FAILURES=$((FAILURES + 1))
  fi

  # 5. ValueTuple — TypeLoadException at runtime on Valheim's Mono, never at compile time.
  vt="$( { strings -a "$dll"; strings -el "$dll"; } | grep -i "valuetuple" | head -3 )"
  if [[ -n "$vt" ]]; then
    say "  tuples : ${RED}ValueTuple REFERENCED${OFF} — this DLL will TypeLoadException in game"
    printf '%s\n' "$vt" | sed 's/^/           /'
    vt_ok=0
    FAILURES=$((FAILURES + 1))
  else
    say "  tuples : ${GRN}no ValueTuple reference${OFF}"
    vt_ok=1
  fi

  BUILT_NAME[$p]="$name"; BUILT_VER[$p]="$ver"; BUILT_DLL[$p]="$dll"
  if [[ $ver_ok == 1 && $vt_ok == 1 ]]; then
    BUILT_OK[$p]=1
    RESULT_LINE[$p]="${GRN}OK${OFF} $name $ver  $after_md5  $after_size bytes  ${changed}"
  else
    RESULT_LINE[$p]="${RED}FAIL${OFF} $name $ver — see above"
  fi
  say "  dll    : ${DIM}$dll${OFF}"
done

# ── staging summary ─────────────────────────────────────────────────────────
hr
say ""
say "${BOLD}Staging summary${OFF}"
for p in "${PLUGINS[@]}"; do
  printf '  %-24s %s\n' "$p" "${RESULT_LINE[$p]:-${YLW}not built${OFF}}"
  printf '  %-24s %s\n' "" "${DIM}${STAGING[$p]}${OFF}"
done
# ── stage ───────────────────────────────────────────────────────────────────
# The gate comes BEFORE the copying, not after. A run that ends with "do not stage
# any of this" printed underneath files that are already on disk and a manifest
# that is already bumped is worse than one that never started: a half-staged tree
# is exactly what gets uploaded by mistake on a morning like this one.
if [[ $STAGE == 1 && $FAILURES -gt 0 ]]; then
  hr
  say ""
  say "${RED}${BOLD}Staging skipped: $FAILURES check(s) failed.${OFF}"
  say "  Nothing was copied and no manifest was touched. Fix the failures above and"
  say "  re-run. Individual plugins that passed are not staged either, because a"
  say "  partly-staged directory is indistinguishable from a complete one an hour later."
  say ""
  STAGE=0
fi
if [[ $STAGE == 1 ]]; then
  hr
  say ""
  say "${BOLD}Staging${OFF}  ${DIM}copies only. Nothing here uploads.${OFF}"
  mkdir -p "$STAGE_DIR"
  say "  server dir : $STAGE_DIR"
  say ""

  for p in "${PLUGINS[@]}"; do
    name="${BUILT_NAME[$p]:-}"
    if [[ -z "$name" || "${BUILT_OK[$p]:-0}" != 1 ]]; then
      say "  ${YLW}skip${OFF}   $p — did not pass its checks, so nothing is staged for it"
      continue
    fi
    src="${BUILT_DLL[$p]}"
    ver="${BUILT_VER[$p]}"

    if [[ "${SIDE[$p]}" == SERVER ]]; then
      dest="$STAGE_DIR/$name.dll"
      if ! cp "$src" "$dest"; then
        say "  ${RED}FAIL${OFF}   $p — could not copy $src"
        FAILURES=$((FAILURES + 1))
        continue
      fi
      say "  ${GRN}SERVER${OFF} $name $ver"
      say "         local : $dest"
      say "         md5   : $(md5_of "$dest")"
      say "         sftp  : ${BOLD}${SFTP_DEST[$p]}${OFF}"
      say "         ${DIM}Panel STOPPED first. The Windows lock outlives the process, so retry the put.${OFF}"
      continue
    fi

    # CLIENT: plugins/thunderstore/<Pkg>-<ver>/ is the upload staging dir.
    pkg="${TS_PACKAGE[$p]}"
    tsdir="$REPO/plugins/thunderstore/$pkg-$ver"
    seed=""   # per-plugin: without this the next plugin inherits the last one's seed
    if [[ ! -d "$tsdir" ]]; then
      seed="$(newest_package_dir "$pkg")"
      if [[ -z "$seed" ]]; then
        say "  ${RED}FAIL${OFF}   $p — no existing plugins/thunderstore/$pkg* to seed $pkg-$ver from"
        FAILURES=$((FAILURES + 1))
        continue
      fi
      mkdir -p "$tsdir"
      # Only the files Thunderstore reads. UPLOAD.md is per-version notes and is
      # deliberately NOT carried over: last version's instructions are worse than none.
      for f in manifest.json icon.png README.md CHANGELOG.md; do
        [[ -f "$seed/$f" ]] && cp "$seed/$f" "$tsdir/$f"
      done
      say "  ${GRN}CLIENT${OFF} $name $ver  ${DIM}(new dir, seeded from ${seed##*/})${OFF}"
    else
      say "  ${GRN}CLIENT${OFF} $name $ver"
    fi

    if ! cp "$src" "$tsdir/$name.dll"; then
      say "         ${RED}could not copy $src${OFF}"
      FAILURES=$((FAILURES + 1))
      continue
    fi
    say "         dir   : plugins/thunderstore/$pkg-$ver/"
    say "         md5   : $(md5_of "$tsdir/$name.dll")"

    # The manifest version is what Thunderstore validates the upload against, and
    # a seeded copy still carries the OLD number. Uploading that is rejected as a
    # duplicate version, which reads on launch morning like the upload is broken.
    mver="$(manifest_version "$tsdir/manifest.json")"
    if [[ "$mver" == "$ver" ]]; then
      say "         manifest: version_number already $ver"
    else
      say "         ${YLW}manifest: version_number is \"${mver:-missing}\", the build is $ver${OFF}"
      bump=0
      if [[ $ASSUME_YES == 1 ]]; then
        bump=1
        say "         ${DIM}--yes: bumping it${OFF}"
      elif [[ -t 0 ]]; then
        printf '         Set version_number to %s in plugins/thunderstore/%s-%s/manifest.json? [y/N] ' "$ver" "$pkg" "$ver"
        read -r reply
        [[ "$reply" == [yY] || "$reply" == [yY][eE][sS] ]] && bump=1
      else
        say "         ${DIM}stdin is not a terminal and --yes was not passed: left alone${OFF}"
      fi
      if [[ $bump == 1 ]]; then
        if sed -i "s/\(\"version_number\"[[:space:]]*:[[:space:]]*\)\"[^\"]*\"/\1\"$ver\"/" "$tsdir/manifest.json" \
          && [[ "$(manifest_version "$tsdir/manifest.json")" == "$ver" ]]; then
          say "         ${GRN}manifest: version_number = $ver${OFF}"
        else
          say "         ${RED}manifest: the bump did not take — edit it by hand${OFF}"
          FAILURES=$((FAILURES + 1))
        fi
      else
        say "         ${YLW}manifest left at ${mver:-missing}. Thunderstore will reject the upload.${OFF}"
      fi
    fi
    # Three files describe the release and NONE of them can be derived from a
    # build. README.md is the package PAGE, and a seeded copy describes the
    # PREVIOUS version: an EilifPaths 1.5.0 page that says nothing about
    # [VPlusFallback] while the pack ships Enabled = true is a disclosure gap, not
    # a cosmetic one. It is not copied from plugins/<dir>/README.md either - that
    # file is a 20KB developer document, not a store page - so it is written by
    # hand, using the plugin's README and CHANGELOG as the source.
    say "         ${YLW}--stage cannot write these three. Do them before the zip:${OFF}"
    say "         ${YLW}  README.md  ${OFF}${DIM}the package page. Still describes $( [[ -n "${seed:-}" ]] && echo "${seed##*/}" || echo "the previous version" ).${OFF}"
    say "         ${YLW}  CHANGELOG.md${OFF}${DIM}  same: seeded, not generated.${OFF}"
    say "         ${YLW}  manifest description${OFF}${DIM}  carried over verbatim, and it is what the${OFF}"
    say "         ${DIM}                       package list shows. Check dependencies while you are in there.${OFF}"
    say "         ${DIM}Source material: plugins/$p/README.md (a dev doc, not a store page).${OFF}"
    say "         ${DIM}(cd plugins/thunderstore/$pkg-$ver && zip -qr ../$pkg-$ver.zip . -x '*.zip' 'UPLOAD.md')${OFF}"
  done
  say ""
fi

say ""
say "${BOLD}What has to happen next, in this order${OFF}"
say "  1. Panel ${BOLD}Stop${OFF}. Loaded DLLs are file-locked on the Windows host, so the two SERVER"
say "     plugins can only be swapped while the server is down. Use a retrying upload: the lock"
say "     can linger a few seconds after the process exits."
say "  2. Do the rest of the stopped-window work in the same window (world upload, Start.bat"
say "     fields, death penalty Casual, plugin cfgs off the old world)."
say "  3. Panel ${BOLD}Start${OFF} (Stop then Start, never Restart), then:"
say "       bash scripts/verify-restart.sh <World>"
say "     and confirm every rebuilt plugin appears in this boot's 'Loading [...]' list at the"
say "     version printed above."
say "  4. CLIENT plugins: upload to Thunderstore, wait for the community listing index to pick"
say "     the version up, and only then re-mint the modpack and bump MODPACK_VERSION_LABEL in"
say "     config/server.ts. A pack pinning an unindexed version imports as \"mod not found\"."
say "  5. node scripts/launch-preflight.mjs --world <World> --phase post-start"
say ""

if [[ $FAILURES -gt 0 ]]; then
  say "${RED}${BOLD}$FAILURES check(s) failed. Do not stage any of this.${OFF}"
  say ""
  exit 1
fi
say "${GRN}${BOLD}All plugins built and checked.${OFF}"
say ""
