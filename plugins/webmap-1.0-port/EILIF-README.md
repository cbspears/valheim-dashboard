# WebMap 2.7.1, Valheim 1.0 port (2026-09-09)

Third-party code: h0tw1r3/valheim-webmap (MIT, see LICENSE) as repacked on Thunderstore by
Zevaryx. This tree is upstream `main` at 2.7.1 plus:

1. Upstream pull request #24 by bekcarts (`fix/valheim-1.0-compat`, commit 98eebb0): recompile
   against 1.0 (fixes `WorldGenerator.GetBiomeHeight` gaining optional params and inlines the
   now-const `ZRoutedRpc.Everybody`), `ZNet.m_hostPort` -> `ZNet.m_serverHostPort`, and the fake
   "Server" player entry's `m_serverAssignedDisplayName` moving onto `m_userInfo`.
2. Eilif fixes on top of that PR (`eilif-changes-vs-pr24.patch`): 1.0 moved player-list packet
   building into `ZNet.WritePlayerInfo`, so the old `SendPlayerList` transpiler fed an unassigned
   local and threw `NullReferenceException` on every join. Replaced with a Harmony postfix on
   `WritePlayerInfo`. Also `m_playfabId = ""` on the fake entry (a null string would throw in
   `BinaryWriter.Write`).

Build: `libs/valheim/` = the 1.0 dedicated server's `valheim_server_Data/Managed/` (publicize
`assembly_valheim.dll` and `assembly_utils.dll` with bepinex.assemblypublicizer.cli), plus
`libs/BepInEx/core/`. `dotnet build -c Release WebMap/WebMap.csproj`. Keep `<Version>2.7.1</Version>`.

Shipped to the GTX box 2026-09-09 11:40 CT: WebMap.dll md5 8360f7d5adc6b49ad84f3be029673881,
39,936 bytes. Proven on a local 1.0 dedicated server with a real client join (0 exceptions).
Deployment: the DLL, `websocket-sharp.dll` and the `web/` folder from the Thunderstore package go
in `BepInEx/plugins/WebMap/`; cfg `com.github.h0tw1r3.valheim.webmap.cfg` with `always_map = true`.
