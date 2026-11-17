function setSelect(id, values) {
  const value =
    values.length === 0 ? "" : values.length === 1 ? values[0] : "custom";
  $(id).value = [...$(id).options].some((x) => x.value === value)
    ? value
    : "custom";
}

function fillSettings() {
  if (!S.status) return;
  const c = S.status.config;
  S.globalGroups = [...c.filters.groups];
  text(
    "global-group-label",
    S.globalGroups.length
      ? S.globalGroups.map(groupLabel).join("、")
      : "不限压制组",
  );
  $("setting-priority").value = (c.filters.priorityGroups || []).join(", ");
  $("setting-fallback").value = c.filters.fallbackHours ?? 6;
  setSelect("setting-resolution", c.filters.resolutions);
  setSelect("setting-subtitle", c.filters.subtitles);
  $("setting-chs").checked = c.filters.languages.includes("CHS");
  $("setting-dedupe").checked = c.dedupeEpisodes;
  $("setting-include").value = c.filters.include.join(", ");
  $("setting-exclude").value = c.filters.exclude.join(", ");
  $("setting-rss").value = "";
  $("setting-rss").placeholder = c.rssConfigured
    ? "已配置私人链接，留空保持原值"
    : "粘贴「我的订阅」完整 RSS 链接";
  text(
    "rss-hint",
    c.rssConfigured
      ? "私人订阅已配置，令牌不会在界面中明文显示。"
      : "在 AniBT「我的订阅」中复制完整 RSS 链接。",
  );
  $("setting-qb-url").value = c.qb.url;
  $("setting-username").value = c.qb.username;
  $("setting-password").value = "";
  $("setting-password").placeholder = c.passwordConfigured
    ? "密码已加密保存，留空保持原值"
    : "输入 qBittorrent Web UI 密码";
  $("setting-path").value = c.qb.savePath;
  $("setting-start-date").value = c.startDate || "";
  $("setting-start-episode").value = c.startEpisode ?? "";
  $("setting-category").value = c.qb.category;
  $("setting-interval").value = [...$("setting-interval").options].some(
    (x) => x.value === String(c.intervalSeconds),
  )
    ? String(c.intervalSeconds)
    : "custom";
  $("setting-paused").checked = c.qb.paused;
  $("setting-qb-autostart").checked = c.qb.autoStart;
  $("setting-qb-executable").value = c.qb.executable;
  $("setting-notifications").checked = c.notifications.enabled;
  $("setting-open-on-download").checked = c.notifications.openOnDownload;
  $("setting-autostart").checked = S.status.background.autostart;
  $("setting-network-mode").value = S.status.preferences?.networkMode || "auto";
  $("setting-proxy-url").value =
    S.status.preferences?.proxyUrl || "http://127.0.0.1:7890";
  if (window.updateNetworkField) updateNetworkField();
  S.formRevision = S.status.revision;
  S.formDirty = false;
  S.settingsInitialized = true;
  text("settings-saved-hint", "私人配置仅保存在这台电脑");
  window.AniBTDefaults?.update();
}

async function saveSettings(test = false) {
  const c = S.status.config;
  if ($("setting-start-episode").value || c.startEpisode)
    await requireStartEpisodeScheduling();
  if ($("setting-start-date").value || c.startDate)
    await requireAnimeScheduling();
  const getList = (id, old) =>
    $(id).value === "custom" ? old : $(id).value ? [$(id).value] : [];
  const update = settingsPatch();
  const auto = $("setting-autostart").checked;
  const button = test ? $("test-connection") : $("save-settings");
  button.disabled = true;
  try {
    await api("config", { revision: S.formRevision, config: update });
    S.formDirty = false;
    await window.AniBTSession?.clear("settingsDraft");
    await api("preferences", {
      networkMode: $("setting-network-mode").value,
      proxyUrl: $("setting-proxy-url").value,
    });
    await loadStatus();
    if (auto !== S.status.background.autostart)
      await doAction(auto ? "autostart-on" : "autostart-off");
    fillSettings();
    await loadFeed();
    if (test) {
      await loadQb(true);
      toast(
        S.qb.connected ? "设置已保存，qBittorrent 连接正常" : S.qb.error,
        !S.qb.connected,
      );
    } else toast("设置已保存，下次检查自动应用。");
    text("settings-saved-hint", "已保存 · " + date(new Date()));
  } finally {
    button.disabled = false;
  }
}

