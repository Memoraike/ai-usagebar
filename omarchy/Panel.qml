import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Native Omarchy Quattro popup. BarWidget.qml owns the bar slot and injects
// its button as this panel's anchor; collection stays in the Rust binary.
Panel {
  id: root
  moduleName: "akitaonrails.ai-usagebar"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.45)
  readonly property color track: Style.selectedFillFor(foreground, Color.accent)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property bool vertical: bar ? bar.vertical : false

  // RAG palette from Omarchy colors.toml (same source as Waybar Theme).
  property string hexGreen: "#98c379"
  property string hexYellow: "#e5c07b"
  property string hexOrange: "#d19a66"
  property string hexRed: "#e06c75"
  property color themeGreen: hexGreen
  property color themeYellow: hexYellow
  property color themeOrange: hexOrange
  property color themeRed: hexRed

  property var entries: []
  property string primaryProvider: ""
  property string selectedEntryId: ""
  property string loadError: ""
  property string commandStderr: ""
  property string commandStdout: ""
  property bool loading: true
  property int lastExitCode: 0
  property bool refreshQueued: false
  property double lastSuccessfulMs: 0
  property double nowMs: Date.now()
  property bool cursorActive: false
  property bool settingsOpen: false

  readonly property int refreshIntervalSec: Math.max(30, Math.min(3600,
    Number(setting("refreshIntervalSec", 300)) || 300))
  readonly property string configuredProvider: String(setting("provider", "") || "").trim()
  readonly property string rememberedEntryId: String(setting("lastSelectedEntryId", "") || "").trim()
  readonly property bool showValue: Model.booleanSetting(setting("showValue", true), true)
  readonly property bool showProvider: Model.booleanSetting(setting("showProvider", false), false)
  readonly property bool showAll: Model.booleanSetting(setting("showAll", false), false)
  readonly property bool colorCodeUsage: Model.booleanSetting(setting("colorCodeUsage", false), false)
  readonly property string barWindow: Model.normalizeBarWindow(setting("barWindow", "auto"))
  readonly property bool showCursorModels: Model.booleanSetting(setting("showCursorModels", true), true)
  readonly property bool showCursorOther: Model.booleanSetting(setting("showCursorOther", true), true)
  readonly property bool showCursorOnDemand: Model.booleanSetting(setting("showCursorOnDemand", true), true)
  readonly property var visibleEntries: Model.filteredEntries(entries, configuredProvider)
  readonly property int entryIndex: Model.selectedIndex(visibleEntries, selectedEntryId)
  readonly property var entry: entryIndex >= 0 ? visibleEntries[entryIndex] : null
  readonly property string entryFetchedAt: {
    if (!entry) return ""
    return String(entry.fetched_at || "")
  }
  readonly property var summary: Model.headline(entry, barWindow)
  // barWindow pins the bar value and its echoes (hero detail, tooltip).
  // Panel rows and alert state keep the historical highest-percent headline,
  // matching every other frontend (Waybar class, KDE isAlarming, TUI).
  // Grouped sub-rows (SuperGrok's product slices) gain a heading row here so
  // they render as a breakdown of the meter above, not peers of it.
  readonly property bool cursorEntry: isCursorEntry(entry)
  readonly property var entrySections: entry ? Model.groupedSections(entry.sections) : []
  readonly property bool filterMiss: configuredProvider !== "" && entries.length > 0 && visibleEntries.length === 0
  readonly property bool entryAlarming: shownAlarming()
  // A cached or failed provider response stays a status line, but a report
  // that never arrived has nothing else to show on the bar.
  readonly property bool reportMissing: loadError !== "" && entries.length === 0
  readonly property bool alarming: (showAll ? shownAnyAlarming() : entryAlarming)
    || reportMissing

  function alpha(color, opacity) {
    return Qt.rgba(color.r, color.g, color.b, opacity)
  }

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value))
  }

  function applyThemePalette(raw) {
    var parsed = Model.parseThemePalette(raw)
    hexGreen = parsed.green
    hexYellow = parsed.yellow
    hexOrange = parsed.orange
    hexRed = parsed.red
    themeGreen = hexGreen
    themeYellow = hexYellow
    themeOrange = hexOrange
    themeRed = hexRed
  }

  // critical prefers Quattro urgent (theme-linked); other rungs use colors.toml.
  // When colorCodeUsage is off, everything falls back to the bar foreground.
  function severityColorOf(severity) {
    if (!colorCodeUsage) return foreground
    if (severity === "critical") return urgent
    if (severity === "high") return themeOrange
    if (severity === "mid") return themeYellow
    if (severity === "low") return themeGreen
    return foreground
  }

  function severityHexOf(severity) {
    if (!colorCodeUsage) return ""
    if (severity === "critical") return hexRed
    if (severity === "high") return hexOrange
    if (severity === "mid") return hexYellow
    if (severity === "low") return hexGreen
    return ""
  }

  FileView {
    id: themeColorsFile
    path: Color.currentThemePath + "/colors.toml"
    watchChanges: true
    printErrors: false
    onLoaded: root.applyThemePalette(text())
    onFileChanged: reload()
    onLoadFailed: root.applyThemePalette("")
  }

  Connections {
    target: Color
    function onUrgentChanged() { themeColorsFile.reload() }
    function onAccentChanged() { themeColorsFile.reload() }
    function onForegroundChanged() { themeColorsFile.reload() }
  }

  function syncSelection() {
    if (visibleEntries.length === 0) {
      selectedEntryId = ""
      return
    }
    // The persisted choice is the source of truth. A refresh gap (fetch
    // error, sleep/wake stale list) briefly drops entries; the fallback
    // below then re-resolves to the primary and that transient selection
    // used to stick — the chosen entry came back and was ignored until a
    // shell restart. Once the remembered entry is back in the list, it wins
    // over any selection that only exists because of that gap.
    var remembered = rememberedEntryId
    if (remembered !== "") {
      for (var r = 0; r < visibleEntries.length; r++)
        if (visibleEntries[r].id === remembered) {
          selectedEntryId = remembered
          return
        }
    }
    for (var i = 0; i < visibleEntries.length; i++)
      if (visibleEntries[i].id === selectedEntryId) return
    selectedEntryId = Model.preferredEntryId(visibleEntries, primaryProvider, rememberedEntryId)
  }

  function restoreRememberedSelection() {
    if (visibleEntries.length === 0) return
    selectedEntryId = Model.preferredEntryId(visibleEntries, primaryProvider, rememberedEntryId)
  }

  function persistWidgetSettings(values) {
    // Quattro persists inline widget settings in shell.json and pushes them
    // live to every monitor. Keep every existing setting, including settings
    // introduced by future versions, and apply only the requested overrides.
    var entry = Model.settingsWithOverrides(root.settings, root.moduleName, values)
    if (!entry) return false

    // Apply locally first so controls remain responsive. Older compatible hosts
    // without updateEntryInline still retain the choice for this session.
    root.settings = entry
    if (hostWidget && "settings" in hostWidget) hostWidget.settings = entry
    if (bar && bar.shell && typeof bar.shell.updateEntryInline === "function")
      bar.shell.updateEntryInline(root.moduleName, entry)
    return true
  }

  function persistSelection(entryId) {
    if (String(entryId || "").trim() === rememberedEntryId) return
    persistWidgetSettings({ lastSelectedEntryId: entryId })
  }

  function setShowValue(enabled) {
    var next = enabled === true
    if (next === showValue) return
    persistWidgetSettings({ showValue: next })
  }

  function setShowProvider(enabled) {
    var next = enabled === true
    if (next === showProvider) return
    persistWidgetSettings({ showProvider: next })
  }

  function setShowAll(enabled) {
    var next = enabled === true
    if (next === showAll) return
    persistWidgetSettings({ showAll: next })
  }

  function setColorCodeUsage(enabled) {
    var next = enabled === true
    if (next === colorCodeUsage) return
    persistWidgetSettings({ colorCodeUsage: next })
  }

  function setBarWindow(value) {
    var next = Model.normalizeBarWindow(value)
    if (next === barWindow) return
    persistWidgetSettings({ barWindow: next })
  }

  function isCursorEntry(item) {
    if (!item) return false
    var id = String(item.id || "")
    var at = id.indexOf("@")
    return (at < 0 ? id : id.slice(0, at)) === "cursor"
  }

  function cursorPoolFlags() {
    return {
      models: showCursorModels,
      other: showCursorOther,
      demand: showCursorOnDemand
    }
  }

  function cursorShownFlags() {
    if (typeof Model.cursorBarFlags === "function")
      return Model.cursorBarFlags(entry, cursorPoolFlags())
    return cursorPoolFlags()
  }

  function cursorPoolOn(id) {
    return cursorShownFlags()[id] === true
  }

  function cursorPoolCanTurnOff(id) {
    var flags = cursorShownFlags()
    if (flags[id] !== true) return false
    var count = (flags.models ? 1 : 0) + (flags.other ? 1 : 0) + (flags.demand ? 1 : 0)
    return count > 1
  }

  function cursorPoolButtons() {
    var has = typeof Model.cursorPoolPresence === "function"
      ? Model.cursorPoolPresence(entry)
      : { models: true, other: true, demand: true }
    var rows = []
    if (has.models) rows.push({ poolId: "models", label: "Cursor Models" })
    if (has.other) rows.push({ poolId: "other", label: "Other Models" })
    if (has.demand) rows.push({ poolId: "demand", label: "On-Demand" })
    return rows
  }

  function toggleCursorPool(id) {
    var saved = cursorPoolFlags()
    var shown = cursorShownFlags()
    var next = Model.toggleCursorPool(shown, id)
    if (next.models === shown.models && next.other === shown.other
        && next.demand === shown.demand) return
    var has = typeof Model.cursorPoolPresence === "function"
      ? Model.cursorPoolPresence(entry)
      : { models: true, other: true, demand: true }
    persistWidgetSettings({
      showCursorModels: has.models ? next.models : saved.models,
      showCursorOther: has.other ? next.other : saved.other,
      showCursorOnDemand: has.demand ? next.demand : saved.demand
    })
  }

  function entryIsAlarming(item) {
    if (!item) return false
    if (isCursorEntry(item) && typeof Model.cursorDualHeadline === "function") {
      var dual = Model.cursorDualHeadline(item, cursorPoolFlags())
      // Brand / active chrome only when every visible Cursor pool is critical.
      // A lone exhausted pool still paints that segment red when colour-coding
      // is off; it must not tint the icon while another pool is still fine.
      if (dual) return dual.allCritical === true
    }
    return Model.isAlarming(item)
  }

  function shownAlarming() {
    return entryIsAlarming(entry)
  }

  function shownAnyAlarming() {
    for (var i = 0; i < visibleEntries.length; i++)
      if (entryIsAlarming(visibleEntries[i])) return true
    return false
  }

  function selectEntry(index) {
    if (visibleEntries.length === 0) return
    var wrapped = ((index % visibleEntries.length) + visibleEntries.length) % visibleEntries.length
    selectedEntryId = visibleEntries[wrapped].id
    persistSelection(selectedEntryId)
    if (providerList.visible) providerList.forceLayout()
    if (panelFlick) panelFlick.contentY = 0
  }

  // A bar chip stands for one entry when the bar shows several: select it,
  // then open the panel on it. The chip the panel already shows toggles
  // closed, the way the bar button does.
  function openEntry(entryId) {
    var wanted = String(entryId || "")
    for (var i = 0; i < visibleEntries.length; i++) {
      if (visibleEntries[i].id !== wanted) continue
      if (opened && i === entryIndex) {
        close()
        return
      }
      selectEntry(i)
      open()
      return
    }
    open()
  }

  function startRefresh() {
    if (usageProcess.running) {
      refreshQueued = true
      return
    }
    refreshQueued = false
    commandStdout = ""
    commandStderr = ""
    if (entries.length === 0) loading = true
    usageProcess.running = true
  }

  function finishRefresh() {
    var parsed = Model.parseReport(commandStdout)
    if (parsed.ok) {
      primaryProvider = parsed.primary
      entries = parsed.entries
      loadError = ""
      lastSuccessfulMs = Date.now()
      syncSelection()
    } else {
      var detail = commandStderr.trim()
      loadError = lastExitCode === 127
        ? Model.launchErrorMessage(lastExitCode, detail)
        : (detail !== "" ? Model.errorMessage(detail) : parsed.error)
    }
    loading = false
    if (refreshQueued) Qt.callLater(startRefresh)
  }

  function refresh() { startRefresh() }

  function openSettings() {
    settingsOpen = true
    cursorActive = false
    if (panelFlick) panelFlick.contentY = 0
    Qt.callLater(function() { settingsView.forceActiveFocus() })
  }

  function closeSettings() {
    settingsOpen = false
    if (panelFlick) panelFlick.contentY = 0
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  function openTerminalSettings() {
    if (hostWidget && typeof hostWidget.launchDashboard === "function")
      hostWidget.launchDashboard()
    else if (bar)
      bar.run("omarchy-launch-floating-terminal-with-presentation ai-usagebar-tui")
  }

  function openNousLogin() {
    if (bar && typeof bar.run === "function")
      bar.run("omarchy-launch-floating-terminal-with-presentation ai-usagebar auth nous login")
  }

  function openCopilotLogin() {
    if (bar && typeof bar.run === "function")
      bar.run("omarchy-launch-floating-terminal-with-presentation gh auth login --web")
  }

  function switchPanel(direction) {
    if (bar && typeof bar.switchPanelFrom === "function")
      return bar.switchPanelFrom(barIdentity, direction)
    return false
  }

  function statusMessage() {
    if (filterMiss) return "No configured entry matches ‘" + configuredProvider + "’. Clear the provider setting or use an id from ai-usagebar usage --json."
    if (entry && entry.error !== "") return entry.error
    if (loadError !== "") return entries.length > 0
      ? "Refresh failed; showing the previous report. " + loadError
      : loadError
    if (entry && entry.stale) return "Cached data · the provider could not supply a fresh response."
    return ""
  }

  function statusIsUrgent() {
    return filterMiss || (entry && entry.error !== "") || loadError !== ""
  }

  function heroMeta() {
    if (!entry) return loading ? "Loading providers" : "Usage report"
    if (entry.error !== "") return "Provider unavailable"
    var text = entry.plan || "Usage and limits"
    if (entry.stale) text += " · cached"
    return Model.autoTextSafe(text)
  }

  // Cursor reports two model pools, and the bar must show both. Reading the
  // sections here keeps the chip correct even when a hot reload is still
  // holding an older copy of Model.js, which only kept the higher pool.
  function cursorPools(item) {
    if (typeof Model.cursorDualHeadline === "function") {
      var dual = Model.cursorDualHeadline(item, cursorPoolFlags())
      if (dual && dual.text) return {
        text: dual.text,
        tooltip: dual.tooltip || dual.text,
        severity: dual.severity,
        allCritical: dual.allCritical === true,
        segments: dual.segments || [],
        tooltipRows: dual.tooltipRows || []
      }
    }
    if (!item) return null
    var id = String(item.id || "")
    var at = id.indexOf("@")
    if ((at < 0 ? id : id.slice(0, at)) !== "cursor") return null
    var sections = item.sections || []
    var auto = null
    var api = null
    for (var i = 0; i < sections.length; i++) {
      var row = sections[i]
      if (!row || row.type !== "metric") continue
      if (row.label === "Cursor Models") auto = row.percent
      else if (row.label === "Other Models") api = row.percent
    }
    if (auto === null || api === null || auto === undefined || api === undefined) return null
    return {
      text: auto + "% · " + api + "%",
      tooltip: "Cursor Models " + auto + "% · Other Models " + api + "%",
      segments: [],
      tooltipRows: []
    }
  }

  function panelHeadline(item) {
    if (isCursorEntry(item) && typeof Model.cursorDualHeadline === "function") {
      var dual = Model.cursorDualHeadline(item)
      if (dual && dual.text) return dual.text
    }
    return usageText(item, false)
  }

  function usageText(item, rich) {
    var pools = cursorPools(item)
    if (pools) return rich ? pools.tooltip : pools.text
    var head = Model.headline(item, barWindow)
    return rich ? (head.tooltip || head.text) : head.text
  }

  function shownEntries() {
    if (showAll) return visibleEntries
    if (entry) return [entry]
    return visibleEntries.length > 0 ? [visibleEntries[0]] : []
  }

  readonly property var barChips: labeledChips()

  function labeledChips() {
    var chips = Model.barChips(
      visibleEntries, entry, showAll, showValue, showProvider, loading, alarming, vertical, barWindow)
    if (!showValue || vertical) return chips
    var rows = shownEntries()
    var next = []
    for (var i = 0; i < chips.length; i++) {
      var chip = chips[i]
      var pools = i < rows.length ? cursorPools(rows[i]) : null
      if (!pools || chip.label === "!") {
        if (chip.label === "!" || i >= rows.length) {
          next.push(chip)
          continue
        }
        // Non-Cursor chips: headline severity drives icon RAG when colour-coding is on.
        var head = Model.headline(rows[i], barWindow)
        next.push({
          id: chip.id,
          brand: chip.brand,
          icon: chip.icon,
          label: chip.label,
          providerPrefix: "",
          alarming: chip.alarming,
          severity: head && head.severity ? head.severity : "",
          segments: chip.segments || []
        })
        continue
      }
      var label = pools.text
      var providerPrefix = ""
      if (showProvider) {
        var provider = Model.providerShort(rows[i])
        if (provider !== "") {
          label = provider + " " + label
          providerPrefix = provider + " "
        }
      }
      var segs = pools.segments || []
      // Cursor icon chrome (classic): allCritical. RAG icon uses severity
      // (worst / max-used among visible pools — status highest-severity rule).
      var chipAlarm = chip.alarming
      if (pools.allCritical === true || pools.allCritical === false) {
        chipAlarm = pools.allCritical === true
      } else if (pools.severity === "low" || pools.severity === "mid" || pools.severity === "high"
          || pools.severity === "critical") {
        chipAlarm = pools.severity === "critical"
      }
      next.push({
        id: chip.id,
        brand: chip.brand,
        icon: chip.icon,
        label: label,
        providerPrefix: providerPrefix,
        alarming: chipAlarm,
        severity: pools.severity || "",
        segments: segs
      })
    }
    return next
  }

  function barText() {
    if (showAll)
      return Model.barStrip(visibleEntries, alarming, vertical, showValue, showProvider, loading, barWindow)
    var value = entry ? usageText(entry, false) : summary.text
    return Model.barLabel(alarming, vertical, showValue, loading,
      entry !== null, value, showProvider ? Model.providerShort(entry) : "",
      Model.providerIcon(entry))
  }

  function tooltipLines(item) {
    var raw = String(usageText(item, true) || "").split("\n")
    var lines = []
    for (var i = 0; i < raw.length; i++) {
      var line = Model.autoTextSafe(raw[i]).trim()
      if (line !== "") lines.push(line)
    }
    return lines
  }

  // Colored hover rows when Cursor (or showAll) exposes per-pool severity.
  function tooltipRows() {
    function rowsFor(item) {
      var pools = cursorPools(item)
      if (pools && pools.tooltipRows && pools.tooltipRows.length > 0) {
        var out = []
        for (var r = 0; r < pools.tooltipRows.length; r++) {
          var row = pools.tooltipRows[r]
          var text = Model.autoTextSafe(row.text || "").trim()
          if (text === "") continue
          if (item && item.stale && r === pools.tooltipRows.length - 1)
            text += " · cached"
          out.push({ text: text, severity: row.severity || "low" })
        }
        return out
      }
      var lines = tooltipLines(item)
      if (lines.length === 0) return []
      var head = Model.headline(item, barWindow)
      var sev = head && head.severity ? head.severity : "low"
      if (lines.length > 1) {
        var multi = []
        for (var i = 0; i < lines.length; i++) {
          var bit = lines[i]
          if (item && item.stale && i === lines.length - 1) bit += " · cached"
          multi.push({ text: bit, severity: sev })
        }
        return multi
      }
      var single = Model.providerName(item)
      if (lines.length === 1) single += " · " + lines[0]
      if (item && item.stale) single += " · cached"
      return [{ text: single, severity: sev }]
    }

    if (showAll && visibleEntries.length > 0) {
      var chips = []
      for (var e = 0; e < visibleEntries.length; e++) {
        var chunk = rowsFor(visibleEntries[e])
        for (var c = 0; c < chunk.length; c++) chips.push(chunk[c])
      }
      return chips
    }
    if (!entry) {
      var msg = Model.autoTextSafe(statusMessage() || "AI usage")
      return msg !== "" ? [{ text: msg, severity: "" }] : []
    }
    return rowsFor(entry)
  }

  readonly property var ragTooltipRows: tooltipRows()
  readonly property string plainTooltipText: {
    var rows = ragTooltipRows
    if (rows.length > 0) {
      var lines = []
      for (var i = 0; i < rows.length; i++) {
        var text = String((rows[i] && rows[i].text) || "").trim()
        if (text !== "") lines.push(text)
      }
      if (lines.length > 0) return lines.join("\n")
    }
    return Model.autoTextSafe(statusMessage() || "AI usage")
  }

  onEntriesChanged: Qt.callLater(syncSelection)
  onConfiguredProviderChanged: Qt.callLater(syncSelection)
  onRememberedEntryIdChanged: Qt.callLater(restoreRememberedSelection)
  onOpenedChanged: {
    if (opened) {
      cursorActive = false
      nowMs = Date.now()
      if (panelFlick) panelFlick.contentY = 0
      if (lastSuccessfulMs === 0 || nowMs - lastSuccessfulMs >= refreshIntervalSec * 1000)
        startRefresh()
      Qt.callLater(function() { keyCatcher.forceActiveFocus() })
    } else {
      settingsOpen = false
    }
  }

  Timer {
    interval: root.refreshIntervalSec * 1000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.startRefresh()
  }

  Timer {
    interval: 30000
    running: root.opened
    repeat: true
    onTriggered: root.nowMs = Date.now()
  }

  Process {
    id: usageProcess
    running: false
    // /usr/bin/env always starts on Omarchy and reports a missing ai-usagebar
    // as exit 127. Keep the command as structured argv: no shell is needed.
    command: ["/usr/bin/env", "ai-usagebar", "usage", "--json"]

    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root.commandStdout = text
      }
    }

    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.commandStderr = text
    }

    onExited: function(exitCode) {
      root.lastExitCode = exitCode
      // Let both waitForEnd collectors publish their buffers first.
      Qt.callLater(function() { root.finishRefresh() })
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(390))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(640))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      // Native form controls own Tab/Enter/Esc while settings are open.
      blocked: root.settingsOpen

      onMoveRequested: function(dx, dy) {
        if (!root.settingsOpen && dx !== 0) {
          root.cursorActive = true
          root.selectEntry(root.entryIndex + dx)
        }
        if (dy !== 0)
          panelFlick.contentY = root.clamp(panelFlick.contentY + dy * Style.space(96), 0,
            Math.max(0, panelFlick.contentHeight - panelFlick.height))
      }
      onActivateRequested: if (!root.settingsOpen) root.refresh()
      onCloseRequested: root.settingsOpen ? root.closeSettings() : root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(text) {
        if (!root.settingsOpen && (text === "r" || text === "R")) root.refresh()
        else if (!root.settingsOpen && (text === "s" || text === "S")) root.openSettings()
      }

      Flickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        WheelHandler {
          target: null
          enabled: panelFlick.interactive
          acceptedDevices: PointerDevice.Mouse | PointerDevice.TouchPad
          onWheel: function(event) {
            if (event.pixelDelta.y === 0 && event.angleDelta.y === 0) {
              event.accepted = false
              return
            }
            // Keep touchpad motion smooth while covering more of the long settings form.
            var delta = event.pixelDelta.y !== 0
              ? event.pixelDelta.y * 5
              : event.angleDelta.y / 120 * Style.space(144)
            panelFlick.contentY = root.clamp(panelFlick.contentY - delta,
              0, Math.max(0, panelFlick.contentHeight - panelFlick.height))
          }
        }

        Column {
          id: column
          // The provider tabs are bordered buttons, and the first one in each
          // row sits flush against this Flickable's clip edge. At fractional
          // device scales (a 1.25 monitor scale, the shell font at its 12px
          // base) Qt snaps the 1px border to a device pixel that the clip
          // discards, so that tab renders with three borders. Keep a hairline
          // of slack on both sides so no control sits exactly on the clip
          // boundary. (#231)
          x: Style.spacing.hairline
          width: panelFlick.width - Style.spacing.hairline * 2
          spacing: Style.space(12)

          PanelHero {
            width: parent.width
            title: root.settingsOpen ? "Settings"
              : (root.entry ? Model.providerName(root.entry) : "AI usage")
            meta: root.settingsOpen ? "Display, provider & API keys" : root.heroMeta()
            detail: root.settingsOpen
              ? "Existing configuration stays in place until you save."
              : (root.entry && root.summary.text !== "Ready" ? Model.autoTextSafe(root.panelHeadline(root.entry)) : "")
            foreground: root.foreground
            fontFamily: root.fontFamily

            iconComponent: Component {
              BrandMark {
                brand: root.settingsOpen ? "" : Model.brandIconFile(root.entry)
                fallback: root.settingsOpen ? "󰒓" : Model.providerIcon(root.entry)
                // Colour-coding: full RAG from worst pool. Off: same aggregate,
                // binary foreground vs urgent when worst is critical.
                foreground: root.colorCodeUsage
                  ? root.severityColorOf(root.summary.severity || "")
                  : ((root.summary.severity || "") === "critical"
                    ? root.urgent : root.foreground)
                fontFamily: root.fontFamily
                fontSize: Style.font.display
              }
            }

            trailingControl: Component {
              Row {
                spacing: Style.space(4)

                PanelActionButton {
                  visible: !root.settingsOpen
                  iconText: "󰑐"
                  tooltipText: "Refresh usage"
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  enabled: !usageProcess.running
                  onClicked: root.refresh()
                }

                PanelActionButton {
                  iconText: root.settingsOpen ? "󰁍" : "󰒓"
                  tooltipText: root.settingsOpen ? "Back to usage" : "Settings"
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  onClicked: root.settingsOpen ? root.closeSettings() : root.openSettings()
                }
              }
            }
          }

          SettingsView {
            id: settingsView
            visible: root.settingsOpen
            width: parent.width
            foreground: root.foreground
            urgent: root.urgent
            fontFamily: root.fontFamily
            showValue: root.showValue
            showProvider: root.showProvider
            showAll: root.showAll
            colorCodeUsage: root.colorCodeUsage
            barWindow: root.barWindow
            onSaved: root.startRefresh()
            onShowValueRequested: function(enabled) { root.setShowValue(enabled) }
            onShowProviderRequested: function(enabled) { root.setShowProvider(enabled) }
            onShowAllRequested: function(enabled) { root.setShowAll(enabled) }
            onColorCodeUsageRequested: function(enabled) { root.setColorCodeUsage(enabled) }
            onBarWindowRequested: function(value) { root.setBarWindow(value) }
            onFallbackRequested: root.openTerminalSettings()
            onNousLoginRequested: root.openNousLogin()
            onCopilotLoginRequested: root.openCopilotLogin()
            onCloseRequested: root.closeSettings()
          }

          // Providers wrap into additional rows instead of being clipped by
          // the panel edge once there are more configured entries than fit
          // on one line — a fixed-width ListView silently hid entries past
          // the visible edge, with no way to reach them (see #173).
          Flow {
            id: providerList
            visible: !root.settingsOpen && root.visibleEntries.length > 1
            width: parent.width
            height: visible ? childrenRect.height : 0
            flow: Flow.LeftToRight
            spacing: Style.spacing.md

            Repeater {
              model: root.visibleEntries

              delegate: Button {
                required property var modelData
                required property int index

                height: Style.spacing.controlHeight
                width: implicitWidth
                text: Model.providerName(modelData)
                selected: index === root.entryIndex
                hasCursor: root.cursorActive && index === root.entryIndex
                bordered: true
                foreground: root.foreground
                fontFamily: root.fontFamily
                fontSize: Style.font.bodySmall
                verticalPadding: Style.spacing.controlPaddingY
                onClicked: {
                  root.cursorActive = true
                  root.selectEntry(index)
                }
                onHovered: function(isHovered) { if (isHovered) root.cursorActive = true }
              }
            }
          }

          Flow {
            id: cursorPoolToggles
            visible: !root.settingsOpen && root.cursorEntry
            width: parent.width
            height: visible ? childrenRect.height : 0
            flow: Flow.LeftToRight
            spacing: Style.spacing.md

            Repeater {
              model: root.cursorPoolButtons()

              delegate: Button {
                required property var modelData

                height: Style.spacing.controlHeight
                width: implicitWidth
                text: modelData.label
                selected: root.cursorPoolOn(modelData.poolId)
                enabled: root.cursorPoolCanTurnOff(modelData.poolId) || !root.cursorPoolOn(modelData.poolId)
                bordered: true
                foreground: root.foreground
                fontFamily: root.fontFamily
                fontSize: Style.font.bodySmall
                verticalPadding: Style.spacing.controlPaddingY
                onClicked: root.toggleCursorPool(modelData.poolId)
              }
            }
          }

          BorderSurface {
            readonly property string message: root.statusMessage()
            visible: !root.settingsOpen && message !== ""
            width: parent.width
            implicitHeight: statusText.implicitHeight + Style.spacing.xl * 2
            color: root.alpha(root.statusIsUrgent() ? root.urgent : root.foreground, 0.09)
            borderSpec: Border.flat(root.alpha(root.statusIsUrgent() ? root.urgent : root.foreground, 0.35), 1)
            radius: Style.cornerRadius

            Text {
              id: statusText
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              anchors.leftMargin: Style.space(12)
              anchors.rightMargin: Style.space(12)
              text: parent.message
              textFormat: Text.PlainText
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }
          }

          Column {
            visible: !root.settingsOpen && root.loading && root.entries.length === 0
            width: parent.width
            spacing: Style.space(8)

            PanelSectionHeader {
              text: "USAGE"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Text {
              width: parent.width
              text: "Collecting configured providers…"
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              horizontalAlignment: Text.AlignHCenter
            }
          }

          Column {
            id: usageSection
            visible: !root.settingsOpen && root.entrySections.length > 0
            width: parent.width
            spacing: Style.space(8)

            PanelSeparator {
              width: parent.width
              foreground: root.foreground
            }

            PanelSectionHeader {
              text: "USAGE & BALANCE"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Repeater {
              model: root.entrySections

              Column {
                required property var modelData
                width: usageSection.width

                // `visible` alone is not enough: QML evaluates the bindings of
                // hidden items too, so every row used to be handed to all three
                // components and the two that did not match read fields the row
                // does not carry. A "spacer" row has no label or value, which is
                // what produced the TypeError below on every report.
                MetricRow {
                  visible: modelData.type === "metric"
                  width: parent.width
                  row: modelData.type === "metric" ? modelData : null
                }

                DetailRow {
                  visible: modelData.type === "text"
                  width: parent.width
                  row: modelData.type === "text" ? modelData : null
                }

                BlockRow {
                  visible: modelData.type === "block"
                  width: parent.width
                  row: modelData.type === "block" ? modelData : null
                }

                Item {
                  visible: modelData.type === "spacer"
                  width: 1
                  height: Style.space(4)
                }
              }
            }
          }

          Text {
            visible: !root.settingsOpen && !root.loading && !root.entry && root.statusMessage() === ""
            width: parent.width
            topPadding: Style.space(20)
            text: "No configured provider reported usage."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
          }

          Text {
            visible: !root.settingsOpen && root.entryFetchedAt !== ""
            width: parent.width
            topPadding: Style.space(2)
            text: Model.formatUpdated(root.entryFetchedAt, root.nowMs)
              + (usageProcess.running ? " · refreshing…" : "")
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            horizontalAlignment: Text.AlignHCenter
            elide: Text.ElideRight
          }
        }
      }
    }
  }

  component MetricRow: Column {
    id: metricRow
    property var row: null
    // A grouped metric is a sub-row (SuperGrok's product slices under
    // "Breakdown"): dim label, thin muted gauge, no RAG colouring — the
    // overall meter above stays the binding constraint. The indent is applied
    // as margins inside full-width children, never as positioner padding: a
    // Column's leftPadding shifts children without narrowing them, which
    // pushes right-anchored values past the panel edge.
    readonly property bool grouped: row ? String(row.group || "") !== "" : false
    readonly property string severity: !grouped && row ? String(row.severity || "") : ""
    readonly property color ragColor: root.severityColorOf(metricRow.severity)
    readonly property color labelColor: grouped ? root.dim : root.foreground
    readonly property color valueColor: grouped ? metricRow.labelColor : metricRow.ragColor
    readonly property color fillColor: grouped
      ? root.alpha(root.foreground, 0.38)
      : metricRow.ragColor
    readonly property int indent: grouped ? Style.space(10) : 0
    readonly property string detailText: Model.metricDetail(row)
    readonly property string resetText: row ? Model.formatReset(row.reset_at, root.nowMs) : ""

    spacing: Style.space(grouped ? 4 : 6)

    Item {
      width: parent.width
      implicitHeight: Math.max(metricLabel.implicitHeight, metricValue.implicitHeight)

      Text {
        id: metricLabel
        text: metricRow.row ? metricRow.row.label : ""
        textFormat: Text.PlainText
        color: metricRow.labelColor
        font.family: root.fontFamily
        font.pixelSize: metricRow.grouped ? Style.font.caption : Style.font.body
        elide: Text.ElideRight
        anchors.left: parent.left
        anchors.leftMargin: metricRow.indent
        anchors.right: metricValue.left
        anchors.rightMargin: Style.spacing.sm
        anchors.verticalCenter: parent.verticalCenter
      }

      Text {
        id: metricValue
        text: metricRow.row && metricRow.row.value !== ""
          ? metricRow.row.value : (metricRow.row ? metricRow.row.percent + "%" : "")
        textFormat: Text.PlainText
        color: metricRow.valueColor
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        font.bold: !metricRow.grouped
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
      }
    }

    Item {
      width: parent.width
      implicitHeight: Math.max(Style.space(4), Math.round(Style.spacing.controlHeight * (metricRow.grouped ? 0.10 : 0.14)))

      Rectangle {
        id: meterTrack
        anchors.fill: parent
        anchors.leftMargin: metricRow.indent
        radius: height / 2
        color: metricRow.grouped ? root.alpha(root.foreground, 0.10) : root.track
      }

      Rectangle {
        anchors.left: meterTrack.left
        anchors.verticalCenter: meterTrack.verticalCenter
        height: meterTrack.height
        radius: meterTrack.radius
        width: meterTrack.width * root.clamp(metricRow.row ? metricRow.row.percent / 100 : 0, 0, 1)
        color: metricRow.fillColor

        Behavior on width {
          NumberAnimation { duration: 160; easing.type: Easing.OutCubic }
        }
      }
    }

    Text {
      visible: text !== ""
      width: parent.width
      leftPadding: metricRow.indent
      text: metricRow.detailText
      textFormat: Text.PlainText
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }

    Text {
      visible: text !== ""
      width: parent.width
      leftPadding: metricRow.indent
      text: metricRow.resetText
      textFormat: Text.PlainText
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      // The row now carries a date and clock as well as the countdown, so it
      // can outgrow a narrow panel. Wrap like the detail line above it rather
      // than painting past the panel edge.
      wrapMode: Text.WordWrap
    }
  }

  component DetailRow: Item {
    id: detailRow
    property var row: null
    readonly property bool heading: row && row.label !== "" && row.value === ""

    implicitHeight: heading ? headingLabel.implicitHeight : Math.max(detailLabel.implicitHeight, detailValue.implicitHeight)

    PanelSectionHeader {
      id: headingLabel
      visible: detailRow.heading
      width: parent.width
      text: detailRow.row ? Model.autoTextSafe(String(detailRow.row.label || "").toUpperCase()) : ""
      foreground: root.foreground
      fontFamily: root.fontFamily
    }

    Text {
      id: detailLabel
      visible: !detailRow.heading && text !== ""
      text: detailRow.row ? detailRow.row.label : ""
      textFormat: Text.PlainText
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      font.bold: true
      anchors.left: parent.left
      anchors.top: parent.top
      width: Math.min(implicitWidth, parent.width * 0.42)
      elide: Text.ElideRight
    }

    Text {
      id: detailValue
      visible: !detailRow.heading
      text: detailRow.row ? detailRow.row.value : ""
      textFormat: Text.PlainText
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      horizontalAlignment: detailLabel.visible ? Text.AlignRight : Text.AlignLeft
      wrapMode: Text.WordWrap
      anchors.left: detailLabel.visible ? detailLabel.right : parent.left
      anchors.leftMargin: detailLabel.visible ? Style.spacing.md : 0
      anchors.right: parent.right
      anchors.top: parent.top
    }
  }

  component BlockRow: Column {
    id: blockRow
    property var row: null

    spacing: Style.space(4)

    Text {
      width: parent.width
      text: blockRow.row ? blockRow.row.label : ""
      textFormat: Text.PlainText
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      font.bold: true
      elide: Text.ElideRight
    }

    Text {
      width: parent.width
      text: blockRow.row && blockRow.row.body ? blockRow.row.body.join("\n") : ""
      textFormat: Text.PlainText
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }
  }
}
