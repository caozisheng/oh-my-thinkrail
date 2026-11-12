import type {
	IssueConnectionInput,
	IssueImplementationRecovery,
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
import { selectIssueRepositoryProjects, useAppStore } from "../store";
import { getTransport, transportEndpointIdentity, wsErrorCode } from "../transport";
import {
	expandedIssueDisclosure,
	issueDisclosureKey,
	readIssueDisclosure,
	writeIssueDisclosure,
} from "./disclosure";
import type { IssuePreview } from "./IssueBody";
import { IssueHistoryDialog } from "./IssueHistoryDialog";
import { IssueRecoveryDialog } from "./IssueRecoveryDialog";
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
	supportsIssueWorkspaceRecovery,
} from "./model";
import { loadIssueRepositories } from "./repositoryReads";

type SnapshotPatch = Partial<Omit<IssueToolSnapshot, "identity">>;

function implementationRecoveryRequest(
	projectId: string,
	reference: IssueReference,
): Promise<
	{ diagnosis: IssueImplementationRecovery; failed: false } | { diagnosis: null; failed: true }
> {
	return getTransport()
		.request("issues.implementationRecovery", { projectId, reference })
		.then((diagnosis) => ({ diagnosis, failed: false as const }))
		.catch(() => ({ diagnosis: null, failed: true as const }));
}

