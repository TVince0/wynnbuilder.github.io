/* Review copied game items before changing the native equipment graph. */
const WynnForgeImportUI = (() => {
  const el = (tag, text, attrs = {}) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    return node;
  };
  function mount() {
    const host = document.getElementById("build-optimizer");
    if (!host || document.getElementById("wynnforge-import-open")) return;
    const button = el("button", "Import game items", {id: "wynnforge-import-open", type: "button", class: "optimizer-button"});
    host.querySelector(".optimizer-hero").append(button);
    const dialog = el("dialog", null, {class: "optimizer-dialog wynnforge-import", "aria-labelledby": "wynnforge-import-title"});
    dialog.append(el("h2", "Import Wynncraft items", {id: "wynnforge-import-title"}),
      el("p", "Hover an item in Minecraft and press Ctrl+Shift+C with WynnForge Item Export installed. Paste its JSON here, or open an exported file."));
    const install = el("p");
    install.append(el("a", "Download Fabric 1.21.11 mod", {href: "../downloads/wynnforge-export-1.0.0.jar", download: "wynnforge-export-1.0.0.jar"}),
      document.createTextNode(" · Requires Fabric API for 1.21.11."));
    dialog.append(install);
    const input = el("textarea", null, {id: "wynnforge-import-json", class: "optimizer-input", rows: "6", placeholder: "Paste copied item JSON", "aria-label": "WynnForge item export JSON", spellcheck: "false"});
    const file = el("input", null, {id: "wynnforge-import-file", type: "file", accept: ".json,application/json", "aria-label": "Open item export JSON"});
    const status = el("p", "", {role: "status", "aria-live": "polite"});
    const list = el("div", null, {class: "wynnforge-import-list"});
    const actions = el("div", null, {class: "optimizer-actions"});
    const preview = el("button", "Review items", {type: "button", class: "optimizer-button"});
    const apply = el("button", "Apply selected items", {type: "button", class: "optimizer-button optimizer-primary", disabled: ""});
    const cancel = el("button", "Close", {type: "button", class: "optimizer-button"});
    let selection = [], reviewedText = "";
    const invalidate = () => {selection = []; reviewedText = ""; list.replaceChildren(); apply.disabled = true; status.textContent = "";};
    input.oninput = invalidate;
    file.onchange = async () => {
      invalidate();
      const chosen = file.files?.[0];
      try {
        if (!chosen) return;
        if (chosen.size > WynnForgeItems.maxBytes) throw Error("Export exceeds the 8 MB limit.");
        input.value = await chosen.text();
        review();
      } catch (error) {status.textContent = error.message;}
      finally { file.value = ""; }
    };
    function review() {
      invalidate();
      try {
        const rows = WynnForgeItems.parse(input.value, itemMap);
        const used = new Set();
        reviewedText = input.value;
        for (const row of rows) {
          const card = el("section", null, {class: "wynnforge-import-item"});
          card.append(el("h3", row.name));
          if (row.error) {card.append(el("p", row.error, {class: "optimizer-error"}));}
          else {
            const label = el("label", "Equip in ");
            const select = el("select", null, {class: "optimizer-input", "aria-label": "Destination for " + row.name});
            select.append(el("option", "Skip this item", {value: ""}));
            for (const slot of WynnForgeItems.slotsFor(row.type)) select.append(el("option", slot, {value: slot}));
            const free = WynnForgeItems.slotsFor(row.type).find(slot => !used.has(slot));
            select.value = free || "";
            if (free) used.add(free);
            label.append(select);
            card.append(label);
            const values = el("dl", null, {class: "wynnforge-roll-values"});
            for (const [id, value] of Object.entries(row.actual)) values.append(el("dt", OptimizerModel.label(id)), el("dd", String(value)));
            if (!values.children.length) card.append(el("p", "Fixed identifications from the native item template."));
            card.append(values, el("p", row.warnings.join(" ")));
            selection.push({row, select});
          }
          list.append(card);
        }
        apply.disabled = !selection.length;
        const errors = rows.filter(row => row.error).length;
        status.textContent = selection.length + " item(s) ready for review" + (errors ? "; " + errors + " item(s) could not be imported." : ".") + " Selected pieces replace their slots, clear that slot's powders and lock their copied rolls for search.";
      } catch (error) { status.textContent = error.message; }
    }
    preview.onclick = review;
    apply.onclick = () => {
      try {
        if (input.value !== reviewedText) throw Error("Review the edited export before applying.");
        const chosen = selection.filter(entry => entry.select.value);
        if (!chosen.length) throw Error("Choose a destination for at least one item.");
        const slots = chosen.map(entry => entry.select.value);
        if (new Set(slots).size !== slots.length) throw Error("Choose a different destination for each item.");
        BuildOptimizer.applyOwnedImport(chosen.map(({row, select}) => ({slot: select.value, source: row.source})));
        dialog.close();
      } catch (error) { status.textContent = error.message; }
    };
    cancel.onclick = () => dialog.close();
    button.onclick = () => dialog.showModal();
    actions.append(preview, apply, cancel);
    dialog.append(input, file, status, list, actions);
    document.body.append(dialog);
  }
  return {mount};
})();