function rememberGroups(groups) {
  for (const g of groups) {
    const index = S.groups.findIndex((old) =>
      [old.name, old.slug].some((a) =>
        [g.name, g.slug].some((b) => norm(a) === norm(b)),
      ),
    );
    if (index < 0) S.groups.push(g);
    else S.groups[index] = { ...S.groups[index], ...g };
  }
}

function scopedFeedGroups() {
  const anime = S.rule?.anime;
  const items =
    S.groupContext === "rule"
      ? S.feed.filter((i) =>
          anime.bgmId && i.bgmId
            ? i.bgmId === anime.bgmId
            : norm(i.animeTitle) === norm(anime.title),
        )
      : S.feed;
  const map = new Map();
  for (const i of items) {
    const key = i.groupSlug || i.groupName;
    if (!key) continue;
    if (!map.has(key))
      map.set(key, {
        name: i.groupName || key,
        slug: key,
        published: true,
        subscription: true,
        totalReleases: 0,
        hasSimplified: false,
      });
    const g = map.get(key);
    g.totalReleases++;
    g.hasSimplified ||= i.languages.includes("CHS");
  }
  return [...map.values()];
}

async function chooseGroups(context) {
  S.groupContext = context;
  S.groupDraft = [...(context === "global" ? S.globalGroups : S.ruleGroups)];
  S.groupOptions = scopedFeedGroups();
  rememberGroups(S.groupOptions);
  S.groupWarning = "";
  S.groupUpdatedAt = null;
  $("group-search").value = "";
  text(
    "group-dialog-title",
    context === "rule" ? "选择这部番的发布组" : "选择默认压制组 / 字幕组",
  );
  text(
    "group-dialog-description",
    context === "rule"
      ? `「${S.rule.anime.title}」实际发布过的组会自动更新；你已选中的组会保留。`
      : "优先展示订阅中实际发布的组，同时提供全站目录。新组不会自动加入已选偏好。",
  );
  $("groups-dialog").showModal();
  renderGroups();
  await reloadGroupOptions();
}

async function reloadGroupOptions(force = false) {
  const request = ++S.groupRequest;
  const query = new URLSearchParams();
  if (S.groupContext === "rule") {
    if (S.rule.anime.bgmId) query.set("bgmId", S.rule.anime.bgmId);
    query.set("title", S.rule.anime.title);
  }
  if (force) query.set("refresh", "1");
  const button = $("refresh-groups");
  button.disabled = true;
  button.classList.add("spin");
  try {
    const result = await api("groups?" + query);
    if (request !== S.groupRequest || !$("groups-dialog").open) return;
    S.groupOptions = result.groups;
    rememberGroups(result.groups);
    S.groupWarning = result.warning || "";
    S.groupUpdatedAt = result.updatedAt;
    renderGroups();
  } catch (e) {
    if (request !== S.groupRequest) return;
    S.groupWarning = "刷新暂不可用，已保留当前发布组和选择。";
    renderGroups();
    toast(e.message, true);
  } finally {
    if (request === S.groupRequest) {
      button.disabled = false;
      button.classList.remove("spin");
    }
  }
}

function isSelected(group) {
  return S.groupDraft.some((g) =>
    [group.name, group.slug].some((s) => norm(s) === norm(g)),
  );
}

