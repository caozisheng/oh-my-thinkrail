import type {
	IssueConnectionInput,
	IssueContent,
	IssueReference,
	IssueSessionLaunch,
	IssueSummary,
} from "@thinkrail/contracts";
import { ISSUES_CONTENT_PROTOCOL_VERSION, isIssueWebUrl } from "@thinkrail/contracts";
import { localeOf, useT } from "@thinkrail/locales/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QuietScrollArea } from "../components/QuietScrollArea";
import { availableLocales } from "../i18n";
import { useAppStore } from "../store";
import { getTransport } from "../transport";
import type { IssuePreview } from "./IssueBody";
import { IssuesPanel } from "./IssuesPanel";
import {
	type ConnectResult,
	type IssueActionCapabilities,
	type IssueActionId,
	type IssueActionResult,
	type IssuePanelError,
	type IssueToolSnapshot,
	issueActionCall,
	issueKey,
	issueSnapshotAfterLoad,
	issueSnapshotUpdate,
	issueStartupLocale,
	loadIssueSnapshot,
	runIssueAction,
	subscribeIssueAssociation,
	supportsIssueActions,
	supportsIssueAuth,
	supportsIssueGithub,
	supportsIssueImplementation,
	supportsIssueSessionStartup,
	supportsIssues,
} from "./model";

type SnapshotPatch = Partial<Omit<IssueToolSnapshot, "identity">>;

async function readIssueContent(
	projectId: string,
	reference: IssueReference,
): Promise<IssueContent | null> {
	try {
		const content = await getTransport().request("issues.content", { projectId, reference });
		return typeof content.description === "string" && isIssueWebUrl(content.url, reference)
			? content
			: null;
	} catch {
		return null;
	}
}

