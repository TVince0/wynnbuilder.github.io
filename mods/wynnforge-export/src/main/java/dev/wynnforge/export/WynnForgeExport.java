package dev.wynnforge.export;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.serialization.JsonOps;
import dev.wynnforge.export.mixin.HandledScreenAccessor;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandRegistrationCallback;
import net.fabricmc.fabric.api.client.screen.v1.ScreenEvents;
import net.fabricmc.fabric.api.client.screen.v1.ScreenKeyboardEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.ingame.HandledScreen;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.screen.slot.Slot;
import net.minecraft.text.Text;
import org.lwjgl.glfw.GLFW;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import static net.fabricmc.fabric.api.client.command.v2.ClientCommandManager.literal;

/** Only reads item components already sent to the client. No server packets or web requests. */
public final class WynnForgeExport implements ClientModInitializer {
    private static final Gson JSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();
    private record LocatedItem(ItemStack stack, String location) {}

    @Override
    public void onInitializeClient() {
        ScreenEvents.AFTER_INIT.register((client, screen, width, height) -> {
            if (!(screen instanceof HandledScreen<?>)) return;
            ScreenKeyboardEvents.allowKeyPress(screen).register((s, key) -> {
                if (key.key() != GLFW.GLFW_KEY_C ||
                        (key.modifiers() & (GLFW.GLFW_MOD_CONTROL | GLFW.GLFW_MOD_SHIFT)) !=
                                (GLFW.GLFW_MOD_CONTROL | GLFW.GLFW_MOD_SHIFT)) return true;
                Slot slot = ((HandledScreenAccessor) s).wynnforge$getFocusedSlot();
                if (slot == null || !slot.hasStack()) {
                    tell(client, "Hover an item, then press Ctrl+Shift+C.");
                } else {
                    export(client, List.of(new LocatedItem(slot.getStack(), "hovered:" + slot.id)));
                }
                return false;
            });
        });
        ClientCommandRegistrationCallback.EVENT.register((dispatcher, registryAccess) ->
            dispatcher.register(literal("wynnforge")
                .executes(context -> {
                    tell(MinecraftClient.getInstance(), "Hover gear and press Ctrl+Shift+C, or use /wynnforge hand or /wynnforge inventory.");
                    return 1;
                })
                .then(literal("hand").executes(context -> {
                    MinecraftClient client = MinecraftClient.getInstance();
                    return export(client, List.of(new LocatedItem(client.player.getMainHandStack(), "hand")));
                }))
                .then(literal("inventory").executes(context -> {
                    MinecraftClient client = MinecraftClient.getInstance();
                    List<LocatedItem> items = new ArrayList<>();
                    for (int i = 0; i < client.player.getInventory().size(); i++) {
                        ItemStack stack = client.player.getInventory().getStack(i);
                        if (!stack.isEmpty() && stack.contains(DataComponentTypes.LORE))
                            items.add(new LocatedItem(stack, "inventory:" + i));
                    }
                    return export(client, items);
                }))));
    }

    private static int export(MinecraftClient client, List<LocatedItem> stacks) {
        if (client.player == null || client.world == null) return 0;
        try {
            JsonObject root = new JsonObject();
            root.addProperty("format", "wynnforge.items");
            root.addProperty("version", 1);
            root.addProperty("minecraftVersion", "1.21.11");
            root.addProperty("exporterVersion", "1.0.0");
            root.addProperty("exportedAt", Instant.now().toString());
            JsonArray items = new JsonArray();
            for (LocatedItem located : stacks) {
                ItemStack stack = located.stack();
                if (stack.isEmpty()) continue;
                JsonObject row = new JsonObject();
                row.addProperty("name", stack.getName().getString());
                row.addProperty("minecraftId", Registries.ITEM.getId(stack.getItem()).toString());
                row.addProperty("sourceSlot", located.location());
                JsonArray lore = new JsonArray();
                var component = stack.get(DataComponentTypes.LORE);
                if (component != null) component.lines().forEach(line -> lore.add(line.getString()));
                row.add("lore", lore);
                // Preserve styled text, custom data, hidden tags and original numeric values.
                // The website treats this as inert source data, never as executable content.
                row.add("rawItem", ItemStack.CODEC.encodeStart(
                        client.world.getRegistryManager().getOps(JsonOps.INSTANCE), stack).getOrThrow());
                items.add(row);
            }
            if (items.isEmpty()) {
                tell(client, "No items to export.");
                return 0;
            }
            root.add("items", items);
            String value = JSON.toJson(root);
            client.keyboard.setClipboard(value);
            // A file backup remains available even when switching windows changes the clipboard.
            try {
                Path directory = FabricLoader.getInstance().getGameDir().resolve("wynnforge-exports");
                Files.createDirectories(directory);
                Path target = directory.resolve("items-" + Instant.now().toEpochMilli() + "-" +
                        java.util.UUID.randomUUID().toString().substring(0, 8) + ".json");
                Files.writeString(target, value, StandardCharsets.UTF_8);
                tell(client, "Copied " + items.size() + " item(s). Paste into WynnForge's Import game items. Backup: wynnforge-exports/" + target.getFileName());
            } catch (Exception backupError) {
                tell(client, "Copied " + items.size() + " item(s). File backup failed: " + backupError.getClass().getSimpleName());
            }
            return items.size();
        } catch (Exception error) {
            tell(client, "Export failed: " + error.getClass().getSimpleName());
            return 0;
        }
    }

    private static void tell(MinecraftClient client, String message) {
        if (client.player != null) client.player.sendMessage(Text.literal("[WynnForge] " + message), false);
    }
}