function failedRepositorySelection(
	selection: IssueRepositoriesView & object,
	blocked: boolean,
): IssueRepositoriesView {
	return { ...selection, pending: false, blocked: selection.blocked || blocked };
}

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
	onTrustProject?: () => Promise<void> | void;
}) {
	const t = useT();
	const [recovery, setRecovery] = useState<{
		identity: string;
		issue: IssueSummary;
		diagnosis: IssueImplementationRecovery;
	} | null>(null);
	const [recovering, setRecovering] = useState(false);
	const [historyIssue, setHistoryIssue] = useState<{
		identity: string;
		issue: IssueSummary;
	} | null>(null);
	const localLocales = useAppStore((s) => s.localLocales);
	const locale = issueStartupLocale(localeOf(t), availableLocales(localLocales));
	const version = useAppStore((s) => s.protocolVersion);
	const status = useAppStore((s) => s.status);
	const generation = useAppStore((s) => s.connectionGeneration);
	const supported = supportsIssues(version);
	const authSupported = supportsIssueAuth(version);
	const githubSupported = supportsIssueGithub(version);
	const trusted = useAppStore((s) => s.projects.find((p) => p.id === projectId)?.trusted === true);
	const projects = useAppStore(useShallow(selectIssueRepositoryProjects));
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
	const identity = `${projectId}:${generation}:${status}:${supported}:${authSupported}:${trusted}`;
	const [snapshot, setSnapshot] = useState<IssueToolSnapshot | null>(null);
	const disclosureIdentity = snapshot?.connection
		? issueDisclosureKey({
				endpoint: transportEndpointIdentity(),
				instanceUrl: snapshot.connection.instanceUrl,
				projectId,
				remoteProjectId: snapshot.connection.remoteProjectId,
			})
		: null;
	const [disclosureState, setDisclosureState] = useState<{
		key: string | null;
		value: ReturnType<typeof expandedIssueDisclosure>;
	}>(() => ({ key: null, value: expandedIssueDisclosure() }));
	useEffect(() => {
		if (!disclosureIdentity) {
			setDisclosureState({ key: null, value: expandedIssueDisclosure() });
			return;
		}
		let value: ReturnType<typeof expandedIssueDisclosure>;
		try {
			value = readIssueDisclosure(window.localStorage, disclosureIdentity);
		} catch {
			value = expandedIssueDisclosure();
		}
		setDisclosureState({ key: disclosureIdentity, value });
	}, [disclosureIdentity]);
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
		if (!trusted || !previewSupported || status !== "connected") return;
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

	const [repositories, setRepositories] = useState<Record<string, IssueRepositoriesView>>({});
	const repositorySequences = useRef(new Map<string, number>());
	const repositoryKey = useCallback(
		(issue: IssueSummary) => `${identity}:${issueKey(issue)}`,
		[identity],
	);
	const loadRepositories = useCallback(
		async (issues: readonly IssueSummary[], current: () => boolean) => {
			if (!trusted || !repositoriesSupported || status !== "connected") return;
			const sequences = new Map<string, number>();
			for (const issue of issues) {
				const key = repositoryKey(issue);
				const sequence = (repositorySequences.current.get(key) ?? 0) + 1;
				repositorySequences.current.set(key, sequence);
				sequences.set(key, sequence);
			}
			setRepositories((state) => {
				const next = { ...state };
				for (const key of sequences.keys()) {
					const saved = next[key];
					next[key] =
						typeof saved === "object" ? { ...saved, pending: true, failed: false } : "loading";
				}
				return next;
			});
			await loadIssueRepositories(
				issues,
				(issue) =>
					getTransport().request("issues.repositories", { projectId, reference: issue.reference }),
				current,
				(issue, value) => {
					const key = repositoryKey(issue);
					if (repositorySequences.current.get(key) !== sequences.get(key)) return;
					setRepositories((state) => {
						const saved = state[key];
						const next =
							value === "error" && typeof saved === "object"
								? { ...saved, pending: false, failed: true }
								: value === "blocked"
									? {
											...(typeof saved === "object" ? saved : { projectIds: [], locked: false }),
											blocked: true,
											pending: false,
											failed: true,
										}
									: value;
						return { ...state, [key]: next };
					});
				},
			);
		},
		[trusted, projectId, repositoriesSupported, status, repositoryKey],
	);

	const refresh = useCallback(
		async (input?: IssueConnectionInput): Promise<ConnectResult> => {
			if (!supported || status !== "connected") return { ok: false, error: "connect" };
			clearPreview();
			actionSequence.current++;
			actionLock.current = false;
			setActionState(null);
			const sequence = ++requestSequence.current;
			const current = () =>
				sequence === requestSequence.current &&
				useAppStore.getState().connectionGeneration === generation &&
				useAppStore.getState().status === "connected" &&
				(useAppStore.getState().projects.find((p) => p.id === projectId)?.trusted === true) ===
					trusted;
			setSnapshot((previous) => update(previous, { pending: true, error: null }));
			const transport = getTransport();
			const result = await loadIssueSnapshot(
				{
					connection: () => transport.request("issues.connection", { projectId }),
					...(input
						? { connect: () => transport.request("issues.connect", { projectId, input }) }
						: {}),
					list: () => transport.request("issues.list", { projectId }),
					trusted,
				},
				current,
			);
			if (!result || !current()) return { ok: false, error: "connect" };
			setSnapshot((previous) => issueSnapshotAfterLoad(previous, identity, result));
			if (!result.error) void loadRepositories(result.issues, current);
			return result.error === "connect" ? { ok: false, error: "connect" } : { ok: true };
		},
		[
			identity,
			trusted,
			generation,
			projectId,
			status,
			supported,
			update,
			clearPreview,
			loadRepositories,
		],
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
			if (!trusted || status !== "connected" || actionLock.current)
				return { ok: false, error: "launch-blocked" };
			if (action === "implement" && supportsIssueWorkspaceRecovery(version)) {
				actionLock.current = true;
				const sequence = ++actionSequence.current;
				setActionState({
					identity,
					pending: true,
					progress: { issue: issueKey(issue), action, phase: "starting" },
					error: null,
				});
				const response = await implementationRecoveryRequest(projectId, issue.reference);
				if (response.failed) {
					actionLock.current = false;
					setActionState({
						identity,
						pending: false,
						error: "action",
						progress: { issue: issueKey(issue), action, phase: "starting" },
					});
					return { ok: false, error: "action" };
				}
				const diagnosis = response.diagnosis;
				if (sequence !== actionSequence.current || !trusted || status !== "connected") {
					actionLock.current = false;
					setActionState(null);
					return { ok: false, error: "launch-blocked" };
				}
				if (diagnosis.status === "available" || diagnosis.reason !== "missing-record") {
					actionLock.current = false;
					setActionState(null);
					setRecovery({ identity, issue, diagnosis });
					return { ok: true, confirmationPending: true };
				}
				actionLock.current = false;
				setActionState(null);
			}
			actionLock.current = true;
			const sequence = ++actionSequence.current;
			const current = () =>
				sequence === actionSequence.current &&
				useAppStore.getState().connectionGeneration === generation &&
				useAppStore.getState().status === "connected" &&
				useAppStore.getState().projects.find((p) => p.id === projectId)?.trusted === true;
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
		[identity, trusted, generation, status, onLaunchSession, projectId, refresh, locale, version],
	);

	useEffect(
		() =>
			subscribeIssueAssociation((associated) => {
				if (associated === projectId) void refresh();
			}),
		[projectId, refresh],
	);

	const toggleRepository = useCallback(
		async (issue: IssueSummary, projectIdToToggle: string): Promise<IssueRepositories | null> => {
			const key = repositoryKey(issue);
			const selection = repositories[key];
			if (
				!trusted ||
				status !== "connected" ||
				!selection ||
				typeof selection !== "object" ||
				selection.locked ||
				selection.pending ||
				selection.failed
			)
				return null;
			const next = selection.projectIds.includes(projectIdToToggle)
				? selection.projectIds.filter((id) => id !== projectIdToToggle)
				: [...selection.projectIds, projectIdToToggle];
			const sequence = (repositorySequences.current.get(key) ?? 0) + 1;
			repositorySequences.current.set(key, sequence);
			const request = requestSequence.current;
			setRepositories((state) => ({ ...state, [key]: { ...selection, pending: true } }));
			try {
				const saved = await getTransport().request("issues.setRepositories", {
					projectId,
					reference: issue.reference,
					projectIds: next,
				});
				if (request !== requestSequence.current) return null;
				if (repositorySequences.current.get(key) !== sequence) return null;
				setRepositories((state) => ({ ...state, [key]: saved }));
				return saved;
			} catch (error) {
				const locked = wsErrorCode(error) === "ISSUE_LAUNCH_BLOCKED";
				if (request !== requestSequence.current) return null;
				if (repositorySequences.current.get(key) !== sequence) return null;
				setRepositories((state) => ({
					...state,
					[key]: failedRepositorySelection(selection, locked),
				}));
				return null;
			}
		},
		[trusted, status, projectId, repositories, repositoryKey],
	);

	const joinRepository = useCallback(
		async (
			issue: IssueSummary,
			repositoryProjectId: string,
		): Promise<IssueRepositoriesNotice | null> => {
			if (!trusted || status !== "connected") return { kind: "joinFailed" };
			const key = repositoryKey(issue);
			const request = requestSequence.current;
			repositorySequences.current.set(key, (repositorySequences.current.get(key) ?? 0) + 1);
			try {
				const saved = await getTransport().request(
					"issues.addRepository",
					{ projectId, reference: issue.reference, repositoryProjectId },
					{ timeoutMs: REPOSITORY_JOIN_TIMEOUT_MS },
				);
				if (request === requestSequence.current)
					setRepositories((state) => ({ ...state, [key]: saved }));
				return null;
			} catch (error) {
				// Only a host refusal (nesting, limit) carries a reason worth showing beside the key.
				return wsErrorCode(error) === "ISSUE_REPOSITORY_REFUSED" && error instanceof Error
					? { kind: "joinFailed", detail: error.message }
					: { kind: "joinFailed" };
			}
		},
		[trusted, status, projectId, repositoryKey],
	);
	const cleanupRepositories = useCallback(
		async (issue: IssueSummary): Promise<IssueRepositoriesNotice> => {
			if (!trusted || status !== "connected") return { kind: "cleanupFailed" };
			const key = repositoryKey(issue);
			const request = requestSequence.current;
			repositorySequences.current.set(key, (repositorySequences.current.get(key) ?? 0) + 1);
			try {
				const result = await getTransport().request(
					"issues.cleanupRepositories",
					{ projectId, reference: issue.reference },
					{ timeoutMs: REPOSITORY_JOIN_TIMEOUT_MS },
				);
				if (request === requestSequence.current)
					setRepositories((state) => ({
						...state,
						[key]: { projectIds: result.projectIds, locked: result.locked },
					}));
				return { kind: "cleaned", count: result.removed.length };
			} catch {
				return { kind: "cleanupFailed" };
			}
		},
		[trusted, status, projectId, repositoryKey],
	);

	const active = snapshot?.identity === identity ? snapshot : null;
	const activeAction = actionState?.identity === identity ? actionState : null;
	if (!supported)
		return <p className="p-panel-inset text-text-muted tr-text-ui">{t("issues.unsupported")}</p>;
	if (status !== "connected")
		return <p className="p-panel-inset text-text-muted tr-text-ui">{t("issues.offline")}</p>;
	return (
		<QuietScrollArea className="h-full">
			{historyIssue?.identity === identity && trusted && (
				<IssueHistoryDialog
					projectId={projectId}
					reference={historyIssue.issue.reference}
					onClose={() => setHistoryIssue(null)}
				/>
			)}
			{recovery?.identity === identity && (
				<IssueRecoveryDialog
					diagnosis={recovery.diagnosis}
					pending={recovering}
					onClose={() => setRecovery(null)}
					onConfirm={(restart) => {
						setRecovering(true);
						const captured = recovery;
						const recoveryActionSequence = ++actionSequence.current;
						const current = () =>
							recoveryActionSequence === actionSequence.current &&
							useAppStore.getState().connectionGeneration === generation &&
							useAppStore.getState().status === "connected" &&
							useAppStore.getState().protocolVersion === version &&
							useAppStore.getState().projects.find((row) => row.id === projectId)?.trusted === true;
						void getTransport()
							.request(
								"issues.recoverImplementation",
								{
									projectId,
									reference: captured.issue.reference,
									locale,
									snapshot: captured.diagnosis.snapshot,
									restart,
								},
								{ timeoutMs: REPOSITORY_JOIN_TIMEOUT_MS },
							)
							.then(async (launch) => {
								if (current()) {
									setRecovery(null);
									await onLaunchSession?.(launch, current);
									void refresh();
								}
							})
							.catch(() => {
								if (current()) {
									setRecovery(null);
									setActionState({
										identity,
										pending: false,
										error: "action",
										progress: {
											issue: issueKey(captured.issue),
											action: "implement",
											phase: "starting",
										},
									});
								}
							})
							.finally(() => setRecovering(false));
					}}
				/>
			)}
			<IssuesPanel
				key={`${identity}:${active?.connection?.connected === true}`}
				previewSupported={previewSupported}
				preview={activePreview}
				initialDisclosure={
					disclosureState.key === disclosureIdentity
						? disclosureState.value
						: expandedIssueDisclosure()
				}
				onDisclosureChange={(value) => {
					if (!disclosureIdentity || disclosureState.key !== disclosureIdentity) return;
					setDisclosureState({ key: disclosureIdentity, value });
					writeIssueDisclosure(window.localStorage, disclosureIdentity, value);
				}}
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
				historySupported={supportsIssueWorkspaceRecovery(version)}
				onOpenHistory={(issue) => setHistoryIssue({ identity, issue })}
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
				repositoriesFor={(issue) => repositories[repositoryKey(issue)]}
				onLoadRepositories={(issue) => {
					const sequence = requestSequence.current;
					void loadRepositories([issue], () => sequence === requestSequence.current);
				}}
				onToggleRepository={toggleRepository}
				onJoinRepository={joinSupported ? joinRepository : undefined}
				onCleanupRepositories={joinSupported ? cleanupRepositories : undefined}
			/>
		</QuietScrollArea>
	);
}
