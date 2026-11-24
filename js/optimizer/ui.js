/* Add search and owned-item rolls directly to the native WynnBuilder page. */
const BuildOptimizer = (() => {
  const slots = OptimizerModel.slots;
  const stateKey = "wynnbuilder.optimizer.v1";
  const overrides = new Map();
  let mode = "optimistic",
    worker = null,
    results = [],
    currentPool = null;
  let panel, rulesBox, resultBox, message, runButton, cancelButton, rollDialog;
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(stateKey) || "{}");
  } catch {
    saved = {};
  }
  function element(tag, attrs = {}, text) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "class") node.className = value;
      else node.setAttribute(key, String(value));
    }
    if (text !== undefined) node.textContent = text;
    return node;
  }
  const field = (name) => document.getElementById(name + "-choice");
  const title = (slot) =>
    ({ ring1: "Ring I", ring2: "Ring II" })[slot] ||
    slot[0].toUpperCase() + slot.slice(1);
  const format = (number) =>
    Number(number).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const count = (value) => {
    const n = Number(value);
    return n > 1e9 ? n.toExponential(2) : n.toLocaleString();
  };
  function notice(text, bad = false) {
    message.textContent = text;
    message.classList.toggle("optimizer-error", bad);
  }
  function persist() {
    const value = {
      mode,
      rules: readRules(),
      objective: document.getElementById("optimizer-objective").value,
      direction: document.getElementById("optimizer-direction").value,
      minLevel: document.getElementById("optimizer-min-level").value,
      rarity: document.getElementById("optimizer-rarity").value,
      locks: slots.filter(
        (slot) => document.getElementById("optimizer-lock-" + slot).checked,
      ),
    };
    try {
      localStorage.setItem(stateKey, JSON.stringify(value));
    } catch {
      notice(
        "Browser storage is unavailable. Your settings apply to this session.",
      );
    }
  }
  function resolveItem(item, slot) {
    // Tomes use their selected native definition, including guild skill bonuses.
    if (!slots.includes(slot) || item.statMap.has("NONE")) return item;
    const entry = overrides.get(slot);
    const name = item.statMap.get("displayName");
    if (entry && entry.name !== name) overrides.delete(slot);
    return OptimizerModel.roll(
      item,
      mode,
      entry?.name === name ? entry.actual : {},
    );
  }
  function queryString() {
    const active = Object.fromEntries(
      [...overrides].filter(
        ([slot, entry]) => field(slot)?.value === entry.name,
      ),
    );
    const params = new URLSearchParams(location.search);
    if (mode !== "optimistic" || Object.keys(active).length)
      params.set("optimizer", JSON.stringify({ v: 1, mode, owned: active }));
    else params.delete("optimizer");
    return params.size ? "?" + params : "";
  }
  function readRules() {
    if (!rulesBox) return saved.rules || [];
    return [...rulesBox.children].map((row) => ({
      stat: row.querySelector("select").value,
      min:
        row.querySelector("[data-bound=min]").value === ""
          ? null
          : Number(row.querySelector("[data-bound=min]").value),
      max:
        row.querySelector("[data-bound=max]").value === ""
          ? null
          : Number(row.querySelector("[data-bound=max]").value),
    }));
  }
  function metrics() {
    return [
      ...OptimizerModel.baseMetrics,
      ...rolledIDs.map((key) => [key, OptimizerModel.label(key)]),
      ...skp_order.map((key) => [
        "final" + key,
        "Final " + skill[skp_order.indexOf(key)],
      ]),
    ];
  }
  function statSelect(value) {
    const select = element("select", { class: "optimizer-input" });
    for (const [key, label] of metrics())
      select.append(element("option", { value: key }, label));
    select.value = value || "regen";
    return select;
  }
  function addRule(rule = {}) {
    const row = element("div", { class: "optimizer-rule" });
    const select = statSelect(rule.stat);
    select.setAttribute("aria-label", "Target stat");
    row.append(select);
    for (const name of ["min", "max"]) {
      const input = element("input", {
        type: "number",
        step: "any",
        class: "optimizer-input",
        "data-bound": name,
        "aria-label": name === "min" ? "Minimum value" : "Maximum value",
        placeholder: name === "min" ? "Minimum" : "Maximum",
      });
      input.value = rule[name] ?? "";
      row.append(input);
    }
    const remove = element(
      "button",
      {
        type: "button",
        class: "optimizer-button",
        "aria-label": "Remove target",
      },
      "×",
    );
    remove.onclick = () => {
      row.remove();
      cancel();
      persist();
    };
    row.append(remove);
    rulesBox.append(row);
  }
  function cancel() {
    if (worker) worker.terminate();
    worker = null;
    runButton.disabled = false;
    cancelButton.hidden = true;
  }
  function refreshBuild() {
    cancel();
    results = [];
    resultBox.replaceChildren();
    for (const node of equip_inputs.slice(0, 9)) node.mark_dirty();
    for (const node of equip_inputs.slice(0, 9)) node.update();
    persist();
  }
  function rollEditor(slot) {
    const node = equip_inputs[slots.indexOf(slot)];
    const name = field(slot).value;
    const record = itemMap.get(name);
    const item = record ? new Item(record) : node.get_value()?.copy();
    if (!item || item.statMap.has("NONE")) {
      notice("Choose a " + title(slot).toLowerCase() + " first.", true);
      return;
    }
    const map = item.statMap,
      original = overrides.get(slot);
    rollDialog.replaceChildren();
    const heading = element("h3", {}, title(slot) + " · " + name);
    rollDialog.append(
      heading,
      element(
        "p",
        {},
        "Enter identified values. Empty fields use the selected roll scenario.",
      ),
    );
    const form = element("form", { method: "dialog" });
    const fields = element("div", { class: "optimizer-roll-fields" });
    const keys = [
      ...rolledIDs.filter(
        (key) => map.get("minRolls").get(key) || map.get("maxRolls").get(key),
      ),
      ...["hp", "eDef", "tDef", "wDef", "fDef", "aDef", ...skp_order].filter(
        (key) => map.get(key),
      ),
    ];
    for (const key of keys) {
      const row = element("label", { class: "optimizer-roll-row" });
      const lo = map.get("minRolls").get(key) ?? map.get(key),
        hi = map.get("maxRolls").get(key) ?? map.get(key);
      row.append(
        element("span", {}, OptimizerModel.label(key)),
        element("small", {}, lo === hi ? String(lo) : lo + " … " + hi),
      );
      const input = element("input", {
        class: "optimizer-input",
        type: "number",
        step: "any",
        "data-stat": key,
        placeholder: String(
          mode === "optimistic"
            ? hi
            : mode === "pessimistic"
              ? lo
              : Math.round((lo + hi) / 2),
        ),
      });
      input.value = original?.name === name ? (original.actual[key] ?? "") : "";
      row.append(input);
      fields.append(row);
    }
    form.append(fields);
    const actions = element("div", { class: "optimizer-actions" });
    const auto = element(
      "button",
      { type: "button", class: "optimizer-button" },
      "Use scenario",
    );
    auto.onclick = () => {
      overrides.delete(slot);
      rollDialog.close();
      refreshBuild();
    };
    const dismiss = element(
      "button",
      { type: "button", class: "optimizer-button" },
      "Cancel",
    );
    dismiss.onclick = () => rollDialog.close();
    const save = element(
      "button",
      { type: "submit", class: "optimizer-button optimizer-primary" },
      "Save actual rolls",
    );
    actions.append(auto, dismiss, save);
    form.append(actions);
    form.onsubmit = (event) => {
      event.preventDefault();
      const actual = {};
      for (const input of fields.querySelectorAll("input")) {
        if (input.value === "") continue;
        const value = Number(input.value);
        if (!Number.isFinite(value)) return;
        actual[input.dataset.stat] = value;
      }
      overrides.set(slot, { name, actual });
      document.getElementById("optimizer-lock-" + slot).checked = true;
      rollDialog.close();
      refreshBuild();
    };
    rollDialog.append(form);
    rollDialog.showModal();
  }
  function ensureReady() {
    if (!build_node || equip_inputs.length < 9)
      throw new Error("The native item database is still loading.");
    const levelNode = build_node.inputs.get("level-input").node;
    for (const node of [...equip_inputs, ...powder_nodes, levelNode]) {
      if (node.update_task !== null) {
        clearTimeout(node.update_task);
        node.update_task = null;
      }
      node.update();
    }
  }
  function powderFor(slot) {
    const node = powder_nodes.find((node) => node.name === slot + "-powder");
    return node?.get_value() || [];
  }
  function readConfig() {
    const rules = readRules();
    if (
      rules.some(
        (r) =>
          (r.min != null && !Number.isFinite(r.min)) ||
          (r.max != null && !Number.isFinite(r.max)) ||
          (r.min != null && r.max != null && r.min > r.max),
      )
    )
      throw new Error("Each target needs a valid minimum and maximum.");
    const level = Number(field("level").value);
    const minLevel = Number(
      document.getElementById("optimizer-min-level").value,
    );
    if (!Number.isInteger(level) || level < 1 || level > 121)
      throw new Error("Combat level must be a whole number from 1 to 121.");
    if (!Number.isInteger(minLevel) || minLevel < 1 || minLevel > level)
      throw new Error(
        "Minimum gear level must be between 1 and your combat level.",
      );
    let type = document.getElementById("optimizer-class").value;
    if (type === "current") {
      type = item_final_nodes[8]?.get_value()?.statMap.get("type");
      if (
        !weaponTypes.includes(type) ||
        item_final_nodes[8].get_value().statMap.has("NONE")
      )
        throw new Error("Choose a weapon above or select the search class.");
    }
    return {
      rules,
      level,
      minLevel,
      weaponType: type,
      characterClass: wep_to_class.get(type),
      objective: document.getElementById("optimizer-objective").value,
      direction: document.getElementById("optimizer-direction").value,
      limit: Number(document.getElementById("optimizer-limit").value),
      duplicateRings: document.getElementById("optimizer-duplicates").checked,
    };
  }
  function search() {
    cancel();
    resultBox.replaceChildren();
    results = [];
    try {
      ensureReady();
      const config = readConfig();
      const rarity = document.getElementById("optimizer-rarity").value;
      const catalog = [...itemMap.values()].filter(
        (record) =>
          !none_items.includes(record) &&
          record.remapID === undefined &&
          (!currentPool || currentPool.has(record.name)) &&
          (record.lvl || 0) >= config.minLevel &&
          (record.lvl || 0) <= config.level &&
          (!record.classReq ||
            String(record.classReq).toLowerCase() ===
              config.characterClass.toLowerCase()) &&
          (!rarity || record.tier === rarity),
      );
      const pools = slots.map((slot, i) => {
        const locked = document.getElementById(
          "optimizer-lock-" + slot,
        ).checked;
        if (locked) {
          const current = equip_inputs[i].get_value();
          if (!current || current.statMap.has("NONE"))
            throw new Error(
              "The locked " + title(slot) + " slot is empty or invalid.",
            );
          // Reuse native powder and custom/crafted handling for a pinned piece.
          const prepared = item_final_nodes[i].get_value();
          return [
            {
              key:
                current.statMap.get("custom") || current.statMap.get("crafted")
                  ? "@" + field(slot).value
                  : current.statMap.get("name"),
              pinned: true,
              map: prepared.statMap,
            },
          ];
        }
        const records = catalog.filter((record) =>
          i === 8
            ? record.type === config.weaponType
            : record.type === (slot.startsWith("ring") ? "ring" : slot),
        );
        return records.map((record) => ({
          key: record.name,
          map: OptimizerModel.prepare(record, mode, {}, powderFor(slot))
            .statMap,
        }));
      });
      if (pools.some((pool) => pool.length === 0))
        throw new Error(
          "At least one slot has no eligible candidates. Review class, gear level, tier and the imported pool.",
        );
      const tomeItems = item_final_nodes
        .slice(9)
        .map((node) => node.get_value());
      if (tomeItems.some((item) => !item))
        throw new Error("A selected tome is invalid.");
      if (
        tomeItems.some(
          (item) =>
            !item.statMap.has("NONE") &&
            (item.statMap.get("lvl") > config.level ||
              (item.statMap.get("type") === "guildTome" && config.level < 105)),
        )
      )
        throw new Error("The selected tomes require a higher character level.");
      config.ringSymmetric =
        !document.getElementById("optimizer-lock-ring1").checked &&
        !document.getElementById("optimizer-lock-ring2").checked;
      worker = new Worker(
        new URL(
          "worker.js",
          document.querySelector('script[src$="/optimizer/ui.js"]').src,
        ),
      );
      runButton.disabled = true;
      cancelButton.hidden = false;
      persist();
      notice(
        "Searching " +
          pools.map((pool) => pool.length).join(" × ") +
          " candidates. Every returned build must pass skill-point checks.",
      );
      const request = {
        pools,
        tomes: tomeItems.map((item) => item.statMap),
        sets: [...sets],
        config,
      };
      worker.onmessage = ({ data }) => {
        if (data.progress) {
          notice(
            count(data.progress.examined) +
              " / " +
              count(data.progress.total) +
              " combinations considered · " +
              format(data.progress.elapsed) +
              "s · best results so far",
          );
          if (data.progress.builds) {
            results = data.progress.builds;
            renderResults(config);
          }
        }
        if (data.error) {
          cancel();
          notice(data.error, true);
        }
        if (data.result) {
          cancel();
          results = data.result.builds;
          renderResults(config);
          notice(
            results.length +
              " ranked builds · " +
              count(data.result.examined) +
              " combinations considered.",
          );
        }
      };
      worker.onerror = (event) => {
        cancel();
        notice(event.message || "The search worker failed.", true);
      };
      worker.postMessage(request);
    } catch (error) {
      notice(error.message || String(error), true);
    }
  }
  function renderResults(config) {
    if (!results.length) {
      resultBox.append(
        element(
          "p",
          {},
          "No functioning build met these targets. Review the filters, targets and locked pieces.",
        ),
      );
      return;
    }
    for (const [index, result] of results.entries()) {
      const card = element("article", { class: "optimizer-result" });
      const row = element("div", { class: "optimizer-result-title" });
      row.append(
        element(
          "strong",
          {},
          "#" +
            (index + 1) +
            " · " +
            OptimizerModel.label(config.objective) +
            " " +
            format(result.score),
        ),
      );
      const use = element(
        "button",
        { type: "button", class: "optimizer-button optimizer-primary" },
        "Use this build",
      );
      use.onclick = () => applyResult(result);
      row.append(use);
      card.append(row);
      card.append(
        element("p", {}, result.pieces.map((piece) => piece.name).join(" · ")),
      );
      card.append(
        element(
          "small",
          {},
          "Assigned " +
            result.stats.assigned +
            " / " +
            levelToSkillPoints(config.level) +
            " · HP " +
            format(result.stats.health) +
            " · HPR " +
            format(result.stats.regen) +
            " · Mana regen " +
            format(result.stats.manaRegen) +
            "/5s",
        ),
      );
      const allocation = element(
        "p",
        { class: "optimizer-allocation" },
        skill.map((name, i) => name + " " + result.assigned[i]).join(" · "),
      );
      card.append(allocation);
      resultBox.append(card);
    }
  }
  function applyResult(result) {
    // Data and selected tomes may change while results are visible.
    if (worker) {
      cancel();
      notice(
        "Applied the best functioning build found so far. The exhaustive search was stopped.",
      );
    }
    for (const [i, piece] of result.pieces.entries()) {
      const slot = slots[i],
        record = piece.key.startsWith("@")
          ? null
          : [...itemMap.values()].find((record) => record.name === piece.key);
      if (record) {
        field(slot).value = record.displayName;
        const old = overrides.get(slot);
        if (!piece.pinned || old?.name !== record.displayName)
          overrides.delete(slot);
      } else if (field(slot).value !== piece.name) {
        notice("A pinned custom item changed. Run the search again.", true);
        return;
      }
    }
    for (const node of equip_inputs.slice(0, 9)) node.mark_dirty();
    for (const node of equip_inputs.slice(0, 9)) node.update();
    // Use the exact minimum allocation used to evaluate the result.
    for (const node of skp_inputs) node.mark_dirty();
    for (let i = 0; i < 5; i++)
      document.getElementById(skp_order[i] + "-skp").value = result.totals[i];
    for (const node of skp_inputs) node.update();
    const actual = OptimizerModel.measurements(build_node.get_value());
    if (Math.abs(actual.assigned - result.stats.assigned) > 1e-8)
      notice("The tome or item selection changed. Run the search again.", true);
    else
      notice(
        "Build applied to WynnBuilder. Its full ability, powder, aspect and buff calculations are shown below.",
      );
    document
      .getElementById("weapon-choice")
      .scrollIntoView({ behavior: "smooth", block: "center" });
  }
  function importPool(input) {
    const rows = Array.isArray(input) ? input : (input.items ?? input.results);
    if (!Array.isArray(rows))
      throw new Error("JSON must be an item array or contain items: [...].");
    const names = new Set(),
      missing = [];
    const byName = new Map(
      [...itemMap.values()].map((record) => [record.name, record]),
    );
    for (const row of rows) {
      if (row?.remapID !== undefined) continue;
      if (
        row?.type &&
        ["ingredient", "material", "tool", "tome", "charm"].includes(row.type)
      )
        continue;
      const key =
        typeof row === "string"
          ? row
          : (row.internalName ?? row.name ?? row.displayName);
      const record =
        byName.get(key) ||
        itemMap.get(key) ||
        [...itemMap.values()].find((item) => item.id === row.id);
      if (!record || none_items.includes(record)) {
        missing.push(String(key));
        continue;
      }
      names.add(record.name);
    }
    if (missing.length)
      throw new Error(
        "These items are missing in the loaded WynnBuilder version: " +
          missing.slice(0, 8).join(", "),
      );
    if (!names.size) throw new Error("The file contains no equippable items.");
    currentPool = names;
    cancel();
    resultBox.replaceChildren();
    notice(
      names.size +
        " native templates in the search pool. Locked pieces remain eligible.",
    );
  }
  function mount() {
    if (!equip_inputs.length) return;
    panel = document.getElementById("build-optimizer");
    panel.innerHTML = `<div class="optimizer-heading"><div><h2>Build optimizer</h2><p>Search complete loadouts with valid skill points using WynnBuilder’s item data.</p></div><span id="optimizer-count"></span></div>
        <div class="optimizer-controls">
          <label>Roll scenario<select id="optimizer-mode" class="optimizer-input"><option value="optimistic">Optimistic · best rolls</option><option value="realistic">Realistic · midpoint</option><option value="pessimistic">Pessimistic · worst rolls</option></select></label>
          <label>Class<select id="optimizer-class" class="optimizer-input"><option value="current">Use current weapon</option><option value="wand">Mage</option><option value="spear">Warrior</option><option value="bow">Archer</option><option value="dagger">Assassin</option><option value="relik">Shaman</option></select></label>
          <label>Minimum gear level<input type="number" min="1" max="121" value="1" id="optimizer-min-level" class="optimizer-input"></label>
          <label>Tier<select id="optimizer-rarity" class="optimizer-input"><option value="">All tiers</option></select></label>
          <label>Rank by<span id="optimizer-objective-wrap"></span></label>
          <label>Order<select id="optimizer-direction" class="optimizer-input"><option value="max">Highest first</option><option value="min">Lowest first</option></select></label>
          <label>Keep<select id="optimizer-limit" class="optimizer-input"><option>5</option><option selected>10</option><option>25</option></select></label>
        </div>
        <div class="optimizer-target-heading"><h3>Stat targets</h3><button type="button" class="optimizer-button" id="optimizer-add-rule">Add target</button></div>
        <div id="optimizer-rules"></div>
        <div class="optimizer-locks" id="optimizer-locks"></div>
        <label class="optimizer-check"><input type="checkbox" id="optimizer-duplicates" checked>Allow two copies of the same ring</label>
        <p class="optimizer-scope">Only valid complete loadouts are returned. Guild tome bonuses come from the selector below. Search scores include selected tomes, the minimum valid allocation, item rolls, set bonuses and equipped powders. Ability trees, aspects, raid buffs and powder specials are evaluated by the normal builder after applying a result.</p>
        <p id="optimizer-tome"></p>
        <div class="optimizer-actions"><button type="button" class="optimizer-button optimizer-primary" id="optimizer-run">Find functioning builds</button><button type="button" class="optimizer-button" id="optimizer-cancel" hidden>Cancel</button><label class="optimizer-button">Import candidate JSON<input type="file" accept=".json,application/json" id="optimizer-import" hidden></label><button type="button" class="optimizer-button" id="optimizer-all">Use full database</button></div>
        <p id="optimizer-message" role="status"></p><div id="optimizer-results"></div>`;
    rulesBox = document.getElementById("optimizer-rules");
    resultBox = document.getElementById("optimizer-results");
    message = document.getElementById("optimizer-message");
    runButton = document.getElementById("optimizer-run");
    cancelButton = document.getElementById("optimizer-cancel");
    const objective = statSelect(saved.objective || "regen");
    objective.id = "optimizer-objective";
    document.getElementById("optimizer-objective-wrap").append(objective);
    for (const tier of tiers.filter((t) => t !== "Crafted"))
      document
        .getElementById("optimizer-rarity")
        .append(element("option", { value: tier }, tier));
    for (const slot of slots) {
      const row = element("div", { class: "optimizer-pin" });
      const label = element("label");
      const pin = element("input", {
        type: "checkbox",
        id: "optimizer-lock-" + slot,
      });
      pin.checked = saved.locks?.includes(slot) || false;
      label.append(pin, document.createTextNode(" Lock " + title(slot)));
      const edit = element(
        "button",
        {
          type: "button",
          class: "optimizer-button",
          "aria-label": "Edit " + title(slot) + " actual rolls",
        },
        "Actual rolls",
      );
      edit.onclick = () => rollEditor(slot);
      row.append(label, edit);
      document.getElementById("optimizer-locks").append(row);
    }
    for (const rule of saved.rules || [
      { stat: "regen", min: 100, max: null },
      { stat: "mr", min: 8, max: null },
    ])
      addRule(rule);
    document.getElementById("optimizer-add-rule").onclick = () => {
      addRule();
      persist();
    };
    const modeInput = document.getElementById("optimizer-mode");
    modeInput.value = mode;
    modeInput.onchange = () => {
      mode = modeInput.value;
      refreshBuild();
    };
    document.getElementById("optimizer-direction").value =
      saved.direction || "max";
    document.getElementById("optimizer-min-level").value = saved.minLevel || 1;
    document.getElementById("optimizer-rarity").value = saved.rarity || "";
    if (item_final_nodes[8].get_value()?.statMap.has("NONE"))
      document.getElementById("optimizer-class").value = "wand";
    runButton.onclick = search;
    cancelButton.onclick = () => {
      cancel();
      notice("Search cancelled.");
    };
    document.getElementById("optimizer-all").onclick = () => {
      currentPool = null;
      cancel();
      resultBox.replaceChildren();
      notice("Using all native item templates.");
    };
    document.getElementById("optimizer-import").onchange = async (event) => {
      try {
        importPool(JSON.parse(await event.target.files[0].text()));
      } catch (error) {
        notice(error.message, true);
      } finally {
        event.target.value = "";
      }
    };
    panel.addEventListener("change", (event) => {
      if (event.target !== modeInput) {
        cancel();
        results = [];
        resultBox.replaceChildren();
        persist();
      }
    });
    rollDialog = element("dialog", {
      class: "optimizer-dialog",
      "aria-label": "Owned item identifications",
    });
    document.body.append(rollDialog);
    document.getElementById("optimizer-count").textContent =
      [...itemMap.values()]
        .filter((item) => !none_items.includes(item))
        .length.toLocaleString() + " native items";
    const watchInputs = [...equipment_fields, ...tome_fields, "level"];
    for (const name of powder_inputs)
      document.getElementById(name)?.addEventListener("input", () => {
        cancel();
        results = [];
        resultBox.replaceChildren();
      });
    for (const name of watchInputs)
      for (const event of ["input", "change"])
        field(name)?.addEventListener(event, () => {
          cancel();
          results = [];
          resultBox.replaceChildren();
        });
    function tomeLabel() {
      const tome = item_final_nodes[15]?.get_value(); // 9 gear + 6 weapon/armour tomes.
      document.getElementById("optimizer-tome").textContent =
        "Guild tome from the selector below · " +
        (tome?.statMap.get("displayName") || "No Guild Tome");
    }
    field("guildTome1")?.addEventListener("change", () =>
      setTimeout(tomeLabel, 20),
    );
    field("guildTome1")?.addEventListener("input", () =>
      setTimeout(tomeLabel, 20),
    );
    tomeLabel();
    if (mode !== "optimistic" || overrides.size) refreshBuild();
  }
  // A link's scenario and owned values take precedence over local preferences.
  try {
    const text = new URLSearchParams(location.search).get("optimizer");
    if (text) {
      const shared = JSON.parse(text);
      if (shared.v !== 1)
        throw new Error("Unsupported optimizer link version.");
      if (["optimistic", "realistic", "pessimistic"].includes(shared.mode))
        mode = shared.mode;
      for (const [slot, entry] of Object.entries(shared.owned || {})) {
        if (
          slots.includes(slot) &&
          typeof entry.name === "string" &&
          entry.actual &&
          Object.values(entry.actual).every(Number.isFinite)
        )
          overrides.set(slot, entry);
      }
    } else if (
      !location.hash &&
      ["optimistic", "realistic", "pessimistic"].includes(saved.mode)
    )
      mode = saved.mode;
  } catch (error) {
    console.warn("Could not load optimizer roll settings", error);
  }
  return {
    mount,
    resolveItem,
    queryString,
    importPool,
    search,
    cancel,
    reset() {
      overrides.clear();
      mode = "optimistic";
      const params = new URLSearchParams(location.search);
      params.delete("optimizer");
      history.replaceState(
        null,
        "",
        location.pathname + (params.size ? "?" + params : "") + location.hash,
      );
      if (panel) {
        document.getElementById("optimizer-mode").value = mode;
        for (const slot of slots)
          document.getElementById("optimizer-lock-" + slot).checked = false;
        cancel();
        resultBox.replaceChildren();
        persist();
      }
    },
  };
})();
