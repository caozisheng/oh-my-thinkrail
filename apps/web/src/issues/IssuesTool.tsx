import type {
	IssueConnectionInput,
	IssueReference,
	IssueRepositories,
	IssueSessionLaunch,
	IssueSummary,
} from "@thinkrail/contracts";
import {
	ISSUES_CONTENT_PROTOCOL_VERSION,
	ISSUES_DETAIL_PROTOCOL_VERSION,
	isIssueWebUrl,
} from "@thinkrail/contracts";
import { localeOf, useT } from "@thinkrail/locales/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { QuietScrollArea } from "../components/QuietScrollArea";
import { availableLocales } from "../i18n";
import { selectRepoProjects, useAppStore } from "../store";
import { getTransport, wsErrorCode } from "../transport";
import type { IssuePreview } from "./IssueBody";
import type { IssueRepositoriesNotice, IssueRepositoriesView } from "./IssueRepositoriesControl";
import { IssuesPanel } from "./IssuesPanel";
import {
	type ConnectResult,
	type IssueActionCapabilities,
	type IssueActionId,
	type IssueActionProgress,
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
	supportsIssueRepositories,
	supportsIssueRepositoryJoin,
	supportsIssueSessionStartup,
	supportsIssues,
} from "./model";

type SnapshotPatch = Partial<Omit<IssueToolSnapshot, "identity">>;

async function readIssueContent(
	projectId: string,
	reference: IssueReference,
	version: number | null,
): Promise<IssuePreview["content"] | null> {
	try {
		const content = await getTransport().request(
			version !== null && version >= ISSUES_DETAIL_PROTOCOL_VERSION
				? "issues.detail"
				: "issues.content",
			{ projectId, reference },
		);
		return typeof content.description === "string" && isIssueWebUrl(content.url, reference)
			? content
			: null;
	} catch {
		return null;
	}
}

/** A join or cleanup may fetch each repository first and create or remove worktrees. */
const REPOSITORY_JOIN_TIMEOUT_MS = 120_000;

