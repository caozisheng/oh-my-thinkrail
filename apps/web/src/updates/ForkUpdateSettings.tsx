import {
	RiDownloadCloud2Line as DownloadCloud,
	RiExternalLinkLine as ExternalLink,
	RiRefreshLine as Refresh,
} from "@remixicon/react";
import type { ForkUpdateState } from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import type { UpdatesController } from "./useUpdates";

interface ForkUpdateSettingsProps {
	updates: Extract<UpdatesController, { source: "fork" }>;
}

type Translate = ReturnType<typeof useT>;

function forkStatusCopy(t: Translate, state: ForkUpdateState): { title: string; detail: string } {
	switch (state.status) {
		case "available":
			return {
				title: t("updates.fork.available.title", { version: state.availableVersion }),
				detail: t("updates.fork.available.detail"),
			};
		case "checking":
			return {
				title: t("updates.fork.checking.title"),
				detail: t("updates.fork.checking.detail"),
			};
		default:
			return {
				title: t("updates.fork.idle.title"),
				detail: t("updates.fork.idle.detail"),
			};
	}
}

export function ForkUpdateSettings({ updates }: ForkUpdateSettingsProps) {
	const t = useT();
	const state = updates.state;
	const checking = state.status === "checking";
	const available = state.status === "available";
	const copy = forkStatusCopy(t, state);

	return (
		<section data-testid="settings-updates" className="flex flex-col gap-16">
			<div className="flex flex-col gap-4">
				<h3 className="tr-title-section text-text-default">{t("updates.settings.title")}</h3>
				<p className="text-text-muted tr-text-metadata">{t("updates.fork.settings.description")}</p>
			</div>

			<div
				data-testid="update-status"
				data-source="fork"
				data-status={state.status}
				className="flex flex-col gap-12 rounded-sm border border-border-default bg-control-bg p-12"
			>
				<div className="flex items-start gap-8">
					<DownloadCloud
						aria-hidden="true"
						className={`mt-2 size-16 shrink-0 ${
							available ? "text-primary" : checking ? "text-feedback-info" : "text-text-muted"
						}`}
					/>
					<div className="min-w-0 flex-1">
						<p className="tr-title-compact text-text-default">{copy.title}</p>
						<p className="text-text-muted tr-text-metadata">{copy.detail}</p>
					</div>
				</div>

				<div className="flex flex-wrap items-center justify-between gap-8 border-border-default border-t pt-8">
					<span data-testid="update-version" className="text-text-muted tr-text-metadata">
						{t("updates.fork.version.current", { version: state.version })}
					</span>
					{available && state.availableVersion ? (
						<span className="text-text-muted tr-text-metadata">
							{t("updates.version.available", { version: state.availableVersion })}
						</span>
					) : null}
				</div>
			</div>

			<div className="flex flex-wrap justify-end gap-8">
				{available ? (
					<Button
						variant="primary"
						size="l"
						iconLeft={ExternalLink}
						data-testid="fork-update-open-releases"
						onClick={updates.openReleases}
					>
						{t("updates.fork.action.openReleases")}
					</Button>
				) : null}
				<Button
					variant="outline"
					size="l"
					iconLeft={Refresh}
					data-testid="fork-update-check"
					disabled={checking}
					onClick={updates.checkNow}
				>
					{checking ? t("updates.fork.action.checking") : t("updates.fork.action.check")}
				</Button>
			</div>
		</section>
	);
}