function renderGroups() {
  const query = norm($("group-search").value);
  const available = [...S.groupOptions];
  for (const selected of S.groupDraft)
    if (
      !available.some((g) =>
        [g.name, g.slug].some((a) => norm(a) === norm(selected)),
      )
    )
      available.push({
        ...S.groups.find((g) =>
          [g.name, g.slug].some((a) => norm(a) === norm(selected)),
        ),
        name: groupLabel(selected),
        slug: selected,
        published: false,
        retained: true,
      });
  const groups = available.filter(
    (g) => !query || norm(g.name + " " + g.slug).includes(query),
  );
  text(
    "group-sync-status",
    S.groupWarning ||
      (S.groupUpdatedAt
        ? `${S.groupOptions.length} 个发布组 / 目录项 · 更新于 ${date(S.groupUpdatedAt)} · 每分钟同步`
        : "正在同步实际发布组…"),
  );
  $("selected-groups").innerHTML = S.groupDraft.length
    ? S.groupDraft
        .map(
          (g, i) =>
            `<span class="pill">${escape(groupLabel(g))}<button data-remove-group="${i}" aria-label="移除 ${escape(groupLabel(g))}">×</button></span>`,
        )
        .join("")
    : '<span class="pill gray">不限压制组</span>';
  $("group-options").innerHTML = groups
    .map(
      (g) =>
        `<label class="group-option"><input type="checkbox" data-group-slug="${escape(g.slug)}" ${isSelected(g) ? "checked" : ""}><span><strong>${escape(g.name)}</strong><small>${escape(g.slug)} · ${g.retained ? "已选，当前列表未返回" : g.published ? (S.groupContext === "rule" ? "本番已发布" : "订阅中已发布") + (g.totalReleases ? " · " + g.totalReleases + " 条资源" : "") : "全站目录"}</small></span>${g.hasSimplified ? '<span class="badge success">含简中</span>' : ""}</label>`,
    )
    .join("");
  if (
    query &&
    !available.some((g) => [g.name, g.slug].some((v) => norm(v) === query))
  ) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "group-option text-button";
    button.textContent =
      "＋ 使用自定义组名「" + $("group-search").value.trim() + "」";
    button.addEventListener("click", () => {
      S.groupDraft.push($("group-search").value.trim());
      $("group-search").value = "";
      renderGroups();
    });
    $("group-options").append(button);
  }
  if (!$("group-options").children.length)
    $("group-options").innerHTML = empty(
      "暂未发现发布组",
      "可以点击刷新，或输入完整组名添加偏好。",
      "search",
    );
}

function openRule(index) {
  const anime = animeList()[index];
  if (anime) openAnimeRule(anime);
}

function openAnimeRule(anime) {
  if (!anime) return;
  const existing = matchingRule(anime);
  S.rule = {
    anime,
    revision: S.status.revision,
    original: existing ? structuredClone(existing) : null,
  };
  text("rule-anime-title", anime.title);
  if ($("rule-watched-helper")) $("rule-watched-helper").value = "";
  $("rule-save-path").value = existing?.savePath || "";
  $("rule-inherit-priority").checked =
    !existing || !Object.hasOwn(existing, "priorityGroups");
  $("rule-priority").value = (existing?.priorityGroups || []).join(", ");
  $("rule-fallback").value =
    existing?.fallbackHours ?? S.status.config.filters.fallbackHours ?? 6;
  const root = S.status.config.qb.savePath || S.qb?.savePath,
    folder = anime.items[0]?.folderName || anime.title;
  text(
    "rule-path-hint",
    root
      ? "留空自动使用：" +
          root.replace(/[\\/]+$/, "") +
          String.fromCharCode(92) +
          folder
      : "留空自动使用 qB 默认下载目录下的「" + folder + "」文件夹。",
  );
  $("rule-inherit-start-date").checked =
    !existing || !Object.hasOwn(existing, "startDate");
  $("rule-start-date").value = existing?.startDate || "";
  updateRuleStartDate();
  $("rule-inherit-start-episode").checked =
    !existing || !Object.hasOwn(existing, "startEpisode");
  $("rule-start-episode").value = existing?.startEpisode ?? "";
  updateRuleStartEpisode();
  $("rule-enabled").checked = existing?.enabled !== false;
  const inherited = !existing || !Object.hasOwn(existing, "groups");
  $("rule-inherit-groups").checked = inherited;
  S.ruleGroups = [...(existing?.groups || [])];
  renderRuleGroupLabel();
  for (const [id, key] of [
    ["rule-resolution", "resolutions"],
    ["rule-subtitle", "subtitles"],
  ]) {
    if (!existing || !Object.hasOwn(existing, key)) $(id).value = "inherit";
    else setSelect(id, existing[key]);
  }
  $("rule-dialog").showModal();
}

