# WynnForge Item Export · Fabric 1.21.11

Copies the item data already visible to your Minecraft client into WynnForge. It preserves the original item components and lore, including displayed identification values. This is a client mod; it does not duplicate items or change anything on the server.

## Install and copy

1. Install **Minecraft 1.21.11**, **Fabric Loader 0.18.4 or newer**, and **Fabric API for 1.21.11**. Java 21 is required. Wynntils is optional.
2. Put [wynnforge-export-1.0.0.jar](../../downloads/wynnforge-export-1.0.0.jar) in that Minecraft instance's `mods` folder and restart.
3. In an inventory or bank, show an item's **identification tooltip page**, hover the item, and press **Ctrl+Shift+C**. Alternatively, hold it and run `/wynnforge hand`.
4. Open this fork's `/builder/` page. Choose **Import game items**, paste the copied JSON, and choose **Review items**. You can also open a JSON backup from the Minecraft instance's `wynnforge-exports` folder.
5. Review the displayed values and destination slots, then choose **Apply selected items**. Imported slots are locked for optimization. Use **Edit rolls** to inspect them. Set powders in the native equipment editor after importing; importing clears powders on replaced slots.

`/wynnforge inventory` copies all lore-bearing stacks in your player inventory, including equipped armour. Each copy stays separate, so two rings with the same name can have different rolls. Choose which copies to equip in the review dialog. Inventory exports may also include non-equipment; those rows show an explanation and can be skipped.

Exports stay on your clipboard and in local JSON backups. No account login, external API, server plugin or network upload is used by the mod. Treat backups like other exported item data; they include the original client-visible custom data.

## What the importer checks

The website matches ordinary identified gear against the **currently loaded WynnBuilder database version**. It reads actual identification amounts and their units, including negative values and spell costs. It does not estimate the original hidden random seed or the internal percentage that produced a rounded value.

Every variable identification must be present and within that database version's range. Missing values, unsupported lore and conflicting values block that row instead of falling back to perfect rolls. If a tooltip page hides some IDs, select the identification page and copy again. If a zero value is omitted by the server, set up that piece manually with **Edit rolls**. Unknown, unidentified, crafted or renamed gear requires manual setup. Fixed IDs, base stats, requirements, set and major IDs come from the matching native template.

The mod preserves raw components for troubleshooting and future format support; the website treats them as inert data. This initial importer copies identification values. Powder loadouts, tomes and ability trees are configured using the native builder controls.

## Build

Use a JDK 21 installation. From this directory:

```sh
./gradlew build
```

On Windows, run `gradlew.bat build`. The installable remapped jar is `build/libs/wynnforge-export-1.0.0.jar`; the `-sources.jar` is for development. The build pins Minecraft 1.21.11, Yarn 1.21.11+build.6, Fabric Loom 1.14.10 and Fabric API 0.141.6+1.21.11. The Gradle wrapper uses 9.2.1.

## Export contract

```json
{
  "format": "wynnforge.items",
  "version": 1,
  "minecraftVersion": "1.21.11",
  "exporterVersion": "1.0.0",
  "exportedAt": "2026-11-25T00:00:00Z",
  "items": [{
    "name": "Example item",
    "minecraftId": "minecraft:leather_helmet",
    "sourceSlot": "hovered:5",
    "lore": ["Mana Regen +7/5s"],
    "rawItem": {"id": "minecraft:leather_helmet", "count": 1, "components": {}}
  }]
}
```

The example shows the shape, not an importable equipment fixture. The reader accepts at most 8 MB and 256 rows. Unknown versions are rejected. `lore` contains original plain text including resource-pack glyphs; `rawItem` is Minecraft's registry-aware item codec output and retains styled text.

## Validation limits

The build checks Java compilation and remapping against 1.21.11. Website tests cover lore parsing, database range checks, distinct copies, rejection of incomplete imports, native equipment application, powder clearing, slot locks and sharing/reload. A live Wynncraft session is still needed to validate the server's current tooltip presentation and in-game clipboard/file behavior.
