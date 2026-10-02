import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./Model.js', import.meta.url), 'utf8');
const model = {};
vm.createContext(model);
vm.runInContext(source, model, {filename: 'Model.js'});

// Keep the marketplace/runtime shape in CI. The marketplace's structural
// validator only checks that the declared file exists; Quattro additionally
// needs the bar entry point to forward its nested panel lifecycle.
const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
assert.deepEqual(manifest.kinds, ['bar-widget']);
assert.equal(manifest.entryPoints.barWidget, 'omarchy/BarWidget.qml');
assert.equal(manifest.barWidget.defaults.showValue, true);
const showValueSchema = manifest.barWidget.schema.find(row => row.key === 'showValue');
assert.equal(showValueSchema.type, 'boolean');
assert.equal(showValueSchema.defaultValue, true);
// Opt-in, so an existing bar entry that has never seen this key keeps the
// label it has today.
assert.equal(manifest.barWidget.defaults.showProvider, false);
const showProviderSchema = manifest.barWidget.schema.find(row => row.key === 'showProvider');
assert.equal(showProviderSchema.type, 'boolean');
assert.equal(showProviderSchema.defaultValue, false);
assert.equal(manifest.barWidget.defaults.showAll, false);
const showAllSchema = manifest.barWidget.schema.find(row => row.key === 'showAll');
assert.equal(showAllSchema.type, 'boolean');
assert.equal(showAllSchema.defaultValue, false);
assert.equal(manifest.barWidget.defaults.colorCodeUsage, false);
const colorCodeUsageSchema = manifest.barWidget.schema.find(row => row.key === 'colorCodeUsage');
assert.equal(colorCodeUsageSchema.type, 'boolean');
assert.equal(colorCodeUsageSchema.defaultValue, false);
// Pinned window is opt-in display-only: existing shell.json entries without
// the key keep the historical highest-percent label.
assert.equal(manifest.barWidget.defaults.barWindow, 'auto');
const barWindowSchema = manifest.barWidget.schema.find(row => row.key === 'barWindow');
assert.equal(barWindowSchema.type, 'enum');
assert.deepEqual(barWindowSchema.options, ['auto', 'session', 'weekly', 'monthly']);
assert.equal(barWindowSchema.defaultValue, 'auto');
for (const key of ['showCursorModels', 'showCursorOther', 'showCursorOnDemand']) {
  assert.equal(manifest.barWidget.defaults[key], true);
  const row = manifest.barWidget.schema.find(item => item.key === key);
  assert.equal(row.type, 'boolean');
  assert.equal(row.defaultValue, true);
}
// The normalizer must accept every option the manifest offers, or the
// dropdown would write a value the panel silently ignores.
for (const option of barWindowSchema.options)
  assert.equal(model.normalizeBarWindow(option), option);

