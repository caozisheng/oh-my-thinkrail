import {
	type ExtensionCatalogEntry,
	type ExtensionSettingDescriptor,
	type ExtensionSettingValue,
	type ExtensionSettingValues,
	isValidCidrRange,
	OTHER_AGENT_SKILLS_PROTOCOL_VERSION,
} from "@thinkrail/contracts";
import type { MessageKey } from "@thinkrail/locales";
import { type Translator, useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import { LoadingRegion } from "@thinkrail/ui/skeleton";
import { Switch } from "@thinkrail/ui/switch";
import { Textarea } from "@thinkrail/ui/textarea";
import { Fragment, useEffect, useState } from "react";
import { useWebExtensionLoads, webExtensionTitle, webOnlyExtensions } from "@/extensions";
import {
	SETTINGS_ROWS,
	SettingsGroup,
	SettingsNotice,
	SettingsPage,
	type SettingsReset,
	SettingsRow,
} from "@/settingsKit";
import {
	selectActiveRepoWorkspaceId,
	selectBuiltinExtensions,
	selectInstalledExtensions,
	selectSupportsExtensionBrowse,
	selectSupportsInstalledExtensions,
	toast,
	useAppStore,
} from "@/store";
import {
	getTransport,
	refreshExtensionCatalog,
	supportsExtensionCidrSettings,
	supportsExtensionSettings,
	supportsPiPackages,
} from "@/transport";
import { ConfirmDialog } from "./ConfirmDialog";
import { ExtensionBrowse } from "./ExtensionBrowse";
import {
	InstalledExtensionRow,
	installedExtensionKey,
	installedExtensionRowId,
} from "./InstalledExtensionRow";
import { InstallPackageDialog, type InstallPreset } from "./InstallPackageDialog";
import { GalleryLinks, PiBuiltinsGroup, PiPackagesGroup } from "./PiPackagesSettings";
import { saveSettings } from "./saveSettings";
import { SETTING, settingProps } from "./settingsCatalog";
import { useExtensionBrowse } from "./useExtensionBrowse";
import { useInstalledExtensions } from "./useInstalledExtensions";
import { UPDATE_CHECK_KEY, usePiPackages } from "./usePiPackages";

const BUNDLED_DESCRIPTIONS: Readonly<Record<string, MessageKey>> = {
	"next-steps": "settings.extensions.next-steps.description",
	"session-insights": "settings.extensions.session-insights.description",
	visualize: "settings.extensions.visualize.description",
	"web-access": "settings.extensions.web-access.description",
};

function bundledDescription(t: Translator, entry: ExtensionCatalogEntry): string {
	const key = BUNDLED_DESCRIPTIONS[entry.name];
	return key ? t(key) : (entry.description ?? "");
}

/** The web half's translated title for a bundled extension, else the host's copy. */
function extensionTitle(t: Translator, entry: { name: string; title: string }): string {
	const key = webExtensionTitle(entry.name);
	return key ? t(key) : entry.title;
}

export function withWebOnlyEntries(
	t: Translator,
	entries: readonly ExtensionCatalogEntry[],
): ExtensionCatalogEntry[] {
	const webOnly = webOnlyExtensions(new Set(entries.map((entry) => entry.name)));
	return [
		...entries,
		...webOnly.map(({ name, title, description }) => ({
			name,
			title: t(title),
			...(description ? { description: t(description) } : {}),
			enabled: true,
			tools: [],
			hasChildExtensions: false,
		})),
	];
}

interface SettingCopy {
	title: MessageKey;
	description: MessageKey;
	settingId?: string;
}

const SETTING_COPY: Readonly<Record<string, Readonly<Record<string, SettingCopy>>>> = {
	"ask-user-question": {
		richPreviews: {
			title: "settings.extensions.ask-user-question.richPreviews.title",
			description: "settings.extensions.ask-user-question.richPreviews.description",
			settingId: SETTING.richPreviews.id,
		},
	},
	"web-access": {
		allowRanges: {
			title: "settings.extensions.web-access.allowRanges.title",
			description: "settings.extensions.web-access.allowRanges.description",
		},
	},
};

function ExtensionCidrListSettingRow({
	entry,
	setting,
	value,
	onChange,
}: {
	entry: ExtensionCatalogEntry;
	setting: Extract<ExtensionSettingDescriptor, { type: "cidr-list" }>;
	value: string[];
	onChange: (value: string[]) => void;
}) {
	const t = useT();
	const savedText = value.join("\n");
	const [draft, setDraft] = useState(savedText);
	useEffect(() => setDraft(savedText), [savedText]);
	const ranges = draft
		.split(/\r?\n/)
		.map((range) => range.trim())
		.filter(Boolean);
	const valid = ranges.every(isValidCidrRange);
	const unchanged =
		ranges.length === value.length && ranges.every((range, index) => range === value[index]);
	const changed =
		value.length !== setting.default.length ||
		value.some((range, index) => range !== setting.default[index]);
	const copy = SETTING_COPY[entry.name]?.[setting.key];
	if (!copy) return null;
	return (
		<SettingsRow
			nested
			rowId={`extension-setting-${entry.name}-${setting.key}`}
			testId={`extension-setting-${entry.name}-${setting.key}`}
			label={t(copy.title)}
			description={
				<span className="flex flex-col gap-4">
					<span>{t(copy.description)}</span>
					{!valid ? (
						<span className="text-feedback-error" role="alert">
							{t("settings.extensions.web-access.allowRanges.invalid")}
						</span>
					) : null}
				</span>
			}
			control={
				<div className="flex w-full max-w-320 flex-col gap-4">
					<Textarea
						aria-label={t(copy.title)}
						aria-invalid={!valid}
						data-testid={`extension-setting-cidr-list-${entry.name}-${setting.key}`}
						disabled={!entry.enabled}
						rows={3}
						spellCheck={false}
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
					/>
					<Button
						variant="outline"
						size="s"
						tabIndex={0}
						disabled={!entry.enabled || !valid || unchanged}
						data-testid={`extension-setting-save-${entry.name}-${setting.key}`}
						onClick={() => onChange([...new Set(ranges)])}
					>
						{t("settings.extensions.web-access.allowRanges.save")}
					</Button>
				</div>
			}
			reset={{
				changed,
				disabled: !entry.enabled,
				onReset: () => onChange(setting.default),
			}}
		/>
	);
}

function ExtensionSettingRow({
	entry,
	setting,
	value,
	onChange,
}: {
	entry: ExtensionCatalogEntry;
	setting: ExtensionSettingDescriptor;
	value: ExtensionSettingValue;
	onChange: (value: ExtensionSettingValue) => void;
}) {
	const t = useT();
	const copy = SETTING_COPY[entry.name]?.[setting.key];
	if (!copy) return null;
	if (setting.type === "cidr-list") {
		return (
			<ExtensionCidrListSettingRow
				entry={entry}
				setting={setting}
				value={Array.isArray(value) ? value : setting.default}
				onChange={onChange}
			/>
		);
	}
	const checked = typeof value === "boolean" ? value : setting.default;
	return (
		<SettingsRow
			nested
			settingId={copy.settingId}
			rowId={`extension-setting-${entry.name}-${setting.key}`}
			testId={`extension-setting-${entry.name}-${setting.key}`}
			label={t(copy.title)}
			description={t(copy.description)}
			control={
				<Switch
					checked={checked}
					disabled={!entry.enabled}
					label={t(copy.title)}
					testId={`extension-setting-toggle-${entry.name}-${setting.key}`}
					tabIndex={0}
					onCheckedChange={onChange}
				/>
			}
			reset={{
				changed: checked !== setting.default,
				disabled: !entry.enabled,
				onReset: () => onChange(setting.default),
			}}
		/>
	);
}

function ToolsLine({ tools }: { tools: readonly string[] }) {
	const t = useT();
	if (tools.length === 0) return null;
	return (
		<span data-testid="extension-tools" className="wrap-anywhere">
			{t("settings.extensions.tools")}{" "}
			{tools.map((tool, index) => (
				<Fragment key={tool}>
					{index > 0 ? ", " : null}
					<code data-testid={`extension-tool-${tool}`} className="tr-code-text-small">
						{tool}
					</code>
				</Fragment>
			))}
		</span>
	);
}

export function ExtensionsCatalog({
	entries,
	disabled,
	onToggle,
	settings = {},
	onSetting,
	cidrSettingsSupported = true,
	onRetry,
}: {
	entries: readonly ExtensionCatalogEntry[] | "loading" | "failed";
	disabled: readonly string[];
	onToggle: (name: string, enabled: boolean) => void;
	settings?: ExtensionSettingValues;
	onSetting?: ((name: string, key: string, value: ExtensionSettingValue) => void) | undefined;
	cidrSettingsSupported?: boolean;
	onRetry?: (() => void) | undefined;
}) {
	const t = useT();
	if (entries === "loading") return <LoadingRegion rows={2} className="py-8" />;
	if (entries === "failed") {
		return (
			<SettingsNotice
				variant="error"
				rowId="extensions-failed"
				testId="extensions-failed"
				action={
					onRetry ? (
						<Button
							variant="outline"
							size="s"
							tabIndex={0}
							data-testid="extensions-retry"
							onClick={onRetry}
						>
							{t("common.retry")}
						</Button>
					) : undefined
				}
			>
				{t("settings.extensions.loadFailed")}
			</SettingsNotice>
		);
	}
	if (entries.length === 0) {
		return (
			<p data-testid="extensions-empty" className="py-8 text-text-muted tr-text-metadata">
				{t("settings.extensions.empty")}
			</p>
		);
	}
	return (
		<div data-setting-id={SETTING.bundledExtensions.id} className={SETTINGS_ROWS}>
			{entries.map((entry) => {
				const enabled = !disabled.includes(entry.name);
				const title = extensionTitle(t, entry);
				const reset: SettingsReset = {
					changed: !enabled,
					onReset: () => onToggle(entry.name, true),
				};
				return (
					<Fragment key={entry.name}>
						<SettingsRow
							rowId={`extension-${entry.name}`}
							testId={`extension-row-${entry.name}`}
							label={title}
							description={
								entry.description || entry.tools.length > 0 ? (
									<span className="flex flex-col gap-2">
										{entry.description ? <span>{bundledDescription(t, entry)}</span> : null}
										<ToolsLine tools={entry.tools} />
									</span>
								) : undefined
							}
							control={
								<Switch
									checked={enabled}
									label={t("settings.extensions.enable", { title })}
									testId={`extension-toggle-${entry.name}`}
									tabIndex={0}
									onCheckedChange={(next) => onToggle(entry.name, next)}
								/>
							}
							reset={reset}
						/>
						{onSetting
							? (entry.settings ?? [])
									.filter((setting) => setting.type !== "cidr-list" || cidrSettingsSupported)
									.map((setting) => (
										<ExtensionSettingRow
											key={setting.key}
											entry={{ ...entry, enabled }}
											setting={setting}
											value={settings[entry.name]?.[setting.key] ?? setting.default}
											onChange={(value) => onSetting(entry.name, setting.key, value)}
										/>
									))
							: null}
					</Fragment>
				);
			})}
		</div>
	);
}

export function ExtensionsSettings() {
	const t = useT();
	const disabled = useAppStore((state) => state.disabledExtensions);
	const extensionSettings = useAppStore((state) => state.extensionSettings);
	const disabledPackages = useAppStore((state) => state.disabledPackages);
	const otherAgentSkills = useAppStore((state) => state.otherAgentSkills);
	const packagesVersion = useAppStore((state) => state.packagesVersion);
	const protocolVersion = useAppStore((state) => state.protocolVersion);
	const workspaceId = useAppStore(selectActiveRepoWorkspaceId);
	const packagesSupported = supportsPiPackages(protocolVersion);
	const settingsSupported = supportsExtensionSettings(protocolVersion);
	const cidrSettingsSupported = supportsExtensionCidrSettings(protocolVersion);
	const catalogRead = useAppStore((state) => state.extensionCatalog);
	const welcomeGeneration = useAppStore((state) => state.welcomeGeneration);
	const entries = selectBuiltinExtensions(catalogRead);
	const installed = selectInstalledExtensions(catalogRead);
	const installedSupported = selectSupportsInstalledExtensions({ protocolVersion });
	const webLoads = useWebExtensionLoads();
	const browseSupported = selectSupportsExtensionBrowse({ protocolVersion });
	const [packagesAttempt, setPackagesAttempt] = useState(0);
	const [installOpen, setInstallOpen] = useState(false);
	const [installPreset, setInstallPreset] = useState<InstallPreset | null>(null);
	const [installKey, setInstallKey] = useState(0);
	const [browseQuery, setBrowseQuery] = useState("");
	const browse = useExtensionBrowse({ enabled: browseSupported, installedCatalog: catalogRead });
	const openInstall = (preset: InstallPreset | null) => {
		setInstallPreset(preset);
		setInstallKey((key) => key + 1);
		setInstallOpen(true);
	};
	const packages = usePiPackages({
		enabled: packagesSupported,
		workspaceId,
		packagesVersion: packagesVersion + packagesAttempt,
		disabledPackages,
	});
	const extensions = useInstalledExtensions({
		enabled: installedSupported,
		disabledExtensions: disabled,
	});

	useEffect(() => {
		if (welcomeGeneration > 0) void refreshExtensionCatalog();
	}, [welcomeGeneration]);

	const toggle = (name: string, enabled: boolean) => {
		const next = enabled
			? disabled.filter((candidate) => candidate !== name)
			: [...disabled.filter((candidate) => candidate !== name), name];
		getTransport()
			.request("settings.update", { config: { disabledExtensions: next } })
			.catch(() => toast.error(t("settings.extensions.changeFailed")));
	};

	const changeSetting = (name: string, key: string, value: ExtensionSettingValue) => {
		if (Array.isArray(value) && !cidrSettingsSupported) return;
		getTransport()
			.request("settings.update", { config: { extensionSettings: { [name]: { [key]: value } } } })
			.catch(() => toast.error(t("settings.extensions.changeFailed")));
	};

	const { catalog, removeTarget } = packages;
	const loaded = catalog !== "loading" && catalog !== "failed" ? catalog : null;
	const settingsPath = loaded?.settingsPath ?? "";
	const projectSettingsPath = loaded?.projectSettingsPath;

	return (
		<SettingsPage
			testId="settings-extensions"
			title={t("settings.nav.extensions")}
			description={t(
				packagesSupported
					? "settings.extensions.description"
					: "settings.extensions.descriptionBundledOnly",
			)}
		>
			{packagesSupported ? (
				<SettingsGroup title={t("settings.extensions.group.packages")}>
					<SettingsRow
						{...settingProps(t, SETTING.installPackage)}
						control={
							<Button
								variant="primary"
								size="m"
								tabIndex={0}
								data-testid="packages-install"
								onClick={() => openInstall(null)}
							>
								{t("settings.extensions.install")}
							</Button>
						}
						sides={<GalleryLinks extensions={installedSupported} />}
					/>
				</SettingsGroup>
			) : null}
			<SettingsGroup
				testId="settings-bundled-extensions"
				title={t("settings.extensions.group.bundled")}
			>
				<ExtensionsCatalog
					entries={Array.isArray(entries) ? withWebOnlyEntries(t, entries) : entries}
					disabled={disabled}
					onToggle={toggle}
					settings={extensionSettings}
					onSetting={settingsSupported ? changeSetting : undefined}
					cidrSettingsSupported={cidrSettingsSupported}
					onRetry={() => void refreshExtensionCatalog()}
				/>
			</SettingsGroup>
			{packagesSupported ? (
				<PiPackagesGroup
					catalog={catalog}
					updates={packages.updates}
					extraUpdates={extensions.updates.size}
					checkingUpdates={packages.checkingUpdates || extensions.checkingUpdates}
					checkError={packages.errors.get(UPDATE_CHECK_KEY) ?? extensions.checkError}
					busy={packages.busy}
					errors={packages.errors}
					expanded={packages.expanded}
					onToggleExpanded={packages.toggleExpanded}
					onAction={packages.onAction}
					onUpdateAll={() => {
						packages.updateAll();
						extensions.updateFlagged(installed);
					}}
					onCheckUpdates={() => {
						packages.checkUpdates();
						if (installedSupported) extensions.checkUpdates();
					}}
					onRetry={() => setPackagesAttempt((value) => value + 1)}
					extensionRows={installed.map((entry) => {
						const key = installedExtensionKey(entry);
						return {
							id: installedExtensionRowId(entry),
							onRemove: () => {
								if (!extensions.busy.has(key)) extensions.onAction({ kind: "remove", entry });
							},
							render: (menu) => (
								<InstalledExtensionRow
									entry={entry}
									enabled={!disabled.includes(entry.name)}
									settings={extensionSettings[entry.name]}
									settingsSupported={settingsSupported}
									webLoad={webLoads.get(entry.name)}
									updateAvailable={extensions.updates.has(key)}
									busy={extensions.busy.has(key)}
									error={extensions.errors.get(key)}
									{...menu}
									onAction={extensions.onAction}
								/>
							),
						};
					})}
				/>
			) : null}
			{packagesSupported && browseSupported ? (
				<ExtensionBrowse
					read={browse.read}
					query={browseQuery}
					onQueryChange={setBrowseQuery}
					onRetry={browse.retry}
					onInstall={(entry) =>
						openInstall({
							source: entry.install,
							title: entry.title ?? entry.name,
							version: entry.version,
							author: entry.author,
							description: entry.description,
						})
					}
				/>
			) : null}
			{protocolVersion !== null && protocolVersion >= OTHER_AGENT_SKILLS_PROTOCOL_VERSION ? (
				<SettingsGroup
					testId="settings-other-agent-skills"
					title={t("settings.extensions.group.skills")}
				>
					<SettingsRow
						{...settingProps(t, SETTING.otherAgentSkills)}
						control={
							<Switch
								checked={otherAgentSkills}
								label={t("settings.extensions.otherAgentSkills")}
								testId="other-agent-skills-toggle"
								tabIndex={0}
								onCheckedChange={(enabled) =>
									void saveSettings(
										{ otherAgentSkills: enabled },
										t("settings.extensions.otherAgentSkillsFailed"),
									)
								}
							/>
						}
					/>
				</SettingsGroup>
			) : null}
			{packagesSupported && loaded ? (
				<PiBuiltinsGroup
					builtins={loaded.builtins}
					settingsPath={settingsPath}
					projectSettingsPath={projectSettingsPath}
					busy={packages.busy}
					errors={packages.errors}
					onToggle={packages.toggleBuiltin}
				/>
			) : null}
			{packagesSupported ? (
				<>
					<ConfirmDialog
						open={removeTarget !== null}
						onOpenChange={(open) => {
							if (!open) packages.cancelRemove();
						}}
						title={t("settings.packages.removeTitle", { name: removeTarget?.name ?? "" })}
						description={t("settings.packages.removeDescription", {
							path:
								removeTarget?.scope === "project"
									? (projectSettingsPath ?? settingsPath)
									: settingsPath,
						})}
						confirmLabel={t("settings.packages.removeConfirm")}
						destructive
						confirmTestId="package-remove-confirm"
						onConfirm={packages.removeNow}
					/>
					<ConfirmDialog
						open={extensions.removeTarget !== null}
						onOpenChange={(open) => {
							if (!open) extensions.cancelRemove();
						}}
						title={t("settings.packages.removeTitle", {
							name: extensions.removeTarget?.title ?? "",
						})}
						description={t("settings.installedExtensions.removeDescription")}
						confirmLabel={t("settings.installedExtensions.removeConfirm")}
						destructive
						confirmTestId="installed-extension-remove-confirm"
						onConfirm={extensions.removeNow}
					/>
					<InstallPackageDialog
						key={installKey}
						preset={installPreset}
						open={installOpen}
						onOpenChange={setInstallOpen}
						catalog={loaded}
						workspaceId={workspaceId ?? null}
						install={packages.install}
						extensionsSupported={installedSupported}
					/>
				</>
			) : null}
		</SettingsPage>
	);
}