export function IssuesTool({
	projectId,
	onOpenIssue,
	onLaunchSession,
	onTrustProject,
}: {
	projectId: string;
	onOpenIssue?: (reference: IssueReference) => Promise<void> | void;
	onLaunchSession?: (launch: IssueSessionLaunch) => void;
	/** Host refuses stage actions for an untrusted project; the shell performs the grant. */
	onTrustProject?: () => void;
}) {
	const t = useT();
	const localLocales = useAppStore((s) => s.localLocales);
	const locale = issueStartupLocale(localeOf(t), availableLocales(localLocales));
	const version = useAppStore((s) => s.protocolVersion);
	const status = useAppStore((s) => s.status);
	const generation = useAppStore((s) => s.connectionGeneration);
	const supported = supportsIssues(version);
	const authSupported = supportsIssueAuth(version);
	const githubSupported = supportsIssueGithub(version);
	const trusted = useAppStore((s) => s.projects.find((p) => p.id === projectId)?.trusted === true);
	const capabilities = useMemo<IssueActionCapabilities>(
		() => ({
			actionsSupported: supportsIssueActions(version),
			startupSupported: supportsIssueSessionStartup(version),
			implementationSupported: supportsIssueImplementation(version),
			trusted,
		}),
		[version, trusted],
	);
	const [actionPending, setActionPending] = useState(false);
	const [actionError, setActionError] = useState<IssuePanelError | null>(null);
	const [actionErrorIssue, setActionErrorIssue] = useState<string | null>(null);
	const identity = `${projectId}:${generation}:${status}:${supported}:${authSupported}`;
	const [snapshot, setSnapshot] = useState<IssueToolSnapshot | null>(null);
	const requestSequence = useRef(0);
	const previewSequence = useRef(0);
	const [preview, setPreview] = useState<IssuePreview | null>(null);
	const previewSupported = version !== null && version >= ISSUES_CONTENT_PROTOCOL_VERSION;
	const activePreview = preview?.identity === identity ? preview : null;
	const clearPreview = useCallback(() => {
		previewSequence.current++;
		setPreview(null);
	}, []);
	const togglePreview = async (issue: IssueSummary, retry = false) => {
		if (!previewSupported || status !== "connected") return;
		const key = issueKey(issue);
		const close = activePreview?.key === key && !retry;
		clearPreview();
		if (close) return;
		const sequence = previewSequence.current;
		setPreview({ key, identity, status: "loading" });
		const content = await readIssueContent(projectId, issue.reference);
		if (sequence !== previewSequence.current) return;
		setPreview(
			content ? { key, identity, status: "ready", content } : { key, identity, status: "error" },
		);
	};

	const update = useCallback(
		(previous: IssueToolSnapshot | null, patch: SnapshotPatch): IssueToolSnapshot =>
			issueSnapshotUpdate(previous, identity, patch),
		[identity],
	);

	const refresh = useCallback(
		async (input?: IssueConnectionInput): Promise<ConnectResult> => {
			if (!supported || status !== "connected") return { ok: false, error: "connect" };
			clearPreview();
			const sequence = ++requestSequence.current;
			const current = () => sequence === requestSequence.current;
			setActionError(null);
			setSnapshot((previous) => update(previous, { pending: true, error: null }));
			const transport = getTransport();
			const result = await loadIssueSnapshot(
				{
					connection: () => transport.request("issues.connection", { projectId }),
					...(input
						? { connect: () => transport.request("issues.connect", { projectId, input }) }
						: {}),
					list: () => transport.request("issues.list", { projectId }),
				},
				current,
			);
			if (!result || !current()) return { ok: false, error: "connect" };
			setSnapshot((previous) => issueSnapshotAfterLoad(previous, identity, result));
			return result.error === "connect" ? { ok: false, error: "connect" } : { ok: true };
		},
		[identity, projectId, status, supported, update, clearPreview],
	);

	const disconnect = useCallback(async () => {
		if (!supported || status !== "connected") return;
		clearPreview();
		const sequence = ++requestSequence.current;
		setSnapshot((previous) =>
			previous ? update(previous, { pending: true, error: null }) : previous,
		);
		try {
			await getTransport().request("issues.disconnect", { projectId });
		} catch (error) {
			if (sequence === requestSequence.current)
				setSnapshot((previous) =>
					previous ? update(previous, { pending: false, error: "disconnect" }) : previous,
				);
			throw error;
		}
		if (sequence !== requestSequence.current) return;
		await refresh();
	}, [projectId, refresh, status, supported, update, clearPreview]);

	useEffect(() => {
		void refresh();
		return () => {
			requestSequence.current++;
			previewSequence.current++;
		};
	}, [refresh]);

	const runAction = useCallback(
		async (issue: IssueSummary, action: IssueActionId): Promise<IssueActionResult> => {
			const { reference } = issue;
			const transport = getTransport();
			setActionPending(true);
			setActionError(null);
			setActionErrorIssue(null);
			const result = await runIssueAction(
				action,
				issueActionCall(
					{ projectId, reference, locale },
					(requested, params) => transport.request(requested, params),
					version,
				),
				(launch) => onLaunchSession?.(launch),
			);
			setActionPending(false);
			if (!result.ok) {
				setActionError(result.error);
				setActionErrorIssue(issueKey(issue));
				return result;
			}
			// Starting implementation may move the backlog label, so the summaries are re-read.
			if (action === "implement") void refresh();
			return result;
		},
		[onLaunchSession, projectId, refresh, locale, version],
	);

	useEffect(
		() =>
			subscribeIssueAssociation((associated) => {
				if (associated === projectId) void refresh();
			}),
		[projectId, refresh],
	);

	const active = snapshot?.identity === identity ? snapshot : null;
	if (!supported)
		return <p className="p-panel-inset text-text-muted tr-text-ui">{t("issues.unsupported")}</p>;
	if (status !== "connected")
		return <p className="p-panel-inset text-text-muted tr-text-ui">{t("issues.offline")}</p>;
	return (
		<QuietScrollArea className="h-full">
			<IssuesPanel
				key={`${identity}:${active?.connection?.connected === true}`}
				previewSupported={previewSupported}
				preview={activePreview}
				onTogglePreview={(issue) => {
					void togglePreview(issue);
				}}
				onRetryPreview={(issue) => {
					void togglePreview(issue, true);
				}}
				connection={active?.connection ?? null}
				issues={active?.issues ?? []}
				pending={active?.pending ?? true}
				authSupported={authSupported}
				githubSupported={githubSupported}
				capabilities={capabilities}
				error={active?.error ?? undefined}
				onRefresh={() => {
					void refresh();
				}}
				onConnect={refresh}
				onDisconnect={disconnect}
				onOpenIssue={onOpenIssue}
				onRunAction={runAction}
				onTrustProject={onTrustProject}
				actionPending={actionPending}
				actionError={actionError}
				actionErrorIssue={actionErrorIssue ?? undefined}
			/>
		</QuietScrollArea>
	);
}