const barWidgetSource = fs.readFileSync(new URL('./BarWidget.qml', import.meta.url), 'utf8');
assert.match(barWidgetSource, /^BarWidget\s*\{/m);
for (const method of ['open', 'close', 'toggle', 'closeForPopoutSwitch'])
  assert.match(barWidgetSource, new RegExp(`function\\s+${method}\\s*\\(`));
assert.match(barWidgetSource, /source:\s*Qt\.resolvedUrl\("Panel\.qml"\)/);
assert.match(barWidgetSource, /target\.anchorItem\s*=\s*button/);
assert.match(barWidgetSource, /target\.hostWidget\s*=\s*root/);
assert.match(barWidgetSource, /buttonCode\s*===\s*Qt\.RightButton\)\s*root\.launchDashboard\(\)/);
// The bar presses a slot's widget with no coordinates, so each chip registers
// as its own click target and the bar picks the one under the pointer; a lone
// chip leaves the button as the only target and its press toggles as before.
assert.match(barWidgetSource, /function\s+chipItems\s*\(/);
assert.match(barWidgetSource, /function\s+syncChipTargets\s*\(/);
assert.match(barWidgetSource, /onModelChanged:\s*Qt\.callLater\(root\.syncChipTargets\)/);
assert.match(barWidgetSource, /if\s*\(chips\.length\s*<=\s*1\)\s*return/);
// The registered target is the chip's whole column of the slot: the bar
// hit-tests it by rect, so the glyph-height delegate alone left the padding
// above and below it to the button as well as the gaps beside it.
assert.match(barWidgetSource, /Model\.chipHitGaps\(index,\s*chipRepeater\.count,\s*Style\.space\(10\),\s*Style\.spaceReal\(17\)\s*\/\s*2\)/);
// The button's edge padding lives in the outer columns, so it must not be
// added to the widget's width a second time.
assert.match(barWidgetSource, /fixedWidth:\s*root\.bar\s*&&\s*root\.bar\.vertical\s*\?\s*-1\s*:\s*chipRow\.implicitWidth\n/);
assert.match(barWidgetSource, /height:\s*button\.height/);
assert.match(barWidgetSource, /width:\s*chipContent\.implicitWidth\s*\+\s*hitGaps\.left\s*\+\s*hitGaps\.right/);
assert.match(barWidgetSource, /x:\s*chipHit\.hitGaps\.left/);
// While the panel is open the chips it is not showing step back, so the bar
// says which entry the panel belongs to. The placeholders for a lone, vertical
// or empty bar carry no id, so they never dim, and the click column above the
// content keeps full opacity.
assert.match(barWidgetSource, /opacity:\s*root\.opened\s*&&\s*root\.panelItem\s*&&\s*modelData\.id\s*\n\s*&&\s*modelData\.id\s*!==\s*root\.panelItem\.selectedEntryId\s*\?\s*0\.45\s*:\s*1/);
assert.match(barWidgetSource, /Behavior on opacity\s*\{\s*\n\s*NumberAnimation\s*\{\s*duration:\s*140/);
assert.match(barWidgetSource, /function\s+triggerPress\s*\(buttonCode\)/);
assert.match(barWidgetSource, /root\.panelItem\.openEntry\(chipHit\.chip\.id\s*\|\|\s*""\)/);
// Classic alarm chrome when colour-coding is off; RAG colours replace it when on.
assert.match(barWidgetSource, /active:\s*!root\.colorCodeUsage\s*&&\s*root\.alarming/);
assert.match(barWidgetSource, /text:\s*root\.alarming\s*\?\s*"󰅙"\s*:\s*"󰚩"/);
assert.doesNotMatch(barWidgetSource, /\bIpcHandler\s*\{/);

const panelSource = fs.readFileSync(new URL('./Panel.qml', import.meta.url), 'utf8');
assert.match(panelSource, /^Panel\s*\{/m);
assert.match(panelSource, /property\s+var\s+anchorItem:\s*null/);
assert.match(panelSource, /property\s+var\s+hostWidget:\s*null/);
assert.match(panelSource, /SettingsView\s*\{/);
assert.match(panelSource, /function\s+openSettings\s*\(/);
assert.match(panelSource, /function\s+openEntry\s*\(/);
assert.match(panelSource, /id:\s*chip\.id/);
assert.match(panelSource, /setting\("lastSelectedEntryId",\s*""\)/);
assert.match(panelSource, /setting\("showValue",\s*true\)/);
assert.match(panelSource, /setting\("showProvider",\s*false\)/);
assert.match(panelSource, /setting\("showAll",\s*false\)/);
assert.match(panelSource, /setting\("colorCodeUsage",\s*false\)/);
assert.match(panelSource, /Model\.normalizeBarWindow\(setting\("barWindow",\s*"auto"\)\)/);
// The pin covers the bar value and its echoes (hero detail, tooltip):
// summary (bar label/chips) is pinned, while panel rows keep every pool.
// Cursor's bar urgent state follows the pools still on the chip.
assert.match(panelSource, /Model\.headline\(entry,\s*barWindow\)/);
assert.match(panelSource, /Model\.headline\(item,\s*barWindow\)/);
assert.match(panelSource, /Model\.isAlarming\(item\)/);
// A failed or cached refresh alone cannot activate the bar, but a report that
// never arrived has nothing else to show there.
assert.match(panelSource, /readonly property bool reportMissing:\s*loadError\s*!==\s*""\s*&&\s*entries\.length\s*===\s*0/);
assert.match(panelSource, /\(showAll\s*\?\s*shownAnyAlarming\(\)\s*:\s*entryAlarming\)[\s\S]{0,40}reportMissing/);
assert.doesNotMatch(panelSource, /chipAlarm\s*=\s*rows\[i\]\.status\s*===\s*"error"/);
assert.match(panelSource, /function shownAnyAlarming\(\)/);
assert.doesNotMatch(panelSource, /Model\.anyAlarming\(visibleEntries\)/);
assert.doesNotMatch(panelSource, /autoSummary/);
assert.match(panelSource, /function\s+setBarWindow\s*\(/);
assert.match(panelSource, /onBarWindowRequested/);
assert.match(panelSource, /showProvider\s*\?\s*Model\.providerShort\(entry\)\s*:\s*""/);
assert.match(panelSource, /Model\.barStrip\([\s\S]*?barWindow/);
assert.match(panelSource, /Model\.barChips\([\s\S]*?barWindow/);
assert.match(panelSource, /Model\.providerIcon\(entry\)/);
assert.match(panelSource, /BrandMark\s*\{/);
assert.match(panelSource, /Model\.brandIconFile\(root\.entry\)/);

// Provider tabs must wrap into additional rows instead of being clipped by
// the panel edge when more providers are configured than fit on one line.
assert.match(panelSource, /Flow\s*\{[\s\S]*?id:\s*providerList/);
assert.match(panelSource, /flow:\s*Flow\.LeftToRight/);
assert.match(panelSource, /height:\s*visible\s*\?\s*childrenRect\.height\s*:\s*0/);
assert.match(panelSource, /width:\s*implicitWidth/);
assert.doesNotMatch(panelSource, /orientation:\s*ListView\.Horizontal/);
assert.match(panelSource, /providerList\.forceLayout\(\)/);
// The scroll content keeps a hairline of slack on both sides of the
// Flickable's clip edge. The first provider tab is a bordered button, and at
// fractional device scales (a 1.25 monitor scale) Qt drops the 1px left
// border of a control that sits exactly on the clip boundary, so that tab
// rendered with three borders. (#231)
assert.match(panelSource, /Column\s*\{[\s\S]*?id:\s*column[\s\S]*?x:\s*Style\.spacing\.hairline/);
assert.match(panelSource, /width:\s*panelFlick\.width\s*-\s*Style\.spacing\.hairline\s*\*\s*2/);
// Long settings forms must remain reachable with mouse wheels and touchpads.
assert.match(panelSource, /WheelHandler\s*\{[\s\S]*?acceptedDevices:\s*PointerDevice\.Mouse\s*\|\s*PointerDevice\.TouchPad/);
const touchpadScale = /event\.pixelDelta\.y\s*\*\s*(\d+(?:\.\d+)?)/.exec(panelSource);
assert.equal(Number(touchpadScale?.[1]), 5, 'touchpad scroll covers five times the raw pixel delta');
assert.match(panelSource, /event\.angleDelta\.y\s*\/\s*120\s*\*\s*Style\.space\(/);
// The persisted choice is the source of truth on every entries change: when
// a refresh gap briefly dropped the chosen entry, syncSelection's fallback
// re-resolved to the primary and that transient selection stuck after the
// entry returned. The remembered-entry loop must run BEFORE the
// current-selection early return so the chosen entry wins once it is back.
const syncSource = panelSource.slice(
  panelSource.indexOf('function syncSelection()'),
  panelSource.indexOf('function restoreRememberedSelection'));
assert.match(syncSource, /for \(var r = 0; r < visibleEntries\.length; r\+\+\)/, 'remembered-entry loop exists');
assert.ok(
  syncSource.indexOf('for (var r = 0') < syncSource.indexOf('for (var i = 0'),
  'remembered-entry check precedes the current-selection early return'
);
// The panel brand mark colour-codes by the summary severity only when the
// toggle is on; off, it keeps the classic binary foreground vs urgent when
// the worst pool is critical.
assert.match(panelSource, /foreground:\s*root\.colorCodeUsage\s*\n\s*\?\s*root\.severityColorOf\(root\.summary\.severity\s*\|\|\s*""\)/);
assert.match(panelSource, /\(\(root\.summary\.severity\s*\|\|\s*""\)\s*===\s*"critical"\s*\n\s*\?\s*root\.urgent\s*:\s*root\.foreground\)/);
assert.doesNotMatch(panelSource, /BrandMark[\s\S]*foreground:\s*root\.alarming\s*\?/m);
const brandMarkSource = fs.readFileSync(new URL('./BrandMark.qml', import.meta.url), 'utf8');
assert.match(brandMarkSource, /icons\/" \+ root\.brand/);
assert.ok(fs.existsSync(new URL('./icons/claude.svg', import.meta.url)));
assert.ok(fs.existsSync(new URL('./icons/openai.svg', import.meta.url)));
assert.ok(fs.existsSync(new URL('./icons/grok.svg', import.meta.url)));
assert.ok(fs.existsSync(new URL('./icons/grokbot.svg', import.meta.url)));
assert.ok(fs.existsSync(new URL('./icons/copilot.svg', import.meta.url)));
assert.match(panelSource, /function\s+persistSelection\s*\(/);
assert.match(panelSource, /Model\.settingsWithOverrides\(root\.settings,\s*root\.moduleName,\s*values\)/);
assert.match(panelSource, /bar\.shell\.updateEntryInline\(root\.moduleName,\s*entry\)/);
assert.match(panelSource, /persistSelection\(selectedEntryId\)/);
assert.match(panelSource, /Model\.barLabel\(/);
// Cursor pool switches filter the bar chip and tooltip. The open panel keeps
// every pool, including the hero numbers.
assert.match(panelSource, /entrySections:\s*entry\s*\?\s*Model\.groupedSections\(entry\.sections\)/);
assert.doesNotMatch(panelSource, /filterCursorSections/);
assert.match(panelSource, /cursorDualHeadline\(item,\s*cursorPoolFlags\(\)\)/);
assert.match(panelSource, /function panelHeadline\(item\) \{[\s\S]*?cursorDualHeadline\(item\)(?!\s*,)/);

const settingsViewSource = fs.readFileSync(new URL('./SettingsView.qml', import.meta.url), 'utf8');
assert.match(settingsViewSource, /command:\s*\["ai-usagebar",\s*"settings",\s*"show"\]/);
assert.match(settingsViewSource, /command:\s*\["ai-usagebar",\s*"settings",\s*"apply"\]/);
assert.match(settingsViewSource, /stdinEnabled:\s*true/);
assert.match(settingsViewSource, /write\(root\.pendingPayload\s*\+\s*"\\n"\)/);
assert.match(settingsViewSource, /password:\s*true/);
assert.match(settingsViewSource, /function\s+finishApply\s*\(\)\s*\{[\s\S]*?scrubSecrets\(\)[\s\S]*?if\s*\(applyExitCode/s);
assert.match(settingsViewSource, /signal\s+nousLoginRequested\(\)/);
assert.match(settingsViewSource, /signal\s+copilotLoginRequested\(\)/);
assert.match(settingsViewSource, /signal\s+showValueRequested\(bool\s+enabled\)/);
assert.match(settingsViewSource, /label:\s*"Show usage value in the top bar"/);
assert.match(settingsViewSource, /signal\s+showProviderRequested\(bool\s+enabled\)/);
assert.match(settingsViewSource, /label:\s*"Show provider name in the top bar"/);
assert.match(settingsViewSource, /signal\s+showAllRequested\(bool\s+enabled\)/);
assert.match(settingsViewSource, /label:\s*"Show all providers in the top bar"/);
assert.match(settingsViewSource, /signal\s+colorCodeUsageRequested\(bool\s+enabled\)/);
assert.match(settingsViewSource, /label:\s*"Color-code usage by level"/);
assert.match(settingsViewSource, /signal\s+barWindowRequested\(string\s+value\)/);
assert.match(settingsViewSource, /text:\s*"TOP BAR WINDOW"/);
assert.match(settingsViewSource, /\{\s*value:\s*"auto",\s*label:\s*"Highest \(auto\)"/);
assert.match(settingsViewSource, /\{\s*value:\s*"session",\s*label:\s*"5-hour \(session\)"/);
assert.match(settingsViewSource, /\{\s*value:\s*"weekly",\s*label:\s*"7-day \(weekly\)"/);
assert.match(settingsViewSource, /\{\s*value:\s*"monthly",\s*label:\s*"Monthly \(monthly\)"/);
assert.match(panelSource, /barWindow:\s*root\.barWindow/);
assert.match(panelSource, /onShowAllRequested/);
assert.match(panelSource, /onShowProviderRequested/);
assert.match(settingsViewSource, /Log in with Nous Research/);
assert.match(settingsViewSource, /Log in with GitHub Copilot/);
assert.match(settingsViewSource, /choose GitHub Copilot as primary and save/);
assert.match(settingsViewSource, /model:\s*root\.snapshot\.keys/);
// Provider on/off switches (#244): the section lists the snapshot's vendors
// and routes every change through the same stdin patch as the keys.
assert.match(settingsViewSource, /text:\s*"PROVIDERS"/);
assert.match(settingsViewSource, /model:\s*root\.snapshot\.vendors/);
assert.match(settingsViewSource, /function\s+collectVendorToggles\s*\(/);
assert.match(settingsViewSource, /function\s+setVendorOverride\s*\(/);
assert.match(
  settingsViewSource,
  /Model\.buildSettingsPatch\(selectedPrimary,\s*collectChanges\(\),\s*collectVendorToggles\(\)\)/
);
assert.match(settingsViewSource, /Paste\s*"\s*\+\s*\(keyCard\.modelData\.secret_label/);
assert.match(panelSource, /function\s+openNousLogin\s*\(/);
assert.match(panelSource, /ai-usagebar auth nous login/);
assert.match(panelSource, /onNousLoginRequested/);
assert.match(panelSource, /function\s+openCopilotLogin\s*\(/);
assert.match(panelSource, /gh auth login --web/);
assert.match(panelSource, /onCopilotLoginRequested/);
assert.doesNotMatch(settingsViewSource, /GitHub OAuth token|GITHUB_COPILOT_TOKEN/);
assert.doesNotMatch(settingsViewSource, /command:\s*\[[^\]]*(?:api.?key|secret|pendingPayload)/i);

const raw = JSON.stringify({primary: 'openai', entries: [
  {
    id: 'anthropic@work',
    name: 'anthropic · work',
    display_name: 'Claude · work',
    short_name: 'cld',
    brand: 'anthropic',
    plan: 'Claude Max 20x',
    status: 'ready',
    error: null,
    stale: true,
    fetched_at: '2026-08-14T12:00:00Z',
    sections: [
      {type: 'spacer'},
      {type: 'metric', label: 'Session (5h)', percent: 29, value: '29%',
       detail: 'Resets in 2h 0m · 60% elapsed · 31pts under', severity: 'low',
       reset_at: '2026-08-14T14:00:00Z'},
      {type: 'text', label: 'Balance', value: '$12.00'},
      {type: 'block', label: 'Credits', body: ['balance: 20', '≈ 10 messages']}
    ]
  },
  {
    id: 'openai', name: 'openai', display_name: 'Codex', short_name: 'gpt', plan: 'Plus', error: null,
    sections: [{type: 'metric', label: 'Codex weekly', percent: 95, value: '95%', detail: '', severity: 'critical'}]
  }
]});

const parsed = model.parseReport(raw);
assert.equal(parsed.ok, true);
assert.equal(parsed.primary, 'openai');
assert.equal(parsed.entries.length, 2);
assert.equal(parsed.entries[0].stale, true);
assert.equal(parsed.entries[0].brand, 'anthropic');
assert.equal(parsed.entries[0].sections[1].reset_at, '2026-08-14T14:00:00Z');
assert.equal(model.providerName(parsed.entries[0]), 'Claude · work');
assert.equal(model.providerName(parsed.entries[1]), 'Codex');
assert.deepEqual(Array.from(model.filteredEntries(parsed.entries, '')).map(entry => entry.id), ['anthropic@work', 'openai']);
assert.deepEqual(Array.from(model.filteredEntries(parsed.entries, 'anthropic')).map(entry => entry.id), ['anthropic@work']);
assert.deepEqual(Array.from(model.filteredEntries(parsed.entries, 'openai')).map(entry => entry.id), ['openai']);
assert.equal(model.selectedIndex(parsed.entries, 'openai'), 1);
assert.equal(model.selectedIndex(parsed.entries, 'missing'), 0);
assert.equal(model.preferredEntryId(parsed.entries, parsed.primary), 'openai');
assert.equal(model.preferredEntryId(parsed.entries, 'anthropic'), 'anthropic@work');
assert.equal(model.preferredEntryId(parsed.entries, 'missing'), 'anthropic@work');
assert.equal(model.preferredEntryId(parsed.entries, parsed.primary, 'anthropic@work'), 'anthropic@work');
assert.equal(model.preferredEntryId(parsed.entries, parsed.primary, '  ANTHROPIC@WORK  '), 'anthropic@work');
assert.equal(model.preferredEntryId(parsed.entries, parsed.primary, 'missing'), 'openai');

const openRouterAccounts = model.parseReport(JSON.stringify({entries: [{
  id: 'openrouter@work', name: 'openrouter · work', display_name: 'OpenRouter · work',
  error: null, sections: []
}, {
  id: 'openrouter@personal', name: 'openrouter · personal', display_name: 'OpenRouter · personal',
  error: null, sections: []
}]})).entries;
assert.deepEqual(Array.from(model.filteredEntries(openRouterAccounts, 'openrouter')).map(entry => entry.id),
  ['openrouter@work', 'openrouter@personal']);
assert.equal(model.providerName(openRouterAccounts[0]), 'OpenRouter · work');
assert.equal(model.preferredEntryId(openRouterAccounts, 'openrouter', 'openrouter@personal'),
  'openrouter@personal');
assert.equal(model.preferredEntryId(openRouterAccounts, 'openrouter', 'openrouter@missing'),
  'openrouter@work');

const priorWidgetSettings = {
  provider: '', refreshIntervalSec: 90, futureSetting: {keep: true}, id: 'stale-id'
};
const selectedWidgetSettings = model.settingsWithSelectedEntry(
  priorWidgetSettings, 'akitaonrails.ai-usagebar', 'openrouter@personal');
assert.deepEqual(JSON.parse(JSON.stringify(selectedWidgetSettings)), {
  id: 'akitaonrails.ai-usagebar',
  provider: '',
  refreshIntervalSec: 90,
  futureSetting: {keep: true},
  lastSelectedEntryId: 'openrouter@personal'
});
assert.equal(priorWidgetSettings.lastSelectedEntryId, undefined);
assert.equal(model.settingsWithSelectedEntry({}, 'akitaonrails.ai-usagebar', ''), null);
const hiddenValueSettings = model.settingsWithOverrides(
  selectedWidgetSettings, 'akitaonrails.ai-usagebar', {showValue: false});
assert.equal(hiddenValueSettings.showValue, false);
assert.equal(hiddenValueSettings.lastSelectedEntryId, 'openrouter@personal');
assert.equal(selectedWidgetSettings.showValue, undefined);
const shownProviderSettings = model.settingsWithOverrides(
  hiddenValueSettings, 'akitaonrails.ai-usagebar', {showProvider: true});
assert.equal(shownProviderSettings.showProvider, true);
assert.equal(shownProviderSettings.showValue, false);
assert.equal(shownProviderSettings.lastSelectedEntryId, 'openrouter@personal');
assert.equal(hiddenValueSettings.showProvider, undefined);
const protectedSettings = model.settingsWithOverrides({}, 'akitaonrails.ai-usagebar', {
  id: 'wrong-id', constructor: 'ignored', prototype: 'ignored', showValue: false
});
assert.equal(protectedSettings.id, 'akitaonrails.ai-usagebar');
assert.notEqual(protectedSettings.constructor, 'ignored');
assert.equal(protectedSettings.prototype, undefined);
assert.equal(model.booleanSetting(undefined, true), true);
assert.equal(model.booleanSetting(false, true), false);
assert.equal(model.booleanSetting('false', true), false);
assert.equal(model.booleanSetting('true', false), true);
assert.equal(model.booleanSetting('invalid', true), true);

assert.equal(model.barLabel(false, false, true, false, true, '29%'), '󰚩  29%');
assert.equal(model.barLabel(false, false, false, false, true, '29%'), '󰚩');
assert.equal(model.barLabel(true, false, true, false, true, '95%'), '󰚩  95%');
assert.equal(model.barLabel(true, false, false, false, true, '95%'), '󰚩');
assert.equal(model.barLabel(true, false, true, false, false, ''), '󰅙');
assert.equal(model.barLabel(false, true, true, false, true, '29%'), '󰚩');
assert.equal(model.barLabel(true, true, true, false, true, '95%'), '󰅙');
assert.equal(model.barLabel(false, false, true, true, false, ''), '󰚩  …');

// The provider tag is opt-in and arrives already resolved, so every call
// above — no seventh argument at all — has to keep its historical label.
assert.equal(model.barLabel(false, false, true, false, true, '29%', 'gpt'), '󰚩  gpt 29%');
// Tag on, value off: the icon-only label grows the tag and nothing else.
assert.equal(model.barLabel(false, false, false, false, true, '29%', 'gpt'), '󰚩  gpt');
assert.equal(model.barLabel(true, false, true, false, true, '95%', 'cld'), '󰚩  cld 95%');
// An entry with no headline still names its provider.
assert.equal(model.barLabel(false, false, true, false, true, '', 'agy'), '󰚩  agy');
// A vertical bar has no width for either field.
assert.equal(model.barLabel(false, true, true, false, true, '29%', 'gpt'), '󰚩');
// Before the first report there is no provider to name.
assert.equal(model.barLabel(false, false, true, true, false, '', 'gpt'), '󰚩  …');
assert.equal(model.barLabel(true, false, true, false, false, '', 'gpt'), '󰅙');
// A tag that sanitizes down to nothing degrades to the label without one.
assert.equal(model.barLabel(false, false, true, false, true, '29%', '   '), '󰚩  29%');
assert.equal(model.barLabel(false, false, true, false, true, '29%', undefined), '󰚩  29%');
assert.equal(model.barLabel(false, false, true, false, true, '100%', '', '󱢆'), '󱢆  100%');

assert.equal(model.brandIconFile({id: 'anthropic'}), 'claude.svg');
assert.equal(model.brandIconFile({id: 'anthropic@work'}), 'claude.svg');
assert.equal(model.brandIconFile({id: 'openai'}), 'openai.svg');
assert.equal(model.brandIconFile({id: 'supergrok'}), 'grok.svg');
assert.equal(model.brandIconFile({id: 'grokbot'}), 'grokbot.svg');
assert.equal(model.brandIconFile({id: 'copilot'}), 'copilot.svg');
assert.equal(model.brandIconFile({id: 'kimi'}), 'kimi.svg');
assert.equal(model.brandIconFile({id: 'opencode-go'}), 'opencode.svg');
assert.equal(model.brandIconFile({id: 'commandcode'}), '');
assert.equal(model.brandIconFile({id: 'anthropic_api'}), 'anthropic.svg');
assert.equal(model.brandIconFile({id: 'grok'}), model.brandIconFile({id: 'supergrok'}));
assert.notEqual(model.brandIconFile({id: 'grokbot'}), model.brandIconFile({id: 'grok'}));

// A custom provider carries no built-in slug, so the mark comes from the
// `brand` the report relays. A second key for the same service is the same
// product and must not read as a different one.
assert.equal(model.brandIconFile({id: 'custom:oc-second', brand: 'opencode-go'}), 'opencode.svg');
assert.equal(model.brandIconFile({id: 'custom:oc-second'}), '');
// A brand the artwork does not cover degrades to the nerd-font tag rather
// than to a blank mark, and so does an older binary's report.
assert.equal(model.brandIconFile({id: 'custom:oc-second', brand: 'commandcode'}), '');
assert.equal(model.brandIconFile({id: 'anthropic', brand: undefined}), 'claude.svg');
// `brand` wins over the id: that is the whole point of declaring it.
assert.equal(model.brandIconFile({id: 'anthropic', brand: 'openai'}), 'openai.svg');

const slugs = [
  'anthropic', 'anthropic_api', 'openai', 'copilot', 'zai', 'openrouter',
  'deepseek', 'kimi', 'kilo', 'novita', 'moonshot', 'grok', 'supergrok', 'grokbot',
  'antigravity', 'cursor', 'minimax', 'kiro', 'nous', 'opencode-go', 'commandcode'
];
const byMark = {};
for (const slug of slugs) {
  const mark = model.brandIconFile({id: slug}) || slug;
  byMark[mark] = (byMark[mark] || []).concat(slug);
}
const sharedMarks = Object.entries(byMark).filter(([, vendors]) =>
  vendors.length > 1 && vendors.join() !== 'grok,supergrok');
assert.deepEqual(sharedMarks, []);
for (const slug of slugs) {
  const file = model.brandIconFile({id: slug});
  if (file) assert.ok(fs.existsSync(new URL('./icons/' + file, import.meta.url)), file);
}

const claudeChip = parsed.entries[0];
claudeChip.icon = '󰚩';
const openaiChip = parsed.entries[1];
openaiChip.icon = '󱢆';
const strip = model.barChips([claudeChip, openaiChip], openaiChip, true, true, false, false, false, false);
assert.equal(strip.length, 2);
assert.equal(strip[0].brand, 'claude.svg');
assert.equal(strip[1].brand, 'openai.svg');
assert.equal(strip[0].label, '29%');
assert.equal(strip[1].label, '95%');
const one = model.barChips([claudeChip, openaiChip], openaiChip, false, true, false, false, false, false);
assert.equal(one.length, 1);
assert.equal(one[0].brand, 'openai.svg');
// Every chip names the entry behind it, in the order the bar draws them; the
// placeholders for a lone, vertical or empty bar have none to offer.
assert.equal(strip.map(chip => chip.id).join(','), 'anthropic@work,openai');
assert.equal(one[0].id, 'openai');
// The bar resolves a slot press against each registered target's own rect, so a
// chip's target is its whole column of the slot: the padding above and below
// the glyph, and half of every gap beside it. Before this, a press on that
// padding fell through to the button and toggled the entry already selected.
// The pair is copied out of the vm realm, whose objects fail a strict compare.
// The outer columns also own the button's edge padding: before, the first and
// last chips stopped at their glyph and a press at either end of the widget
// reached the button.
const chipGaps = (index, count) => {
  const value = model.chipHitGaps(index, count, 10, 8.5);
  return {left: value.left, right: value.right};
};
assert.deepEqual(chipGaps(0, 3), {left: 8.5, right: 5});
assert.deepEqual(chipGaps(1, 3), {left: 5, right: 5});
assert.deepEqual(chipGaps(2, 3), {left: 5, right: 8.5});
assert.deepEqual(chipGaps(0, 2), {left: 8.5, right: 5});
assert.deepEqual(chipGaps(1, 2), {left: 5, right: 8.5});
// A lone chip is not a target, but it still carries the edge padding the
// button's width no longer adds.
assert.deepEqual(chipGaps(0, 1), {left: 8.5, right: 8.5});
// Two half-gaps replace each plain spacing and the edges move inside the outer
// columns, so the columns add up to the widget's old padded width.
assert.equal([0, 1, 2].map(index => {
  const gaps = chipGaps(index, 3);
  return 40 + gaps.left + gaps.right;
}).reduce((sum, width) => sum + width, 0), 3 * 40 + 2 * 10 + 17);
assert.equal(40 + chipGaps(0, 1).left + chipGaps(0, 1).right, 40 + 17);
assert.equal(model.barChips([], null, false, true, false, false, true, false)[0].id, undefined);
assert.equal(model.barChips([], null, false, true, false, false, true, true)[0].id, undefined);
assert.equal(model.barStrip([claudeChip, openaiChip], false, false, true, false, false), '󰚩  29%  󱢆  95%');

// The codes come from Rust's VendorId::short_name via the report; the vendor
// half of the machine id only stands in for a binary that predates the field.
assert.equal(model.providerShort(parsed.entries[0]), 'cld');
assert.equal(model.providerShort(parsed.entries[1]), 'gpt');
assert.equal(model.providerShort({id: 'anthropic@work'}), 'anthropic');
assert.equal(model.providerShort({id: 'anthropic_api'}), 'anthropic-api');
assert.equal(model.providerShort({id: 'zai', short_name: '   '}), 'zai');
assert.equal(model.providerShort(null), '');
// Provider-controlled text can never reach Text.AutoText as markup.
assert.equal(model.providerShort({id: 'x', short_name: '<b>x</b>'}), '‹b›x‹/b›');

assert.equal(model.headline(parsed.entries[0]).text, '29%');
assert.equal(model.headline(parsed.entries[1]).severity, 'critical');
assert.equal(model.isAlarming(parsed.entries[0]), false); // cached, below critical
assert.equal(model.barChips(parsed.entries, parsed.entries[0], false, true, false, false, false, false)[0].alarming, false);
const failed = model.parseReport(JSON.stringify({entries: [{id: 'openai', status: 'error', error: 'Unavailable', sections: []}]})).entries[0];
assert.equal(model.isAlarming(failed), false);
assert.equal(model.barChips([failed], failed, false, true, false, false, false, false)[0].alarming, false);
assert.equal(model.isAlarming(parsed.entries[1]), true); // critical usage still alerts
// Reset-row fixtures are built from *local* calendar components, not UTC
// strings, so every expectation below is a literal that holds in any
// timezone the panel might run in. Deriving the expected clock from the same
// getHours()/getMinutes() expression the implementation uses would pass no
// matter what that expression did.
const localReset = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).toISOString();
const at = (y, mo, d, h, mi) => Date.parse(new Date(y, mo - 1, d, h, mi).toISOString());

// Same local day: the clock alone is unambiguous.
assert.equal(model.formatReset(localReset(2026, 8, 14, 22, 0), at(2026, 8, 14, 8, 0)),
  'Resets in 14h 0m · 22:00');
// Both fields zero-padded.
assert.equal(model.formatReset(localReset(2026, 8, 14, 9, 5), at(2026, 8, 14, 8, 0)),
  'Resets in 1h 5m · 09:05');
// Under 24h but past midnight: the date is what stops "03:00" reading as a
// time that already went by this morning.
assert.equal(model.formatReset(localReset(2026, 8, 15, 3, 0), at(2026, 8, 14, 20, 0)),
  'Resets in 7h 0m · Aug 15 03:00');
// Long windows carry the date too.
assert.equal(model.formatReset(localReset(2026, 9, 14, 14, 30), at(2026, 8, 14, 12, 0)),
  'Resets in 31d 2h · Sep 14 14:30');
// Day-of-month is not padded, matching the rest of the row's typography.
assert.equal(model.formatReset(localReset(2026, 9, 5, 14, 0), at(2026, 8, 14, 12, 0)),
  'Resets in 22d 2h · Sep 5 14:00');
assert.equal(model.formatReset('2026-08-14T12:00:00Z', Date.parse('2026-08-14T12:00:00Z')), 'Reset due');
assert.equal(model.formatReset('', Date.parse('2026-08-14T12:00:00Z')), '');
assert.equal(model.formatReset('not-a-date', Date.parse('2026-08-14T12:00:00Z')), '');

// Theme palette: named Omarchy keys win over color1–3 aliases (#289 / #292).
const namedWins = model.parseThemePalette([
  'color1 = "#111111"',
  'red = "#f7768e"',
  'color2 = "#222222"',
  'green = "#9ece6a"',
  'color3 = "#333333"',
  'yellow = "#e0af68"',
  'orange = "#eb927b"',
].join('\n'));
assert.equal(namedWins.red, '#f7768e');
assert.equal(namedWins.green, '#9ece6a');
assert.equal(namedWins.yellow, '#e0af68');
assert.equal(namedWins.orange, '#eb927b');
const aliasOnly = model.parseThemePalette([
  'color1 = "#aa1111"',
  'color2 = "#11aa11"',
  'color3 = "#1111aa"',
].join('\n'));
assert.equal(aliasOnly.red, '#aa1111');
assert.equal(aliasOnly.green, '#11aa11');
assert.equal(aliasOnly.yellow, '#1111aa');
assert.equal(aliasOnly.orange, '#aa1111'); // orange falls back to resolved red
const reversedOrder = model.parseThemePalette([
  'red = "#f7768e"',
  'color1 = "#111111"',
].join('\n'));
assert.equal(reversedOrder.red, '#f7768e');

// severityColor maps the report contract onto the theme palette.
const palette = { green: '#g', yellow: '#y', orange: '#o', red: '#r' };
assert.equal(model.severityColor('low', palette), '#g');
assert.equal(model.severityColor('mid', palette), '#y');
assert.equal(model.severityColor('high', palette), '#o');
assert.equal(model.severityColor('critical', palette), '#r');
assert.equal(model.severityColor('', palette), '#g');
assert.equal(model.formatUpdated('2026-08-14T12:00:00Z', Date.parse('2026-08-14T12:03:00Z')), 'Updated 3m ago');
assert.equal(model.metricDetail(parsed.entries[0].sections[1]), '60% elapsed · 31pts under');

// Grouped sub-rows (SuperGrok's product slices) gain one heading row per
// group and pass everything else through untouched.
const supergrokSections = model.parseReport(JSON.stringify({entries: [{
  id: 'supergrok', error: null,
  sections: [
    {type: 'spacer'},
    {type: 'metric', label: 'Weekly usage', percent: 97, value: '97%', detail: '',
     severity: 'critical', reset_at: '2026-09-20T13:26:44Z', window_secs: 604800},
    {type: 'metric', label: 'Grok Build', percent: 94, value: '94%', detail: '',
     severity: 'low', group: 'Breakdown'},
    {type: 'metric', label: 'Grok Chat', percent: 3, value: '3%', detail: '',
     severity: 'low', group: 'Breakdown'},
    {type: 'text', label: 'Prepaid API', value: '$4.22'}
  ]
}]})).entries[0].sections;
assert.equal(supergrokSections[1].group, '');
assert.equal(supergrokSections[2].group, 'Breakdown');
// Array.from/JSON round-trips bridge the vm realm, like every other
// shape assertion in this file.
assert.deepEqual(Array.from(model.groupedSections(supergrokSections)).map(row => {
  if (row.type === 'spacer') return 'spacer';
  if (row.type === 'text' && row.value === '') return 'heading:' + row.label;
  return row.label;
}), [
  'spacer',
  'Weekly usage',      // ungrouped metric: no heading inserted
  'heading:Breakdown', // one heading before the group's first row…
  'Grok Build',
  'Grok Chat',         // …never a second one for the same group
  'Prepaid API'
]);
assert.equal(model.groupedSections(supergrokSections).filter(row =>
  row.type === 'metric' && row.group === 'Breakdown').length, 2);
assert.deepEqual(JSON.parse(JSON.stringify(model.groupedSections([{type: 'spacer'}]))),
  [{type: 'spacer'}]);
assert.equal(model.groupedSections(null).length, 0);
assert.equal(model.groupedSections('not-sections').length, 0);

// #255: the Claude entry's CLI-session rows arrive the same way — grouped
// metrics — so the panel draws them under one "Sessions" heading beneath the
// quota meters, with the health severity the report assigned.
const claudeSections = model.parseReport(JSON.stringify({entries: [{
  id: 'anthropic', error: null,
  sections: [
    {type: 'metric', label: 'Session (5h)', percent: 29, value: '29%', detail: '',
     severity: 'low', reset_at: '2026-09-25T14:20:00Z', window_secs: 18000},
    {type: 'metric', label: 'ship the release', percent: 90, value: '90%',
     detail: '180,000 / 200,000 tokens · claude-test · last active 12:34:56',
     severity: 'critical', group: 'Sessions'},
    {type: 'metric', label: 'sketch ideas', percent: 0, value: 'compacted',
     detail: 'compacted · waiting for the next response', severity: 'low', group: 'Sessions'},
    {type: 'text', label: '', value: '… and 4 more sessions'}
  ]
}]})).entries[0].sections;
assert.deepEqual(Array.from(model.groupedSections(claudeSections)).map(row => {
  if (row.type === 'text' && row.value === '') return 'heading:' + row.label;
  return row.type + ':' + row.label;
}), [
  'metric:Session (5h)',
  'heading:Sessions',
  'metric:ship the release',
  'metric:sketch ideas',
  'text:'                       // the overflow note is not a heading
]);
const sessionRow = model.groupedSections(claudeSections).find(row =>
  row.type === 'metric' && row.group === 'Sessions');
assert.equal(sessionRow.severity, 'critical');
assert.equal(sessionRow.value, '90%');

const balance = model.parseReport(JSON.stringify({entries: [{
  id: 'deepseek', error: null,
  sections: [{type: 'text', label: 'Balance', value: '$8.42'}]
}]})).entries[0];
assert.equal(model.headline(balance).text, '$8.42');
// The metric names its own headline; the label plays no part. A metric that
// says nothing is a percentage, which is what OpenRouter's "Credit balance" row
// is — the old label check put its dollar figure on the bar and hid the percent.
const metered = (headline) => model.parseReport(JSON.stringify({entries: [{
  id: 'openrouter', error: null,
  sections: [Object.assign(
    {type: 'metric', label: 'Credit balance', percent: 25, value: '$75.00', detail: ''},
    headline === undefined ? {} : {headline: headline})]
}]})).entries[0];
assert.equal(model.headline(metered(undefined)).text, '25%');
assert.equal(model.headline(metered('percent')).text, '25%');
assert.equal(model.headline(metered('value')).text, '$75.00');
// An unrecognized word is not a licence to invent a third rendering.
assert.equal(model.headline(metered('dollars')).text, '25%');
// A "value" headline with nothing to show falls back rather than blanking.
const emptyValue = model.parseReport(JSON.stringify({entries: [{
  id: 'deepseek', error: null,
  sections: [{type: 'metric', label: 'Balance', percent: 60, value: '',
              detail: '', headline: 'value'}]
}]})).entries[0];
assert.equal(model.headline(emptyValue).text, '60%');
// A percent headline on a row whose label says "balance" is drawn as a percent.
const meteredTank = model.parseReport(JSON.stringify({entries: [{
  id: 'deepseek', error: null,
  sections: [{type: 'metric', label: 'Balance', percent: 75, value: '$50.00',
              detail: '$50.00 of $200.00 left (75% used)', headline: 'percent'}]
}]})).entries[0];
assert.equal(model.headline(meteredTank).text, '75%');
assert.equal(model.headline(meteredTank).percent, 75);

assert.equal(model.parseReport('{').ok, false);
assert.equal(model.parseReport('{}').ok, false);
assert.equal(model.parseReport('{"entries":[{"name":"missing id"}]}').ok, false);
assert.equal(model.cleanText('bad\u0000value', 20), 'badvalue');
assert.equal(model.cleanText('tab\tcarriage\rC1\u0085value', 40), 'tab carriage C1value');
assert.equal(model.cleanText('😀😀', 3), '😀…');
assert.equal(model.autoTextSafe('<img src="https://example.test/pixel">'),
  '‹img src="https://example.test/pixel"›');
assert.equal(model.autoTextSafe('line\nspoof\u202eright-to-left'), 'line spoofright-to-left');
assert.equal(model.providerName({id: 'anthropic', display_name: 'Claude · <b>work</b>'}),
  'Claude · ‹b›work‹/b›');
assert.equal(model.providerName({id: 'openai', name: 'openai'}), 'openai');
assert.equal(model.errorMessage(''), 'The usage command failed without an error message.');

// A missing ai-usagebar binary must be reported as such, with the install
// command, instead of surfacing the helper's raw "not found" text or leaving
// the widget silently stuck on its loading state.
assert.match(model.launchErrorMessage(127, 'env: ai-usagebar: No such file or directory'),
  /ai-usagebar is not installed/);
assert.match(model.launchErrorMessage(127, ''), /omarchy pkg aur add ai-usagebar-bin/);
// Every other failure keeps the existing behaviour.
assert.equal(model.launchErrorMessage(1, 'boom'), 'boom');
assert.equal(model.launchErrorMessage(0, ''), 'The usage command failed without an error message.');

// The usage command must stay behind a helper that can emit exit 127 when the
// binary is absent, without opening a shell-injection boundary.
assert.match(panelSource,
  /command:\s*\["\/usr\/bin\/env",\s*"ai-usagebar",\s*"usage",\s*"--json"\]/);
assert.doesNotMatch(panelSource, /command:\s*\["(?:\/usr\/bin\/)?(?:ba)?sh"/);
assert.match(panelSource, /onExited:\s*function\(exitCode\)/);
assert.match(panelSource, /Model\.launchErrorMessage\(/);

const settingsRaw = JSON.stringify({
  schema_version: 1,
  primary: 'openai',
  primary_choices: [
    {id: 'anthropic', label: 'Claude'},
    {id: 'openai', label: 'Codex'}
  ],
  keys: [
    {id: 'kimi', label: 'Kimi', environment: 'KIMI_API_KEY', note: 'coding-plan usage',
     configured: true, inline_configured: true, environment_configured: false}
  ]
});
const settings = model.parseSettingsSnapshot(settingsRaw);
assert.equal(settings.ok, true);
assert.equal(settings.primary, 'openai');
assert.equal(settings.primary_choices[0].id, 'anthropic');
assert.equal(settings.primary_choices[0].value, 'anthropic');
assert.equal(settings.primary_choices[0].label, 'Claude');
assert.equal(settings.primary_choices[1].label, 'Codex');
assert.equal(settings.keys[0].inline_configured, true);
assert.equal(settings.keys[0].environment, 'KIMI_API_KEY');
const opencodeSettings = model.parseSettingsSnapshot(JSON.stringify({
  schema_version: 1,
  primary: 'opencode-go',
  primary_choices: [{id: 'opencode-go', label: 'OpenCode Go'}],
  keys: [{id: 'opencode-go', label: 'OpenCode Go', environment: 'OPENCODE_GO_API_KEY',
    note: 'usage quota', configured: false, inline_configured: false, environment_configured: false}]
}));
assert.equal(opencodeSettings.ok, true);
assert.equal(opencodeSettings.primary, 'opencode-go');
assert.equal(opencodeSettings.keys[0].id, 'opencode-go');
assert.equal(opencodeSettings.keys[0].environment, 'OPENCODE_GO_API_KEY');
assert.equal(model.parseSettingsSnapshot('{').ok, false);
assert.equal(model.parseSettingsSnapshot(JSON.stringify({schema_version: 2, primary_choices: [], keys: []})).ok, false);
const noEnabled = model.parseSettingsSnapshot(JSON.stringify({
  schema_version: 1, primary: 'anthropic', primary_choices: [], keys: []
}));
assert.equal(noEnabled.ok, true);
assert.equal(noEnabled.primary, '');
const copilotPrimary = model.parseSettingsSnapshot(JSON.stringify({
  schema_version: 1, primary: 'anthropic',
  primary_choices: [{id: 'anthropic', label: 'Claude'}, {id: 'copilot', label: 'GitHub Copilot'}],
  keys: []
}));
assert.equal(copilotPrimary.ok, true);
assert.equal(copilotPrimary.primary_choices[1].id, 'copilot');
assert.equal(copilotPrimary.keys.some(key => key.id === 'copilot'), false);

const patch = model.buildSettingsPatch('openai', [
  {id: 'kimi', action: 'set', value: 'secret-value'},
  {id: 'zai', action: 'clear'}
]);
assert.equal(patch.ok, true);
assert.deepEqual(JSON.parse(patch.payload), {
  schema_version: 1,
  primary: 'openai',
  keys: {
    kimi: {action: 'set', value: 'secret-value'},
    zai: {action: 'clear'}
  }
});
const keyOnlyPatch = model.buildSettingsPatch('', [{id: 'kimi', action: 'clear'}]);
assert.deepEqual(JSON.parse(keyOnlyPatch.payload), {
  schema_version: 1, keys: {kimi: {action: 'clear'}}
});
assert.equal(model.buildSettingsPatch('', []).ok, false);
assert.equal(model.buildSettingsPatch('openai', [{id: '__proto__', action: 'clear'}]).ok, false);
assert.equal(model.buildSettingsPatch('openai', [{id: 'kimi', action: 'set', value: ''}]).ok, false);
assert.equal(model.buildSettingsPatch('openai', [{id: 'kimi', action: 'bogus'}]).ok, false);
assert.equal(model.parseSettingsApplyResult('{"ok":true}'), true);
assert.equal(model.parseSettingsApplyResult('{"ok":false}'), false);

// Provider on/off switches (#244): the snapshot carries every provider's
// enabled state, an older binary's vendor-less snapshot still parses, and the
// patch gains `vendors` only when a toggle is pending.
const vendorsRaw = JSON.stringify({
  schema_version: 1, primary: 'anthropic',
  primary_choices: [{id: 'anthropic', label: 'Claude'}],
  keys: [],
  vendors: [
    {id: 'anthropic', label: 'Claude', enabled: true},
    {id: 'grok', label: 'Grok', enabled: false},
    {id: 'opencode-go', label: 'OpenCode Go', enabled: true},
    {id: '__proto__', label: 'never', enabled: true},
    {id: 'kimi', label: 'Kimi', enabled: 'yes'}
  ]
});
const vendorSnapshot = model.parseSettingsSnapshot(vendorsRaw);
assert.equal(vendorSnapshot.ok, true);
assert.equal(vendorSnapshot.vendors.length, 4);
assert.equal(vendorSnapshot.vendors[0].id, 'anthropic');
assert.equal(vendorSnapshot.vendors[0].enabled, true);
assert.equal(vendorSnapshot.vendors[1].id, 'grok');
assert.equal(vendorSnapshot.vendors[1].enabled, false);
assert.equal(vendorSnapshot.vendors[2].label, 'OpenCode Go');
// A non-boolean enabled is treated as off, never coerced from a string.
assert.equal(vendorSnapshot.vendors[3].enabled, false);
const noVendors = model.parseSettingsSnapshot(JSON.stringify({
  schema_version: 1, primary: 'anthropic',
  primary_choices: [{id: 'anthropic', label: 'Claude'}], keys: []
}));
assert.equal(noVendors.ok, true);
assert.equal(noVendors.vendors.length, 0);

const togglePatch = model.buildSettingsPatch('', [], [
  {id: 'grok', enabled: true},
  {id: 'zai', enabled: false}
]);
assert.equal(togglePatch.ok, true);
assert.deepEqual(JSON.parse(togglePatch.payload), {
  schema_version: 1, keys: {}, vendors: {grok: true, zai: false}
});
// A save with no pending toggle omits `vendors`, so an older binary still
// accepts a display-only patch (its ApplyRequest denies unknown fields).
const noTogglePatch = model.buildSettingsPatch('anthropic', []);
assert.deepEqual(JSON.parse(noTogglePatch.payload), {
  schema_version: 1, primary: 'anthropic', keys: {}
});
assert.equal(model.buildSettingsPatch('', [{id: 'kimi', action: 'clear'}], undefined).ok, true);
assert.equal(model.buildSettingsPatch('', [], [{id: '__proto__', enabled: true}]).ok, false);
assert.equal(model.buildSettingsPatch('', [], [{id: 'grok'}, {id: 'grok', enabled: true}]).ok, false);
assert.equal(model.buildSettingsPatch('', [], [{id: 'grok', enabled: true}, {id: 'grok', enabled: false}]).ok, false);
assert.equal(model.buildSettingsPatch('', [], [{id: 'grok', enabled: 'on'}]).ok, false);
assert.equal(model.buildSettingsPatch('', [], []).ok, false);

// Top bar window pinning: auto keeps history, session/weekly/monthly pin one
// window class, unknown pins fall back to highest instead of blanking.
assert.equal(model.normalizeBarWindow('auto'), 'auto');
assert.equal(model.normalizeBarWindow(''), 'auto');
assert.equal(model.normalizeBarWindow('  Session '), 'session');
assert.equal(model.normalizeBarWindow('5h'), 'session');
assert.equal(model.normalizeBarWindow('rolling'), 'session');
assert.equal(model.normalizeBarWindow('WEEKLY'), 'weekly');
assert.equal(model.normalizeBarWindow('7d'), 'weekly');
assert.equal(model.normalizeBarWindow('Monthly'), 'monthly');
assert.equal(model.normalizeBarWindow('bogus'), 'auto');
assert.equal(model.normalizeBarWindow(undefined), 'auto');

const twoWindow = model.parseReport(JSON.stringify({entries: [{
  id: 'openai', error: null,
  sections: [
    {type: 'metric', label: 'Codex 5h', percent: 44, value: '44%', detail: '', severity: 'low', window_secs: 18000},
    {type: 'metric', label: 'Codex weekly', percent: 59, value: '59%', detail: '', severity: 'mid', window_secs: 604800}
  ]
}]})).entries[0];
assert.equal(twoWindow.sections[0].window_secs, 18000);
assert.equal(twoWindow.sections[1].window_secs, 604800);
assert.equal(model.headline(twoWindow).text, '59%');
assert.equal(model.headline(twoWindow, 'auto').text, '59%');
assert.equal(model.headline(twoWindow, 'session').text, '44%');
assert.equal(model.headline(twoWindow, 'session').label, 'Codex 5h');
assert.equal(model.headline(twoWindow, 'weekly').text, '59%');
assert.equal(model.headline(twoWindow, 'bogus').text, '59%');
// No monthly pool: falls back to highest rather than blanking.
assert.equal(model.headline(twoWindow, 'monthly').text, '59%');

const threeWindow = model.parseReport(JSON.stringify({entries: [{
  id: 'opencode-go', error: null,
  sections: [
    {type: 'metric', label: 'Rolling (5h)', percent: 0, value: '0%', detail: '', severity: 'low', window_secs: 18000},
    {type: 'metric', label: 'Weekly (7d)', percent: 18, value: '18%', detail: '', severity: 'low', window_secs: 604800},
    {type: 'metric', label: 'Monthly', percent: 81, value: '81%', detail: '', severity: 'high'}
  ]
}]})).entries[0];
assert.equal(threeWindow.sections[2].window_secs, null);
assert.equal(model.headline(threeWindow).text, '81%');
assert.equal(model.headline(threeWindow, 'session').text, '0%');
assert.equal(model.headline(threeWindow, 'weekly').text, '18%');
assert.equal(model.headline(threeWindow, 'monthly').text, '81%');
// Label-only match when the report predates window_secs.
const legacyWeekly = model.parseReport(JSON.stringify({entries: [{
  id: 'openai', error: null,
  sections: [
    {type: 'metric', label: 'Codex 5h', percent: 10, value: '10%', detail: ''},
    {type: 'metric', label: 'Codex weekly', percent: 90, value: '90%', detail: ''}
  ]
}]})).entries[0];
assert.equal(model.headline(legacyWeekly, 'session').text, '10%');
assert.equal(model.headline(legacyWeekly, 'weekly').text, '90%');
// window_secs wins over labels: neutral labels disambiguate by size alone,
// and a present-but-different size overrules a misleading label.
const secsOnly = model.parseReport(JSON.stringify({entries: [{
  id: 'openai', error: null,
  sections: [
    {type: 'metric', label: 'Foo', percent: 44, value: '44%', detail: '', severity: 'low', window_secs: 18000},
    {type: 'metric', label: 'Bar', percent: 59, value: '59%', detail: '', severity: 'mid', window_secs: 604800}
  ]
}]})).entries[0];
assert.equal(model.headline(secsOnly, 'session').text, '44%');
assert.equal(model.headline(secsOnly, 'weekly').text, '59%');
const secsMismatch = model.parseReport(JSON.stringify({entries: [{
  id: 'openai', error: null,
  sections: [
    {type: 'metric', label: 'Codex weekly', percent: 44, value: '44%', detail: '', severity: 'low', window_secs: 18000},
    {type: 'metric', label: 'Codex 5h', percent: 59, value: '59%', detail: '', severity: 'mid', window_secs: 604800}
  ]
}]})).entries[0];
assert.equal(model.headline(secsMismatch, 'session').text, '44%');
assert.equal(model.headline(secsMismatch, 'weekly').text, '59%');
// Weekly-only response: a session pin falls back to highest.
const weeklyOnly = model.parseReport(JSON.stringify({entries: [{
  id: 'openai', error: null,
  sections: [
    {type: 'metric', label: 'Codex weekly', percent: 77, value: '77%', detail: '', severity: 'high', window_secs: 604800}
  ]
}]})).entries[0];
assert.equal(model.headline(weeklyOnly, 'session').text, '77%');
// Abbreviated monthly spend label matches the monthly pin.
const spendMo = model.parseReport(JSON.stringify({entries: [{
  id: 'anthropic_api', error: null,
  sections: [
    {type: 'metric', label: 'Spend (mo)', percent: 12, value: '$1.34 / $1000', detail: '', severity: 'low'}
  ]
}]})).entries[0];
assert.equal(model.headline(spendMo, 'monthly').text, '12%');
// Balance-only vendors ignore the pin and keep showing the balance.
assert.equal(model.headline(balance, 'session').text, '$8.42');
// Alert state always follows the highest-percent window, never the pin;
// the pin covers the bar value plus its hero/tooltip echoes.
assert.equal(model.isAlarming(twoWindow), false);
assert.equal(model.headline(legacyWeekly, 'weekly').severity, 'critical');
assert.equal(model.isAlarming(legacyWeekly), true);
const pinnedChips = model.barChips([twoWindow, threeWindow], twoWindow, true, true, false, false, false, false, 'session');
assert.deepEqual(Array.from(pinnedChips.map(chip => chip.label)), ['44%', '0%']);
assert.equal(model.barStrip([twoWindow, threeWindow], false, false, true, false, false, 'weekly'), '󰚩  59%  󰚩  18%');
// Scoped 7-day pools carry window_secs, so the weekly pin selects them
// (max among weekly candidates, not first).
const scopedWeekly = model.parseReport(JSON.stringify({entries: [{
  id: 'anthropic', error: null,
  sections: [
    {type: 'metric', label: 'Weekly (7d)', percent: 30, value: '30%', detail: '', severity: 'low', window_secs: 604800},
    {type: 'metric', label: 'Fable (7d)', percent: 88, value: '88%', detail: '', severity: 'high', window_secs: 604800}
  ]
}]})).entries[0];
assert.equal(model.headline(scopedWeekly, 'weekly').text, '88%');
// Cursor's two pools are model categories, so the bar shows both side by
// side no matter which time window is pinned. Left is Cursor Models.
const cursorLike = model.parseReport(JSON.stringify({entries: [{
  id: 'cursor', error: null, icon: '❯',
  sections: [
    {type: 'metric', label: 'Cursor Models', percent: 80, value: '80%', detail: '', severity: 'high'},
    {type: 'metric', label: 'Other Models', percent: 20, value: '20%', detail: '', severity: 'low'}
  ]
}]})).entries[0];
assert.equal(model.headline(cursorLike, 'weekly').text, '80% · 20%');
assert.equal(model.headline(cursorLike, 'session').text, '80% · 20%');
assert.equal(model.headline(cursorLike, 'auto').text, '80% · 20%');
assert.equal(model.headline(cursorLike).severity, 'high');
assert.equal(model.headline(cursorLike).percent, 80);
assert.equal(model.headline(cursorLike).tooltip, 'Cursor Models · 80%\nCursor Other Models · 20%');
assert.equal(model.isAlarming(cursorLike), false);
assert.equal(model.barChips([cursorLike], cursorLike, true, true, false, false, false, false)[0].label, '80% · 20%');
assert.equal(model.barChips([cursorLike], cursorLike, true, true, false, false, false, false)[0].brand, 'cursor.svg');
assert.equal(model.barStrip([cursorLike], false, false, true, false, false), '❯  80% · 20%');
const cursorNamed = model.parseReport(JSON.stringify({entries: [{
  id: 'cursor@work', error: null,
  sections: [
    {type: 'metric', label: 'Cursor Models', percent: 35, value: '35%', detail: '', severity: 'low'},
    {type: 'metric', label: 'Other Models', percent: 7, value: '7%', detail: '', severity: 'low'}
  ]
}]})).entries[0];
assert.equal(model.headline(cursorNamed).text, '35% · 7%');
const cursorPrepaid = model.parseReport(JSON.stringify({entries: [{
  id: 'cursor', error: null,
  sections: [
    {type: 'metric', label: 'Cursor Models', percent: 35, value: '35%', detail: '', severity: 'low'},
    {type: 'metric', label: 'Other Models', percent: 7, value: '7%', detail: '', severity: 'low'},
    {type: 'text', label: 'On-Demand', value: '$0.00 / $5.00'}
  ]
}]})).entries[0];
assert.equal(model.headline(cursorPrepaid).text, '35% · 7% · 0%');
assert.equal(model.headline(cursorPrepaid).tooltip, 'Cursor Models · 35%\nCursor Other Models · 7%\nCursor On Demand · 0%');
assert.equal(model.headline(cursorPrepaid).severity, 'low');
const prepaidRow = model.groupedSections(cursorPrepaid.sections).filter(row => row.label === 'On-Demand')[0];
assert.equal(prepaidRow.type, 'metric');
assert.equal(prepaidRow.percent, 0);
assert.equal(prepaidRow.value, '$5.00');
assert.equal(prepaidRow.detail, '$0.00 of $5.00 used (0%)');
const cursorSpent = model.parseReport(JSON.stringify({entries: [{
  id: 'cursor', error: null,
  sections: [
    {type: 'metric', label: 'Cursor Models', percent: 35, value: '35%', detail: '', severity: 'low'},
    {type: 'metric', label: 'Other Models', percent: 7, value: '7%', detail: '', severity: 'low'},
    {type: 'text', label: 'On-Demand', value: '$1.25 / $5.00'}
  ]
}]})).entries[0];
assert.equal(model.headline(cursorSpent).text, '35% · 7% · 25%');
assert.equal(model.groupedSections(cursorSpent.sections).filter(row => row.label === 'On-Demand')[0].value, '$3.75');
assert.equal(model.groupedSections(cursorSpent.sections).filter(row => row.label === 'On-Demand')[0].percent, 25);
const cursorDemandHot = model.parseReport(JSON.stringify({entries: [{
  id: 'cursor', error: null,
  sections: [
    {type: 'metric', label: 'Cursor Models', percent: 10, value: '10%', detail: '', severity: 'low'},
    {type: 'metric', label: 'Other Models', percent: 7, value: '7%', detail: '', severity: 'low'},
    {type: 'text', label: 'On-Demand', value: '$4.80 / $5.00'}
  ]
}]})).entries[0];
assert.equal(model.headline(cursorDemandHot).text, '10% · 7% · 96%');
assert.equal(model.headline(cursorDemandHot).severity, 'critical');
assert.equal(model.isAlarming(cursorDemandHot), true);
// The report's cents win over the formatted value, including a value that
// is not money at all. Percent comes from the row; dollars left come from
// the cents.
const cursorNumeric = model.parseReport(JSON.stringify({entries: [{
  id: 'cursor', error: null,
  sections: [
    {type: 'metric', label: 'Cursor Models', percent: 35, value: '35%', detail: '', severity: 'low'},
    {type: 'metric', label: 'Other Models', percent: 7, value: '7%', detail: '', severity: 'low'},
    {type: 'text', label: 'On-Demand', value: 'not money', used_cents: 125, limit_cents: 500, percent: 25}
  ]
}]})).entries[0];
assert.equal(model.headline(cursorNumeric).text, '35% · 7% · 25%');
const numericRow = model.groupedSections(cursorNumeric.sections).filter(row => row.label === 'On-Demand')[0];
assert.equal(numericRow.value, '$3.75');
assert.equal(numericRow.percent, 25);
assert.equal(numericRow.detail, '$1.25 of $5.00 used (25%)');
const cursorContradicts = model.parseReport(JSON.stringify({entries: [{
  id: 'cursor', error: null,
  sections: [
    {type: 'metric', label: 'Cursor Models', percent: 35, value: '35%', detail: '', severity: 'low'},
    {type: 'metric', label: 'Other Models', percent: 7, value: '7%', detail: '', severity: 'low'},
    {type: 'text', label: 'On-Demand', value: '$9.00 / $10.00', used_cents: 0, limit_cents: 500, percent: 0}
  ]
}]})).entries[0];
assert.equal(model.headline(cursorContradicts).text, '35% · 7% · 0%');
assert.equal(model.groupedSections(cursorContradicts.sections).filter(row => row.label === 'On-Demand')[0].value, '$5.00');
// Cents without a percent still meter. A fractional cent is not minor units
// and falls back to the formatted value.
const cursorCentsOnly = model.parseReport(JSON.stringify({entries: [{
  id: 'cursor', error: null,
  sections: [
    {type: 'metric', label: 'Cursor Models', percent: 10, value: '10%', detail: '', severity: 'low'},
    {type: 'metric', label: 'Other Models', percent: 7, value: '7%', detail: '', severity: 'low'},
    {type: 'text', label: 'On-Demand', value: 'not money', used_cents: 480, limit_cents: 500}
  ]
}]})).entries[0];
assert.equal(model.headline(cursorCentsOnly).text, '10% · 7% · 96%');
const cursorFractional = model.parseReport(JSON.stringify({entries: [{
  id: 'cursor', error: null,
  sections: [
    {type: 'metric', label: 'Cursor Models', percent: 10, value: '10%', detail: '', severity: 'low'},
    {type: 'metric', label: 'Other Models', percent: 7, value: '7%', detail: '', severity: 'low'},
    {type: 'text', label: 'On-Demand', value: '$4.80 / $5.00', used_cents: 480.5, limit_cents: 500, percent: 96}
  ]
}]})).entries[0];
assert.equal(model.headline(cursorFractional).text, '10% · 7% · 96%');
assert.equal(model.groupedSections(cursorFractional.sections).filter(row => row.label === 'On-Demand')[0].value, '$0.20');
const cursorOver = model.parseReport(JSON.stringify({entries: [{
  id: 'cursor', error: null,
  sections: [
    {type: 'metric', label: 'Cursor Models', percent: 10, value: '10%', detail: '', severity: 'low'},
    {type: 'metric', label: 'Other Models', percent: 7, value: '7%', detail: '', severity: 'low'},
    {type: 'text', label: 'On-Demand', value: 'not money', used_cents: 600, limit_cents: 500, percent: 120}
  ]
}]})).entries[0];
assert.equal(model.headline(cursorOver).text, '10% · 7% · 120%');
assert.equal(model.headline(cursorOver).severity, 'critical');
assert.equal(model.groupedSections(cursorOver.sections).filter(row => row.label === 'On-Demand')[0].value, '$0.00');
assert.equal(model.groupedSections(cursorOver.sections).filter(row => row.label === 'On-Demand')[0].detail, '$6.00 of $5.00 used (120%)');
const hideDemand = { models: true, other: true, demand: false };
const hideModels = { models: false, other: true, demand: true };
assert.equal(model.cursorDualHeadline(cursorPrepaid, hideDemand).text, '35% · 7%');
assert.equal(model.cursorDualHeadline(cursorPrepaid, hideDemand).tooltip, 'Cursor Models · 35%\nCursor Other Models · 7%');
assert.equal(model.cursorDualHeadline(cursorPrepaid, hideModels).text, '7% · 0%');
assert.equal(model.cursorDualHeadline(cursorPrepaid, hideModels).tooltip, 'Cursor Other Models · 7%\nCursor On Demand · 0%');
assert.equal(model.cursorDualHeadline(cursorPrepaid, { models: false, other: false, demand: true }).text, '0%');
assert.equal(model.cursorDualHeadline(cursorDemandHot, { models: false, other: false, demand: false }).text, '10%');
assert.equal(model.cursorDualHeadline(cursorDemandHot, { models: true, other: true, demand: false }).severity, 'low');
const viaDemandFirst = model.toggleCursorPool(model.toggleCursorPool({ models: true, other: true, demand: true }, 'demand'), 'models');
const viaModelsFirst = model.toggleCursorPool(model.toggleCursorPool({ models: true, other: true, demand: true }, 'models'), 'demand');
assert.equal(viaDemandFirst.models, viaModelsFirst.models);
assert.equal(viaDemandFirst.other, viaModelsFirst.other);
assert.equal(viaDemandFirst.demand, viaModelsFirst.demand);
assert.equal(viaDemandFirst.models, false);
assert.equal(viaDemandFirst.other, true);
assert.equal(viaDemandFirst.demand, false);
assert.equal(model.cursorDualHeadline(cursorPrepaid, viaDemandFirst).text, '7%');
const keptLast = model.toggleCursorPool({ models: false, other: false, demand: true }, 'demand');
assert.equal(keptLast.models, false);
assert.equal(keptLast.other, false);
assert.equal(keptLast.demand, true);
// On-demand with no prepaid row cannot be the pool that keeps the bar alive.
const demandOnly = { models: false, other: false, demand: true };
assert.equal(model.cursorPoolPresence(cursorLike).demand, false);
assert.equal(model.cursorPoolPresence(cursorPrepaid).demand, true);
assert.equal(model.cursorBarFlags(cursorLike, demandOnly).models, true);
assert.equal(model.cursorBarFlags(cursorLike, demandOnly).demand, false);
assert.equal(model.cursorDualHeadline(cursorLike, demandOnly).text, '80%');
assert.equal(model.cursorDualHeadline(cursorLike, demandOnly).severity, 'high');
// The quieter pool can still be the one that alarms.
const cursorApiHot = model.parseReport(JSON.stringify({entries: [{
  id: 'cursor', error: null,
  sections: [
    {type: 'metric', label: 'Cursor Models', percent: 10, value: '10%', detail: '', severity: 'low'},
    {type: 'metric', label: 'Other Models', percent: 95, value: '95%', detail: '', severity: 'critical'}
  ]
}]})).entries[0];
assert.equal(model.headline(cursorApiHot).text, '10% · 95%');
assert.equal(model.headline(cursorApiHot).severity, 'critical');
assert.equal(model.isAlarming(cursorApiHot), true);
assert.equal(model.cursorDualHeadline(cursorApiHot, { models: true, other: false, demand: false }).severity, 'low');
// One pool, or the same labels on another vendor, stays a single figure.
const cursorOne = model.parseReport(JSON.stringify({entries: [{
  id: 'cursor', error: null,
  sections: [
    {type: 'metric', label: 'Cursor Models', percent: 80, value: '80%', detail: '', severity: 'high'}
  ]
}]})).entries[0];
assert.equal(model.headline(cursorOne).text, '80%');
assert.equal(model.headline(cursorOne).tooltip, undefined);
const cursorLabelsElsewhere = model.parseReport(JSON.stringify({entries: [{
  id: 'custom:cursorish', error: null,
  sections: [
    {type: 'metric', label: 'Cursor Models', percent: 80, value: '80%', detail: '', severity: 'high'},
    {type: 'metric', label: 'Other Models', percent: 20, value: '20%', detail: '', severity: 'low'}
  ]
}]})).entries[0];
assert.equal(model.headline(cursorLabelsElsewhere).text, '80%');
// Buckets without any window shape (Copilot-style) fall back to highest.
const copilotLike = model.parseReport(JSON.stringify({entries: [{
  id: 'copilot', error: null,
  sections: [
    {type: 'metric', label: 'Premium requests', percent: 80, value: '80%', detail: '', severity: 'high'},
    {type: 'metric', label: 'Chat', percent: 20, value: '20%', detail: '', severity: 'low'}
  ]
}]})).entries[0];
assert.equal(model.headline(copilotLike, 'weekly').text, '80%');
assert.equal(model.headline(copilotLike, 'session').text, '80%');
// The exact labels and sizes src/tui/panels.rs emits, not synthetic names:
// Z.AI ships session/weekly plus a 30-day MCP bucket with a monthly label,
// MiniMax names its pools Text/Video and its video session 24h, and SuperGrok
// puts the period in the label with no window size at all.
const zaiReal = model.parseReport(JSON.stringify({entries: [{
  id: 'zai', error: null,
  sections: [
    {type: 'metric', label: 'Session (5h)', percent: 71, value: '71%', detail: '', severity: 'mid', window_secs: 18000},
    {type: 'metric', label: 'Weekly', percent: 12, value: '12%', detail: '', severity: 'low', window_secs: 604800},
    {type: 'metric', label: 'MCP tools (monthly)', percent: 40, value: '40%', detail: '', severity: 'low', window_secs: 2592000}
  ]
}]})).entries[0];
assert.equal(model.headline(zaiReal, 'session').text, '71%');
assert.equal(model.headline(zaiReal, 'weekly').text, '12%');
assert.equal(model.headline(zaiReal, 'monthly').text, '40%');
const minimaxReal = model.parseReport(JSON.stringify({entries: [{
  id: 'minimax', error: null,
  sections: [
    {type: 'metric', label: 'Text', percent: 20, value: '20%', detail: '', severity: 'low', window_secs: 18000},
    {type: 'metric', label: 'Text', percent: 30, value: '30%', detail: '', severity: 'low', window_secs: 604800},
    {type: 'metric', label: 'Video', percent: 90, value: '90%', detail: '', severity: 'critical', window_secs: 86400},
    {type: 'metric', label: 'Video', percent: 50, value: '50%', detail: '', severity: 'mid', window_secs: 604800}
  ]
}]})).entries[0];
assert.equal(model.headline(minimaxReal, 'auto').text, '90%');
assert.equal(model.headline(minimaxReal, 'session').text, '20%');
assert.equal(model.headline(minimaxReal, 'weekly').text, '50%');
assert.equal(model.headline(minimaxReal, 'monthly').text, '90%');
assert.equal(model.isAlarming(minimaxReal), true);
const supergrokReal = model.parseReport(JSON.stringify({entries: [{
  id: 'supergrok', error: null,
  sections: [
    {type: 'metric', label: 'Monthly Build credits', percent: 42, value: '42%', detail: '', severity: 'low'}
  ]
}]})).entries[0];
assert.equal(model.headline(supergrokReal, 'monthly').text, '42%');
assert.equal(model.headline(supergrokReal, 'session').text, '42%');
const divergent = model.parseReport(JSON.stringify({entries: [{
  id: 'openai', error: null,
  sections: [
    {type: 'metric', label: 'Codex 5h', percent: 10, value: '10%', detail: '', severity: 'low', window_secs: 18000},
    {type: 'metric', label: 'Codex weekly', percent: 95, value: '95%', detail: '', severity: 'critical', window_secs: 604800}
  ]
}]})).entries[0];
assert.equal(model.headline(divergent, 'session').text, '10%');
assert.equal(model.headline(divergent, 'session').severity, 'low');
assert.equal(model.isAlarming(divergent), true);
// Chip alert state follows highest, never the pin: pinned low label with a
// critical hidden window still alarms.
const divergentChip = model.barChips([divergent], divergent, false, true, false, false, false, false, 'session')[0];
assert.equal(divergentChip.label, '10%');
assert.equal(divergentChip.alarming, true);
assert.equal(model.normalizeBarWindow('highest'), 'auto');
assert.equal(model.normalizeBarWindow('max'), 'auto');
assert.equal(model.normalizeBarWindow('shortest'), 'session');
assert.equal(model.normalizeBarWindow('session-5h'), 'session');
assert.equal(model.normalizeBarWindow('5-hour'), 'session');
assert.equal(model.normalizeBarWindow('5hour'), 'session');
assert.equal(model.normalizeBarWindow('5hr'), 'session');
assert.equal(model.normalizeBarWindow('five-hour'), 'session');
assert.equal(model.normalizeBarWindow('week'), 'weekly');
assert.equal(model.normalizeBarWindow('7-day'), 'weekly');
assert.equal(model.normalizeBarWindow('weekly-7d'), 'weekly');
assert.equal(model.normalizeBarWindow('month'), 'monthly');
assert.equal(model.normalizeBarWindow('30d'), 'monthly');
assert.equal(model.normalizeBarWindow('monthly-cycle'), 'monthly');
assert.equal(model.normalizeBarWindow(null), 'auto');
assert.deepEqual(Array.from(pinnedChips.map(chip => chip.alarming)), [false, false]);
assert.equal(model.barStrip([twoWindow], false, false, true, false, false, 'monthly'), '󰚩  59%');
const bogusChips = model.barChips([twoWindow, threeWindow], twoWindow, true, true, false, false, false, false, 'bogus');
const autoChips = model.barChips([twoWindow, threeWindow], twoWindow, true, true, false, false, false, false);
assert.deepEqual(Array.from(bogusChips.map(chip => chip.label)), Array.from(autoChips.map(chip => chip.label)));
const secsEdge = model.parseReport(JSON.stringify({entries: [{
  id: 'openai', error: null,
  sections: [
    {type: 'metric', label: 'Zero', percent: 10, value: '10%', detail: '', severity: 'low', window_secs: 0},
    {type: 'metric', label: 'Negative', percent: 20, value: '20%', detail: '', severity: 'low', window_secs: -5},
    {type: 'metric', label: 'String', percent: 30, value: '30%', detail: '', severity: 'low', window_secs: "18000"},
    {type: 'metric', label: 'Float', percent: 40, value: '40%', detail: '', severity: 'low', window_secs: 18000.9}
  ]
}]})).entries[0];
assert.equal(secsEdge.sections[0].window_secs, null);
assert.equal(secsEdge.sections[1].window_secs, null);
assert.equal(secsEdge.sections[2].window_secs, 18000);
assert.equal(secsEdge.sections[3].window_secs, 18000);
const monthlyExclude = model.parseReport(JSON.stringify({entries: [{
id: 'openai', error: null,
sections: [
{type: 'metric', label: 'Monthly quota', percent: 90, value: '90%', detail: '', severity: 'low', window_secs: 18000},
{type: 'metric', label: 'Monthly dues', percent: 10, value: '10%', detail: '', severity: 'low'}
]
}]})).entries[0];
assert.equal(model.headline(monthlyExclude, 'monthly').text, '10%');
const sessionMax = model.parseReport(JSON.stringify({entries: [{
id: 'openai', error: null,
sections: [
{type: 'metric', label: 'A 5h', percent: 20, value: '20%', detail: '', severity: 'low', window_secs: 18000},
{type: 'metric', label: 'B 5h', percent: 70, value: '70%', detail: '', severity: 'mid', window_secs: 18000}
]
}]})).entries[0];
assert.equal(model.headline(sessionMax, 'session').text, '70%');
assert.equal(model.headline(twoWindow, '5h').text, '44%');
assert.equal(model.headline(twoWindow, 'shortest').text, '44%');
assert.equal(model.headline(secsEdge, 'session').text, '40%');
assert.equal(model.barStrip([threeWindow], false, false, true, false, false, 'bogus'), '󰚩  81%');

console.log('Omarchy model tests passed');