function renderRuleGroupLabel() {
  const inherited = $("rule-inherit-groups").checked;
  $("select-rule-groups").disabled = inherited;
  text(
    "rule-group-label",
    inherited
      ? "沿用默认偏好"
      : S.ruleGroups.length
        ? S.ruleGroups.map(groupLabel).join("、")
        : "这部番剧不限压制组",
  );
}

function sameRule(r) {
  if (S.rule.original)
    return S.rule.original.bgmId
      ? String(r.bgmId) === String(S.rule.original.bgmId)
      : !r.bgmId && r.title === S.rule.original.title;
  return S.rule.anime.bgmId && r.bgmId
    ? String(r.bgmId) === S.rule.anime.bgmId
    : !r.bgmId && r.title === S.rule.anime.title;
}

async function saveRule(reset = false) {
  if (!S.rule) return;
  if (
    !$("rule-inherit-start-episode").checked ||
    Object.hasOwn(S.rule.original || {}, "startEpisode")
  )
    await requireStartEpisodeScheduling();
  await requireAnimeScheduling();
  const c = S.status.config;
  const rules = draftRules(reset);
  const button = reset ? $("reset-rule") : $("save-rule");
  button.disabled = true;
  try {
    await api("config", { revision: S.rule.revision, config: { rules } });
    await window.AniBTSession?.clear("ruleDraft");
    $("rule-dialog").close();
    await loadStatus();
    await loadFeed();
    toast(
      reset ? "已恢复这部番剧的默认偏好" : "番剧偏好已保存，下次检查自动应用。",
    );
  } finally {
    button.disabled = false;
  }
}

function syncThemeControls() {
  const design = window.AniBTTheme.getDesign();
  for (const button of document.querySelectorAll("[data-design-mode]")) {
    const selected = button.dataset.designMode === design;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
    button.disabled = !!S.themeSaving;
  }
  const mode = window.AniBTTheme.get();
  for (const button of document.querySelectorAll("[data-theme-mode]")) {
    const selected = button.dataset.themeMode === mode;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
    button.disabled = !!S.themeSaving;
  }
  const dark = document.documentElement.dataset.theme === "dark";
  $("theme-button").innerHTML = icon(
    mode === "system" ? "monitor" : dark ? "moon" : "sun",
  );
  $("theme-button").title =
    "当前主题：" +
    { system: "跟随系统", light: "浅色", dark: "深色" }[mode] +
    "（点击切换）";
  $("theme-button").setAttribute("aria-label", $("theme-button").title);
}

async function setTheme(mode) {
  if (S.themeSaving) return;
  const previous = window.AniBTTheme.get();
  S.themeSaving = true;
  window.AniBTTheme.apply(mode);
  try {
    const saved = await api("preferences", { theme: mode });
    if (S.status) S.status.preferences = saved;
  } catch (e) {
    window.AniBTTheme.apply(previous);
    throw e;
  } finally {
    S.themeSaving = false;
    syncThemeControls();
  }
}

async function requireAnimeScheduling() {
  if (!(await api("ping")).capabilities?.animeFolders)
    throw new Error(
      "当前窗口服务较旧，请关闭全部工具窗口，等待 30 秒后重新打开，再设置番剧目录和日期。",
    );
}

function updateRuleStartDate() {
  const inherited = $("rule-inherit-start-date").checked;
  $("rule-start-date").disabled = inherited;
  text(
    "rule-date-hint",
    inherited
      ? "沿用默认日期：" + (S.status?.config.startDate || "不限日期")
      : "按北京时间筛选资源发布时间，包含当天。留空表示这部番不限日期。",
  );
}

