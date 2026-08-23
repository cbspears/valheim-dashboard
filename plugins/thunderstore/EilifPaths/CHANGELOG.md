# Changelog

## 1.2.0
- Beds: the "you need a fire nearby" check now reaches 8 metres further than vanilla, so a bed no longer has to sit almost inside the hearth. Configurable as `[Bed] extraFireRange` (0 restores vanilla). The check is wrapped so any failure falls back to vanilla bed behaviour.

## 1.1.0
- One speed tier across every surface: x1.4 movement and zero stamina drain on dirt paths, paved roads, and all built floors.

## 1.0.0
- Initial release: a working replacement for the abandoned Useful Paths. Detects dirt paths and paved roads through the Heightmap paint mask, which is how current Valheim actually stores terrain paint, plus built floors through WearNTear.
