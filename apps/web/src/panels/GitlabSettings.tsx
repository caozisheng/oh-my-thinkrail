import {
	RiCheckLine as Check,
	RiErrorWarningLine as ErrorIcon,
	RiRefreshLine as Refresh,
	RiAlertLine as Warning,
} from "@remixicon/react";
import type { GitlabAuthStatus } from "@thinkrail/contracts";
import { T, useT } from "@thinkrail/locales/react";
import { Button, withIconClass } from "@thinkrail/ui/button";
import { SkeletonRows } from "@thinkrail/ui/skeleton";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { SettingsGroup, SettingsRow } from "@/settingsKit";
import { getTransport } from "@/transport";

const SpinningRefresh = withIconClass(Refresh, "motion-safe:animate-spin");

export interface GitlabProbe {
	status: GitlabAuthStatus | null;
	failed: boolean;
	pending: number | null;
}

export type GitlabProbeEvent =
	| { type: "start"; id: number }
	| { type: "answer"; id: number; status: GitlabAuthStatus }
	| { type: "reject"; id: number };

export function gitlabProbe(probe: GitlabProbe, event: GitlabProbeEvent): GitlabProbe {
	if (event.type === "start") return { ...probe, pending: event.id };
	if (event.id !== probe.pending) return probe;
	return event.type === "answer"
		? { status: event.status, failed: false, pending: null }
		: { ...probe, failed: true, pending: null };
}

let lastStatus: GitlabAuthStatus | null = null;

export function GitlabSettings() {
	const [probe, dispatch] = useReducer(gitlabProbe, {
		status: lastStatus,
		failed: false,
		pending: null,
	});
	const requests = useRef(0);
	const run = useCallback((method: "gitlab.authStatus" | "gitlab.refresh") => {
		const id = ++requests.current;
		dispatch({ type: "start", id });
		getTransport()
			.request(method, {})
			.then(
				(status) => dispatch({ type: "answer", id, status }),
				() => dispatch({ type: "reject", id }),
			);
	}, []);

	useEffect(() => run("gitlab.authStatus"), [run]);
	useEffect(() => {
		if (probe.status) lastStatus = probe.status;
	}, [probe.status]);

	return (
		<GitlabStatusView
			status={probe.status}
			checking={probe.pending !== null}
			failed={probe.failed}
			onRefresh={() => run("gitlab.refresh")}
		/>
	);
}

export function GitlabStatusView({
	status,
	checking,
	failed,
	onRefresh,
}: {
	status: GitlabAuthStatus | null;
	checking: boolean;
	failed: boolean;
	onRefresh: () => void;
}) {
	const t = useT();
	return (
		<SettingsGroup
			title={t("settings.gitlab.title")}
			description={t("settings.gitlab.description")}
		>
			<SettingsRow
				rowId="gitlab-cli"
				label={t("settings.gitlab.cli")}
				description={
					<div
						data-testid="settings-gitlab-status"
						data-connected={status?.connected}
						className="flex min-w-0 items-start gap-4"
					>
						{status?.connected ? (
							<>
								<Check aria-hidden className="mt-2 size-14 shrink-0 text-feedback-success" />
								<span className="text-feedback-success">{t("settings.gitlab.connected")}</span>
							</>
						) : status ? (
							<>
								<Warning aria-hidden className="mt-2 size-14 shrink-0 text-feedback-warning" />
								<span>
									<T
										i18nKey="settings.gitlab.notConnected"
										components={[<code key="command" className="tr-code-text" />]}
									/>
								</span>
							</>
						) : failed ? (
							<>
								<ErrorIcon aria-hidden className="mt-2 size-14 shrink-0 text-feedback-error" />
								<span>{t("settings.gitlab.checkFailed")}</span>
							</>
						) : (
							<SkeletonRows rows={1} label={t("settings.gitlab.checking")} />
						)}
					</div>
				}
				control={
					<Button
						variant="outline"
						size="m"
						iconLeft={checking ? SpinningRefresh : Refresh}
						tabIndex={0}
						aria-busy={checking || undefined}
						aria-disabled={checking || undefined}
						data-testid="settings-gitlab-refresh"
						onClick={() => {
							if (!checking) onRefresh();
						}}
					>
						{t("settings.gitlab.refresh")}
					</Button>
				}
			/>
		</SettingsGroup>
	);
}