export function IssuesTool({
	projectId,
	onOpenIssue,
	onLaunchSession,
	onTrustProject,
}: {
	projectId: string;
	onOpenIssue?: (reference: IssueReference) => Promise<void> | void;
	onLaunchSession?: (launch: IssueSessionLaunch, isCurrent: () => boolean) => Promise<void> | void;
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
	const projects = useAppStore(useShallow(selectRepoProjects));
	const repositoriesSupported = supportsIssueRepositories(version);
	const joinSupported = supportsIssueRepositoryJoin(version);
	const capabilities = useMemo<IssueActionCapabilities>(
		() => ({
			actionsSupported: supportsIssueActions(version),
			startupSupported: supportsIssueSessionStartup(version),
			implementationSupported: supportsIssueImplementation(version),
			trusted,
		}),
		[version, trusted],
	);
	const [actionState, setActionState] = useState<{
		identity: string;
		progress: IssueActionProgress;
		error: IssuePanelError | null;
		pending: boolean;
	} | null>(null);
	const actionSequence = useRef(0);
	const actionLock = useRef(false);
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
		const content = await readIssueContent(projectId, issue.reference, version);
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
			actionSequence.current++;
			actionLock.current = false;
			setActionState(null);
			const sequence = ++requestSequence.current;
			const current = () => sequence === requestSequence.current;
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
		actionSequence.current++;
		actionLock.current = false;
		setActionState(null);
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
			actionSequence.current++;
			actionLock.current = false;
		};
	}, [refresh]);

	const runAction = useCallback(
		async (issue: IssueSummary, action: IssueActionId): Promise<IssueActionResult> => {
			if (actionLock.current) return { ok: false, error: "launch-blocked" };
			actionLock.current = true;
			const sequence = ++actionSequence.current;
			const current = () => sequence === actionSequence.current;
			const progress: IssueActionProgress = { issue: issueKey(issue), action, phase: "starting" };
			const { reference } = issue;
			const transport = getTransport();
			setActionState({ identity, progress, error: null, pending: true });
			const result = await runIssueAction(
				action,
				issueActionCall(
					{ projectId, reference, locale },
					(requested, params) => transport.request(requested, params),
					version,
				),
				async (launch) => {
					if (!current()) return;
					setActionState({
						identity,
						progress: { ...progress, phase: "opening" },
						error: null,
						pending: true,
					});
					await onLaunchSession?.(launch, current);
				},
			);
			if (!current()) return result;
			actionLock.current = false;
			setActionState({
				identity,
				progress,
				pending: false,
				error: result.ok ? null : result.error,
			});
			if (!result.ok) return result;
			// Starting implementation may move the backlog label, so the summaries are re-read.
			if (action === "implement") void refresh();
			return result;
		},
		[identity, onLaunchSession, projectId, refresh, locale, version],
	);

	useEffect(
		() =>
			subscribeIssueAssociation((associated) => {
				if (associated === projectId) void refresh();
			}),
		[projectId, refresh],
	);

	const [repositories, setRepositories] = useState<Record<string, IssueRepositoriesView>>({});
	const loadRepositories = useCallback(
		async (issue: IssueSummary) => {
			if (!repositoriesSupported || status !== "connected") return;
			const key = issueKey(issue);
			setRepositories((current) => ({ ...current, [key]: "loading" }));
			try {
				const value = await getTransport().request("issues.repositories", {
					projectId,
					reference: issue.reference,
				});
				setRepositories((current) => ({ ...current, [key]: value }));
			} catch {
				setRepositories((current) => ({ ...current, [key]: "error" }));
			}
		},
		[projectId, repositoriesSupported, status],
	);
	const toggleRepository = useCallback(
		async (issue: IssueSummary, projectIdToToggle: string): Promise<IssueRepositories | null> => {
			const key = issueKey(issue);
			const current = repositories[key];
			if (!current || typeof current !== "object" || current.locked) return null;
			const next = current.projectIds.includes(projectIdToToggle)
				? current.projectIds.filter((id) => id !== projectIdToToggle)
				: [...current.projectIds, projectIdToToggle];
			try {
				const saved = await getTransport().request("issues.setRepositories", {
					projectId,
					reference: issue.reference,
					projectIds: next,
				});
				setRepositories((state) => ({ ...state, [key]: saved }));
				return saved;
			} catch {
				// A rejected write keeps the last confirmed selection instead of pretending it saved.
				return null;
			}
		},
		[projectId, repositories],
	);

	const joinRepository = useCallback(
		async (
			issue: IssueSummary,
			repositoryProjectId: string,
		): Promise<IssueRepositoriesNotice | null> => {
			const key = issueKey(issue);
			try {
				const saved = await getTransport().request(
					"issues.addRepository",
					{ projectId, reference: issue.reference, repositoryProjectId },
					{ timeoutMs: REPOSITORY_JOIN_TIMEOUT_MS },
				);
				setRepositories((state) => ({ ...state, [key]: saved }));
				return null;
			} catch (error) {
				// Only a host refusal (nesting, limit) carries a reason worth showing beside the key.
				return wsErrorCode(error) === "ISSUE_REPOSITORY_REFUSED" && error instanceof Error
					? { kind: "joinFailed", detail: error.message }
					: { kind: "joinFailed" };
			}
		},
		[projectId],
	);
	const cleanupRepositories = useCallback(
		async (issue: IssueSummary): Promise<IssueRepositoriesNotice> => {
			const key = issueKey(issue);
			try {
				const result = await getTransport().request(
					"issues.cleanupRepositories",
					{ projectId, reference: issue.reference },
					{ timeoutMs: REPOSITORY_JOIN_TIMEOUT_MS },
				);
				setRepositories((state) => ({
					...state,
					[key]: { projectIds: result.projectIds, locked: result.locked },
				}));
				return { kind: "cleaned", count: result.removed.length };
			} catch {
				return { kind: "cleanupFailed" };
			}
		},
		[projectId],
	);

	const active = snapshot?.identity === identity ? snapshot : null;
	const activeAction = actionState?.identity === identity ? actionState : null;
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
				actionPending={activeAction?.pending}
				actionProgress={activeAction?.pending ? activeAction.progress : undefined}
				actionError={activeAction?.error}
				actionErrorIssue={activeAction?.progress.issue}
				repositoryProjects={projects}
				primaryProjectId={projectId}
				repositoriesSupported={repositoriesSupported}
				repositoriesFor={(issue) => repositories[issueKey(issue)]}
				onLoadRepositories={(issue) => {
					void loadRepositories(issue);
				}}
				onToggleRepository={toggleRepository}
				onJoinRepository={joinSupported ? joinRepository : undefined}
				onCleanupRepositories={joinSupported ? cleanupRepositories : undefined}
			/>
		</QuietScrollArea>
	);
}
