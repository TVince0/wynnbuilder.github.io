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
      cudaConfigured: true,
      cudaBlocks: document.getElementById("optimizer-cuda-blocks").value,
      strategy: document.getElementById("optimizer-strategy").value,
      cudaShortlist: document.getElementById("optimizer-cuda-shortlist").value,
      workers: document.getElementById("optimizer-workers").value,
      rules: readRules(),
      secondary: readSecondary(),
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
    return OptimizerFinal.metrics();
  }

  function readSecondary() {
    return [...(document.getElementById("optimizer-secondary")?.children || [])].map(row => ({
      stat: row.querySelector("select").value,
      direction: row.querySelector("[data-direction]").value,
    }));
  }
  function addSecondary(rank = {}) {
    const row = element("div", {class: "optimizer-secondary-row"});
    const metric = statSelect(rank.stat || "health");
    metric.setAttribute("aria-label", "Secondary ranking stat");
    const direction = element("select", {class: "optimizer-input", "data-direction": "", "aria-label": "Secondary ranking order"});
    direction.append(element("option", {value: "max"}, "Highest first"), element("option", {value: "min"}, "Lowest first"));
    direction.value = rank.direction || "max";
    const remove = element("button", {type: "button", class: "optimizer-button", "aria-label": "Remove secondary ranking"}, "×");
    remove.onclick = () => {row.remove(); cancel(); resultBox.replaceChildren(); persist();};
    row.append(metric, direction, remove);
    document.getElementById("optimizer-secondary").append(row);
  }
  function statSelect(value) {
    const select = element("select", { class: "optimizer-input" });
    const groups = new Map();
    for (const [key, label, group] of metrics()) {
      if (!groups.has(group)) {
        const options = element("optgroup", { label: group });
        groups.set(group, options);
        select.append(options);
      }
      groups.get(group).append(element("option", { value: key }, label));
    }
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
        placeholder: "Any",
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
      resultBox.replaceChildren();
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
    syncEquipment();
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
    const keys = map.get("fixID") ? [] : rolledIDs.filter(key =>
      map.get("minRolls").get(key) !== map.get("maxRolls").get(key));
    if (!keys.length) fields.append(element("p", {}, "This item has no variable identifications."));
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
        throw new Error("Choose a weapon in the equipment editor or select a class in Search settings.");
    }
    const strategy = document.getElementById("optimizer-strategy").value;
    const workers = Number(document.getElementById("optimizer-workers").value);
    if (!Number.isInteger(workers) || workers < 1 || workers > 8)
      throw new Error("Choose between 1 and 8 workers.");
    const cudaBlocks = Number(document.getElementById("optimizer-cuda-blocks").value);
    return {
      strategy, workers, cudaBlocks,
      cudaShortlist: Number(document.getElementById("optimizer-cuda-shortlist").value),
      rules,
      secondary: readSecondary(),
      finalContext: OptimizerFinal.snapshot(),
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
  function showProgress(data) {
    if (!data.total || data.message) return;
    const container = document.getElementById("optimizer-progress");
    const text = document.getElementById("optimizer-progress-text");
    const bar = document.getElementById("optimizer-coverage");
    const timings = document.getElementById("optimizer-timings");
    container.hidden = false;
    const total = BigInt(data.total).toLocaleString();
    if (data.cuda) {
      const ratio = Math.min(1, (data.estimatedUnique || 0) / Math.max(1, Number(data.total)));
      const percent = ratio > 0 && ratio < .00000001 ? "<0.000001" : (ratio*100).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
      bar.hidden = false; bar.value = ratio;
      text.textContent = "Estimated GPU coverage " + count(data.estimatedUnique || 0) + " / " + total + " (" + percent + "%) · " + count(data.tested) + " proposals · " + count(data.evaluated) + " native evaluations";
      timings.textContent = "GPU batch " + format(data.gpuMs || 0) + " ms · Native validation cycle " + format(data.nativeMs || 0) + " ms · " + count(Math.round(data.tested / Math.max(.001, data.elapsed))) + " GPU proposals/s · " + count(Math.round(data.evaluated / Math.max(.001, data.elapsed))) + " native evaluations/s";
    } else {
      bar.hidden = !!data.fast;
      if (!data.fast) bar.value = Math.min(1, Number(data.examined) / Math.max(1, Number(data.total)));
      text.textContent = data.fast ? count(data.examined) + " candidate attempts · " + total + " possible combinations · sampling can revisit builds" : count(data.examined) + " / " + total + " combinations considered";
      timings.textContent = "Elapsed " + format(data.elapsed) + "s";
    }
  }
  function search() {
    cancel();
    resultBox.replaceChildren();
    results = [];
    document.getElementById("optimizer-progress").hidden = true;
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
        !document.getElementById("optimizer-lock-ring2").checked &&
        JSON.stringify(powderFor("ring1")) === JSON.stringify(powderFor("ring2"));
      config.initial = slots.map((slot, index) => {
        const name = equip_inputs[index].get_value()?.statMap.get("name");
        return pools[index].find(entry => entry.key === name)?.key || pools[index][0].key;
      });
      worker = config.strategy === "cuda" ? new OptimizerCudaClient() : new OptimizerPool(
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
          showProgress(data.progress);
          notice(data.progress.cuda
            ? data.progress.message || data.progress.device + " · " + count(data.progress.tested) + " GPU candidates · " + count(data.progress.evaluated) + " native evaluations · " + format(data.progress.elapsed) + "s · best found so far"
            : data.progress.fast
              ? count(data.progress.examined) + " candidates tried · " + count(data.progress.evaluated) + " fully evaluated · " + format(data.progress.elapsed) + "s · " + data.progress.workers + " workers · best found so far"
              : count(data.progress.examined) + " / " + count(data.progress.total) + " combinations considered · " + format(data.progress.elapsed) + "s · exhaustive search");
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
          showProgress(data.result);
          cancel();
          results = data.result.builds;
          renderResults(config);
          notice(data.result.cuda
            ? results.length + " builds found · " + data.result.device + " · " + count(data.result.tested) + " GPU candidates · " + count(data.result.evaluated) + " native evaluations · " + format(data.result.elapsed) + "s · global optimum unproven"
            : data.result.fast
            ? results.length + " builds found in " + format(data.result.elapsed) + "s · search finished · global optimum unproven"
            : results.length + " ranked builds · " + count(data.result.examined) + " combinations considered · exhaustive search complete");
        }
      };
      worker.onerror = (event) => {
        cancel();
        notice(event.message || "The search worker failed.", true);
      };
      worker.postMessage(request);
    } catch (error) {
      cancel();
      notice(error.message || String(error), true);
    }
  }
  function renderResults(config) {
    resultBox.replaceChildren();
    if (!results.length && worker) return;
    resultBox.append(element("h2", {}, "Ranked builds"));
    if (!results.length) {
      resultBox.append(
        element(
          "p",
          {},
          "No functioning build meeting these targets was found. Try more time, different targets or a smaller item pool.",
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
      const targets = element("p", {class: "optimizer-allocation"});
      targets.textContent = [...(config.secondary || []), ...config.rules].map(rule => OptimizerModel.label(rule.stat) + " " + format(result.stats[rule.stat])).join(" · ");
      card.append(targets);
      resultBox.append(card);
    }
  }
  function applyResult(result) {
    // Data and selected tomes may change while results are visible.
    if (worker) {
      cancel();
      notice(
        "Applied the best functioning build found so far. The search was stopped.",
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
    syncEquipment();
    goToField("weapon");
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
    document.getElementById("optimizer-pool-name").textContent = format(names.size) + " imported items";
    document.getElementById("optimizer-all").disabled = false;
    cancel();
    resultBox.replaceChildren();
    notice(
      names.size +
        " native templates in the search pool. Locked pieces remain eligible.",
    );
  }
  function goToField(slot) {
    const tome = slot === "guildTome1";
    if (window.innerWidth < 992) {
      document.getElementById(tome ? "adjust-id-btn" : "equipment-inputs-btn").click();
    }
    if (tome && document.getElementById("tomes-dropdown").style.display === "none") {
      document.getElementById("toggle-tomes").click();
    }
    field(slot).focus({ preventScroll: true });
    field(slot).scrollIntoView({ block: "center" });
  }
  function syncEquipment() {
    for (const slot of slots) {
      const name = field(slot).value.trim();
      const pin = document.getElementById("optimizer-lock-" + slot);
      const edit = document.getElementById("optimizer-edit-" + slot);
      const label = document.getElementById("optimizer-piece-" + slot);
      label.textContent = title(slot);
      if (name) label.append(element("small", {}, name));
      pin.disabled = !name && !pin.checked;
      edit.textContent = name ? "Edit rolls" : "Choose";
      edit.setAttribute("aria-label", name ? "Edit " + title(slot) + " actual rolls" : "Choose " + title(slot));
    }
  }
  function mount() {
    if (!equip_inputs.length) return;
    panel = document.getElementById("build-optimizer");
    panel.innerHTML = `
      <header class="optimizer-hero">
        <div class="optimizer-hero-copy">
          <span id="optimizer-count"></span>
          <h1 tabindex="-1">Build optimizer</h1>
          <p>Find gear that meets your stat targets and skill-point budget.</p>
        </div>
      </header>
      <div class="optimizer-workspace">
        <div class="optimizer-config">
          <section class="optimizer-card">
            <h2>Search settings</h2>
            <div class="optimizer-controls">
              <label>Class<select id="optimizer-class" class="optimizer-input"><option value="current">Current weapon</option><option value="wand">Mage</option><option value="spear">Warrior</option><option value="bow">Archer</option><option value="dagger">Assassin</option><option value="relik">Shaman</option></select></label>
              <label>Roll scenario<select id="optimizer-mode" class="optimizer-input"><option value="optimistic">Optimistic · best</option><option value="realistic">Realistic · midpoint</option><option value="pessimistic">Pessimistic · worst</option></select></label>
              <label>Minimum gear level<input type="number" min="1" max="121" value="1" id="optimizer-min-level" class="optimizer-input"></label>
              <label>Item tier<select id="optimizer-rarity" class="optimizer-input"><option value="">All tiers</option></select></label>
            </div>
            <details class="optimizer-pool">
              <summary>Item pool <span id="optimizer-pool-name">Full database</span></summary>
              <div class="optimizer-actions">
                <button type="button" id="optimizer-import-button" class="optimizer-button">Import candidate JSON</button>
                <input type="file" accept=".json,application/json" id="optimizer-import" hidden>
                <button type="button" class="optimizer-button" id="optimizer-all" disabled>Use full database</button>
              </div>
            </details>
            <div class="optimizer-controls optimizer-search-options">
              <label>Search mode<select id="optimizer-strategy" class="optimizer-input"><option value="cuda">CUDA backend</option><option value="fast">CPU optimization</option><option value="exhaustive">CPU exhaustive search</option></select></label>
              <label>CPU workers<select id="optimizer-workers" class="optimizer-input"></select></label>
              <label id="optimizer-cuda-batch-label">CUDA batch size<select id="optimizer-cuda-blocks" class="optimizer-input"><option value="16">4,096</option><option value="64">16,384</option><option value="256" selected>65,536</option><option value="1024">262,144</option><option value="4096">1,048,576</option></select></label>
            </div>
            <label id="optimizer-cuda-shortlist-label">Native shortlist per cycle<select id="optimizer-cuda-shortlist" class="optimizer-input"><option>64</option><option>128</option><option selected>256</option><option>512</option><option>1024</option></select></label>
            <button type="button" class="optimizer-button" id="optimizer-cuda-check">Check CUDA backend</button>
            <p id="optimizer-cuda-status" class="optimizer-hint" role="status"></p>
            <p class="optimizer-hint" id="optimizer-cuda-hint">Larger CUDA batches screen more candidates per launch. Native shortlist size controls CPU work per validation cycle. GPU coverage estimates distinct skill-screened combinations. Native evaluations use the full final-stat calculator.</p>
            <p class="optimizer-hint" id="optimizer-search-help">Search runs until you stop it. Every returned result is validated. Global optimality is unproven.</p>
          </section>
          <section class="optimizer-card">
            <div class="optimizer-heading"><h2>Stat targets</h2><button type="button" class="optimizer-button" id="optimizer-add-rule">+ Add target</button></div>
            <p class="optimizer-hint">Combine final outputs with individual raw or percentage stats. For example, target HP Regen (Final), HP Regen (Raw), and HP Regen % independently.</p>
            <div class="optimizer-rule optimizer-rule-labels" aria-hidden="true"><span>Stat</span><span>Minimum</span><span>Maximum</span></div>
            <div id="optimizer-rules"></div>
            <div class="optimizer-ranking">
              <label>Rank by<span id="optimizer-objective-wrap"></span></label>
              <label>Order<select id="optimizer-direction" class="optimizer-input"><option value="max">Highest first</option><option value="min">Lowest first</option></select></label>
              <label>Results<select id="optimizer-limit" class="optimizer-input"><option>5</option><option selected>10</option><option>25</option></select></label>
            </div>
            <div id="optimizer-secondary"></div>
            <button type="button" class="optimizer-button" id="optimizer-add-ranking">+ Secondary ranking</button>
            <p class="optimizer-hint">Rankings apply in order. Later rankings break ties.</p>
            <details class="optimizer-notes"><summary>How generic spell damage is measured</summary><p>Generic spell hit is the average damage of a 100% spell hit using the weapon’s existing elements. It combines shared raw and percentage damage, elemental bonuses, skill points, critical chance and general buffs. Individual spell conversions and bonuses are excluded. It is a comparison benchmark. Each actual spell applies its own scaling.</p></details>
            <div class="optimizer-actions"><button type="button" class="optimizer-button optimizer-primary" id="optimizer-run">Find builds <span aria-hidden="true">→</span></button><button type="button" class="optimizer-button" id="optimizer-cancel" hidden>Cancel search</button></div>
            <p id="optimizer-message" role="status"></p>
            <div id="optimizer-progress" hidden><progress id="optimizer-coverage" max="1" value="0" aria-label="Search coverage"></progress><p id="optimizer-progress-text"></p><p id="optimizer-timings" class="optimizer-hint"></p></div>
          </section>
          <section class="optimizer-result-section" aria-label="Ranked builds"><div id="optimizer-results"></div></section>
        </div>
        <section class="optimizer-card optimizer-loadout">
          <div class="optimizer-heading"><h2>Equipment</h2><button type="button" class="optimizer-button" id="optimizer-edit-gear">Open editor ↓</button></div>
          <p class="optimizer-hint">Lock equipped pieces to keep them in every result.</p>
          <div class="optimizer-locks" id="optimizer-locks"></div>
          <label class="optimizer-check"><input type="checkbox" id="optimizer-duplicates" checked>Allow duplicate rings</label>

        </section>
      </div>
      <details class="optimizer-notes"><summary>What counts toward a build?</summary><p>Targets and ranking use WynnBuilder’s final stats with your selected abilities, aspects, buffs, powders and tomes. Search uses the minimum valid skill allocation. Attack speed runs from 0 (Super Slow) to 6 (Super Fast). Narrow the item pool or lock equipment to reduce search time.</p></details>
      <div class="optimizer-editor-heading"><h2>Equipment editor</h2><button type="button" class="optimizer-button" id="optimizer-back">Back to optimizer ↑</button></div>`;
    const strategyInput = document.getElementById("optimizer-strategy");
    const workersInput = document.getElementById("optimizer-workers");
    strategyInput.value = saved.cudaConfigured && ["cuda","fast","exhaustive"].includes(saved.strategy) ? saved.strategy : "cuda";
    document.getElementById("optimizer-cuda-shortlist").value = ["64","128","256","512","1024"].includes(saved.cudaShortlist) ? saved.cudaShortlist : "256";
    const cudaBlocksInput = document.getElementById("optimizer-cuda-blocks");
    cudaBlocksInput.value = ["16","64","256","1024","4096"].includes(saved.cudaBlocks) ? saved.cudaBlocks : "256";
    document.getElementById("optimizer-cuda-check").onclick = async () => {
      const status = document.getElementById("optimizer-cuda-status");
      status.textContent = "Checking NVIDIA driver and CUDA compiler…";
      try {
        const response = await fetch("/api/cuda/status");
        if (!response.ok) throw Error("Local CUDA service is unavailable. Start the site with pnpm dev.");
        const state = await response.json();
        status.textContent = state.available ? "Ready · " + state.device : state.error;
        status.classList.toggle("optimizer-error", !state.available);
      } catch(error) {status.textContent = error.message;status.classList.add("optimizer-error");}
    };
    for (let i = 1; i <= 8; i++) workersInput.append(element("option", {value: i}, String(i)));
    workersInput.value = String(Math.max(1, Math.min(8, Number(saved.workers) || Math.max(1, (navigator.hardwareConcurrency || 4) - 1))));
    const searchModeHelp = () => {
      const exhaustive = strategyInput.value === "exhaustive";
      workersInput.disabled = exhaustive;
      const cuda = strategyInput.value === "cuda";
      document.getElementById("optimizer-cuda-batch-label").hidden = !cuda;
      document.getElementById("optimizer-cuda-hint").hidden = !cuda;
      document.getElementById("optimizer-cuda-shortlist-label").hidden = !cuda;
      document.getElementById("optimizer-cuda-check").hidden = !cuda;
      document.getElementById("optimizer-cuda-status").hidden = !cuda;
      document.getElementById("optimizer-search-help").textContent = cuda
        ? "CUDA generates and skill-filters batches. Native CPU validators score the shortlist against your final-stat targets and rankings. Search is approximate and runs until you stop it. Requires the local NVIDIA backend."
        : exhaustive
        ? "Exhaustive search proves the best ranking when it finishes. Large item pools can take a very long time. Uses one worker."
        : "Search runs until you stop it. Every returned result is validated. Global optimality is unproven. Pools of 256 combinations or fewer are completed exhaustively.";
    };
    strategyInput.addEventListener("change", searchModeHelp);
    searchModeHelp();
    rulesBox = document.getElementById("optimizer-rules");
    resultBox = document.getElementById("optimizer-results");
    message = document.getElementById("optimizer-message");
    runButton = document.getElementById("optimizer-run");
    cancelButton = document.getElementById("optimizer-cancel");
    for (const rank of saved.secondary || []) addSecondary(rank);
    document.getElementById("optimizer-add-ranking").onclick = () => {
      addSecondary();
      cancel();
      resultBox.replaceChildren();
      persist();
    };
    const objective = statSelect(saved.objective || "regen");
    objective.id = "optimizer-objective";
    document.getElementById("optimizer-objective-wrap").append(objective);
    for (const tier of tiers.filter((t) => t !== "Crafted"))
      document
        .getElementById("optimizer-rarity")
        .append(element("option", { value: tier }, tier));
    document.getElementById("optimizer-edit-gear").onclick = () => goToField("helmet");

    const editorHeading = panel.querySelector(".optimizer-editor-heading");
    panel.after(editorHeading);
    document.getElementById("optimizer-back").onclick = () => {
      panel.querySelector("h1").focus({ preventScroll: true });
      panel.scrollIntoView({ block: "start" });
    };
    document.getElementById("optimizer-import-button").onclick = () => document.getElementById("optimizer-import").click();
    for (const slot of slots) {
      const row = element("div", { class: "optimizer-pin" });
      const label = element("label");
      const pin = element("input", {
        type: "checkbox", id: "optimizer-lock-" + slot, "aria-label": "Lock " + title(slot),
      });
      pin.checked = saved.locks?.includes(slot) || false;
      const icon = element("span", { class: "optimizer-gear-icon", "aria-hidden": "true" });
      icon.style.backgroundPosition = document.getElementById(slot + "-img").style.backgroundPosition || "0% 0%";
      const name = element("span", { id: "optimizer-piece-" + slot });
      label.append(pin, icon, name);
      const edit = element("button", { type: "button", class: "optimizer-button", id: "optimizer-edit-" + slot });
      edit.onclick = () => field(slot).value ? rollEditor(slot) : goToField(slot);
      row.append(label, edit);
      document.getElementById("optimizer-locks").append(row);
    }
    syncEquipment();
    for (const rule of saved.rules || [
      { stat: "regen", min: 100, max: null },
      { stat: "mr", min: 8, max: null },
    ])
      addRule(rule);
    document.getElementById("optimizer-add-rule").onclick = () => {
      addRule();
      rulesBox.lastElementChild.querySelector("select").focus();
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
      notice("Search stopped. Results found so far are preserved.");
    };
    document.getElementById("optimizer-all").onclick = () => {
      currentPool = null;
      document.getElementById("optimizer-pool-name").textContent = "Full database";
      document.getElementById("optimizer-all").disabled = true;
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
      document.getElementById("optimizer-progress").hidden = true;
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
        .length.toLocaleString() + " items in catalog";
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
          if (slots.includes(name)) syncEquipment();
          cancel();
          results = [];
          resultBox.replaceChildren();
        });
    function updateMetrics() {
      for (const select of panel.querySelectorAll("#optimizer-objective, #optimizer-rules select, #optimizer-secondary select:not([data-direction])")) {
        const old = select.value;
        const next = statSelect(old);
        if (![...next.options].some(option => option.value === old)) {
          next.append(element("option", {value: old}, OptimizerModel.label(old) + " (inactive)"));
          next.value = old;
        }
        select.replaceChildren(...next.children);
        select.value = old;
      }
    }
    for (const type of ["input", "change", "click"]) document.addEventListener(type, event => {
      if (panel.contains(event.target) || rollDialog.contains(event.target)) return;
      document.getElementById("optimizer-progress").hidden = true;
      cancel();
      results = [];
      resultBox.replaceChildren();
      setTimeout(updateMetrics, 600);
    });
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
        setTimeout(syncEquipment, 0);
        persist();
      }
    },
  };
})();