function settingsPatch() {
  const c = S.status.config;
  const getList = (id, old) =>
    $(id).value === "custom" ? old : $(id).value ? [$(id).value] : [];
  return {
    startEpisode:
      $("setting-start-episode").value === ""
        ? ""
        : Number($("setting-start-episode").value),
    startDate: $("setting-start-date").value,
    rssUrl: $("setting-rss").value.trim(),
    dedupeEpisodes: $("setting-dedupe").checked,
    intervalSeconds:
      $("setting-interval").value === "custom"
        ? c.intervalSeconds
        : Number($("setting-interval").value),
    filters: {
      priorityGroups: csv($("setting-priority").value),
      fallbackHours: Number($("setting-fallback").value),
      groups: S.globalGroups,
      resolutions: getList("setting-resolution", c.filters.resolutions),
      subtitles: getList("setting-subtitle", c.filters.subtitles),
      languages: $("setting-chs").checked ? ["CHS"] : [],
      include: csv($("setting-include").value),
      exclude: csv($("setting-exclude").value),
    },
    qb: {
      url: $("setting-qb-url").value.trim(),
      username: $("setting-username").value.trim(),
      password: $("setting-password").value,
      savePath: $("setting-path").value.trim(),
      category: $("setting-category").value.trim(),
      paused: $("setting-paused").checked,
      autoStart: $("setting-qb-autostart").checked,
      executable: $("setting-qb-executable").value.trim(),
    },
    notifications: {
      enabled: $("setting-notifications").checked,
      openOnDownload: $("setting-open-on-download").checked,
    },
  };
}

function draftRules(reset = false) {
  const c = S.status.config;
  let rules = c.rules.filter((r) => !sameRule(r));
  if (!reset) {
    const r = S.rule.original
      ? structuredClone(S.rule.original)
      : S.rule.anime.bgmId
        ? { bgmId: S.rule.anime.bgmId }
        : { title: S.rule.anime.title };
    if ($("rule-inherit-priority").checked) {
      delete r.priorityGroups;
      delete r.fallbackHours;
    } else {
      r.priorityGroups = csv($("rule-priority").value);
      r.fallbackHours = Number($("rule-fallback").value);
    }
    r.enabled = $("rule-enabled").checked;
    const folder = $("rule-save-path").value.trim();
    if (folder) r.savePath = folder;
    else delete r.savePath;
    if ($("rule-inherit-start-episode").checked) delete r.startEpisode;
    else
      r.startEpisode =
        $("rule-start-episode").value === ""
          ? ""
          : Number($("rule-start-episode").value);
    if ($("rule-inherit-start-date").checked) delete r.startDate;
    else r.startDate = $("rule-start-date").value;
    if (
      !Object.hasOwn(r, "startDate") ||
      r.startDate !== S.rule.original?.startDate
    )
      delete r.startDateFromSubscription;
    if ($("rule-inherit-groups").checked) delete r.groups;
    else r.groups = [...S.ruleGroups];
    for (const [id, key] of [
      ["rule-resolution", "resolutions"],
      ["rule-subtitle", "subtitles"],
    ]) {
      const v = $(id).value;
      if (v === "inherit") delete r[key];
      else if (v !== "custom") r[key] = v ? [v] : [];
    }
    rules = [r, ...rules];
  }
  return rules;
}

function updateRuleStartEpisode() {
  const inherited = $("rule-inherit-start-episode").checked;
  $("rule-start-episode").disabled = inherited;
  text(
    "rule-episode-hint",
    inherited
      ? "沿用默认开始集数：" +
          (S.status?.config.startEpisode
            ? "第 " + S.status.config.startEpisode + " 集（含）"
            : "不限集数")
      : "包含所填集数，留空不限。合集、特别篇和未知集号在限定集数时跳过。与查漏起始集分别设置。",
  );
}

async function requireStartEpisodeScheduling() {
  if (!(await api("ping")).capabilities?.startEpisode)
    throw new Error(
      "当前窗口服务较旧，请保存并关闭工具窗口，等待 30 秒后重新打开，再设置开始集数。",
    );
}

async function setDesign(design) {
  if (S.themeSaving) return;
  const previous = window.AniBTTheme.getDesign();
  S.themeSaving = true;
  window.AniBTTheme.setDesign(design);
  try {
    const saved = await api("preferences", { design });
    if (S.status) S.status.preferences = saved;
  } catch (error) {
    window.AniBTTheme.setDesign(previous);
    throw error;
  } finally {
    S.themeSaving = false;
    syncThemeControls();
  }
}
