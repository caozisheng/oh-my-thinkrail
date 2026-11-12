import {
	type RemixiconComponentType,
	RiCodeBoxLine,
	RiEyeLine,
	RiEyeOffLine,
	RiLoader4Line,
	RiLockLine,
	RiQuillPenLine,
} from "@remixicon/react";
import type {
	IssueConnection,
	IssueConnectionInput,
	IssueReference,
	IssueRepositories,
	IssueStage,
	IssueSummary,
} from "@thinkrail/contracts";
import type { MessageKey } from "@thinkrail/locales";
import { useT } from "@thinkrail/locales/react";
import { Button, IconButton } from "@thinkrail/ui/button";
import { TooltipProvider } from "@thinkrail/ui/tooltip";
import { useEffect, useId, useReducer, useRef, useState } from "react";
import type { IssueDisclosure } from "./disclosure";
import { IssueAssociationForm } from "./IssueAssociationForm";
import { IssueBody, type IssuePreview } from "./IssueBody";
import {
	IssueRepositoriesControl,
	type IssueRepositoriesNotice,
	type IssueRepositoriesView,
} from "./IssueRepositoriesControl";
import { issueLabelColors } from "./labelColors";
import {
	associationPanelState,
	type ConnectResult,
	ISSUE_ACTION_KEY,
	ISSUE_ACTION_REASON_KEY,
	ISSUE_ERROR_KEY,
	type IssueActionCapabilities,
	type IssueActionId,
	type IssueActionProgress,
	type IssueActionResult,
	type IssuePanelError,
	issueActions,
	issueKey,
	issueProviderOf,
	reconnectOutcome,
	safeIssueUrl,
	submitDisconnect,
} from "./model";

export interface IssuesPanelProps {
	previewSupported?: boolean;
	preview?: IssuePreview | null;
	initialDisclosure?: IssueDisclosure | undefined;
	onDisclosureChange?: ((value: IssueDisclosure) => void) | undefined;
	onTogglePreview?: (issue: IssueSummary) => void;
	onRetryPreview?: (issue: IssueSummary) => void;
	connection: IssueConnection | null;
	issues: readonly IssueSummary[];
	pending: boolean;
	authSupported: boolean;
	githubSupported: boolean;
	capabilities: IssueActionCapabilities;
	error?: IssuePanelError | undefined;
	onConnect: (input: IssueConnectionInput) => Promise<ConnectResult>;
	onDisconnect: () => Promise<unknown>;
	onRefresh: () => void;
	onOpenIssue?: ((reference: IssueReference) => Promise<void> | void) | undefined;
	onRunAction?:
		| ((issue: IssueSummary, action: IssueActionId) => Promise<IssueActionResult>)
		| undefined;
	actionPending?: boolean | undefined;
	actionProgress?: IssueActionProgress | undefined;
	actionError?: IssuePanelError | null | undefined;
	/** The issue whose last action failed; its row carries the message inline. */
	actionErrorIssue?: string | undefined;
	/** Grants project trust so the host stops refusing stage actions. */
	onTrustProject?: (() => Promise<void> | void) | undefined;
	/** Associated-repository candidates: the open projects, beside the issue's own project. */
	repositoryProjects?: readonly { id: string; name: string }[];
	/** The local project this panel belongs to; excluded from the candidate list. */
	primaryProjectId?: string | undefined;
	/** Present when this host exposes v113 associated repositories. */
	repositoriesSupported?: boolean | undefined;
	repositoriesFor?: ((issue: IssueSummary) => IssueRepositoriesView | undefined) | undefined;
	onLoadRepositories?: ((issue: IssueSummary) => void) | undefined;
	onToggleRepository?:
		| ((issue: IssueSummary, projectId: string) => Promise<IssueRepositories | null>)
		| undefined;
	/** Present when this host joins repositories on demand after implementation starts (v126). */
	onJoinRepository?:
		| ((issue: IssueSummary, projectId: string) => Promise<IssueRepositoriesNotice | null>)
		| undefined;
	onCleanupRepositories?: ((issue: IssueSummary) => Promise<IssueRepositoriesNotice>) | undefined;
}

interface IssueActionRowProps {
	issue: IssueSummary;
	capabilities: IssueActionCapabilities;
	pending: boolean;
	/** Keyed failure raised by this issue's last action, shown beside its own controls. */
	error?: IssuePanelError | null | undefined;
	onRun: (action: IssueActionId) => void;
}

const ACTION_ICON: Record<IssueActionId, RemixiconComponentType> = {
	design: RiQuillPenLine,
	implement: RiCodeBoxLine,
};

/** One issue's stage actions on the title row; a blocked icon names its reason in the tooltip. */
function IssueActionRow({ issue, capabilities, pending, error, onRun }: IssueActionRowProps) {
	const t = useT();
	const actions = issueActions(issue, capabilities);
	if (actions.length === 0) return null;
	return (
		<TooltipProvider>
			<div data-testid="issue-actions" className="flex shrink-0 items-start gap-2">
				{error != null && (
					<span data-testid="issue-action-error" className="text-feedback-error">
						{t(ISSUE_ERROR_KEY[error])}
					</span>
				)}
				{actions.map(({ action, reason, done }) => {
					const label = t(ISSUE_ACTION_KEY[action]);
					const hint = capabilities.startupSupported === false ? t("mcp.action.openChat") : label;
					return (
						<IconButton
							key={action}
							size="s"
							variant={done ? "soft-primary" : "ghost"}
							icon={ACTION_ICON[action]}
							label={label}
							tooltip={reason === null ? hint : `${label} — ${t(ISSUE_ACTION_REASON_KEY[reason])}`}
							data-testid={`issue-action-${action}`}
							data-reason={reason ?? undefined}
							data-done={done ? "true" : undefined}
							data-disabled={reason !== null ? "true" : undefined}
							disabled={pending || reason !== null}
							onClick={() => {
								if (reason === null) onRun(action);
							}}
						/>
					);
				})}
			</div>
		</TooltipProvider>
	);
}

const PROVIDER_KEY = {
	github: "issues.provider.github",
	gitlab: "issues.provider.gitlab",
} as const;

const stages: IssueStage[] = ["backlog", "in-progress", "in-review", "closed"];
const STAGE_KEY = {
	backlog: "issues.stage.backlog",
	"in-progress": "issues.stage.in-progress",
	"in-review": "issues.stage.in-review",
	closed: "issues.stage.closed",
} as const satisfies Record<IssueStage, MessageKey>;

export function IssuesPanel({
	connection,
	issues,
	pending,
	authSupported,
	githubSupported,
	capabilities,
	error,
	onConnect,
	onDisconnect,
	onRefresh,
	onOpenIssue,
	onRunAction,
	actionPending,
	actionProgress,
	actionError,
	actionErrorIssue,
	onTrustProject,
	repositoryProjects,
	primaryProjectId,
	repositoriesSupported,
	repositoriesFor,
	onLoadRepositories,
	onToggleRepository,
	onJoinRepository,
	onCleanupRepositories,
	previewSupported,
	preview,
	initialDisclosure,
	onDisclosureChange,
	onTogglePreview,
	onRetryPreview,
}: IssuesPanelProps) {
	const t = useT();
	const previewId = useId();
	const [state, dispatch] = useReducer(reconnectOutcome, error ?? null, associationPanelState);
	const { reconnecting, snapshotError } = state;
	const trustLock = useRef(false);
	const [trustPending, setTrustPending] = useState(false);
	const [expanded, setExpanded] = useState<IssueDisclosure>(
		initialDisclosure ?? {
			backlog: true,
			"in-progress": true,
			"in-review": true,
			closed: true,
		},
	);
	const showForm = !connection?.connected || reconnecting;
	const provider = connection ? issueProviderOf(connection.instanceUrl) : null;
	const failure = actionError ?? state.actionError ?? snapshotError;

	useEffect(() => {
		if (!pending) dispatch({ type: "snapshotLanded", error: error ?? null });
	}, [error, pending]);

	useEffect(() => {
		if (initialDisclosure) setExpanded(initialDisclosure);
	}, [initialDisclosure]);

	const refresh = () => {
		dispatch({ type: "clearActionError" });
		onRefresh();
	};

	const connect = async (input: IssueConnectionInput) => {
		dispatch({ type: "clearActionError" });
		const result = await onConnect(input);
		dispatch(
			result.ok ? { type: "connectSucceeded" } : { type: "connectFailed", error: result.error },
		);
		return result;
	};

	const run = (issue: IssueSummary, action: IssueActionId) => {
		dispatch({ type: "clearActionError" });
		void onRunAction?.(issue, action);
	};

	const disconnect = () => {
		dispatch({ type: "clearActionError" });
		void submitDisconnect(onDisconnect).then((ok) => {
			dispatch(ok ? { type: "clearActionError" } : { type: "actionFailed", error: "disconnect" });
		});
	};

	return (
		<div className="flex flex-col gap-12 p-panel-inset tr-text-ui">
			{failure && (
				<p role="alert" data-testid="issues-error" className="break-words text-feedback-error">
					{t(ISSUE_ERROR_KEY[failure])}
				</p>
			)}
			<div className="flex flex-wrap items-center gap-8">
				<Button variant="ghost" size="s" disabled={pending} onClick={refresh}>
					{t("issues.refresh")}
				</Button>
				{connection && (
					<Button
						variant="ghost"
						size="s"
						tone="danger"
						data-testid="issues-disconnect"
						disabled={pending}
						onClick={disconnect}
					>
						{t("issues.disconnect")}
					</Button>
				)}
				{connection?.connected && authSupported && !reconnecting && (
					<Button
						variant="ghost"
						size="s"
						data-testid="issues-reconnect"
						onClick={() => dispatch({ type: "startReconnect" })}
					>
						{t("issues.reconnect")}
					</Button>
				)}
			</div>
			{pending && (
				<p role="status" className="text-text-muted">
					{t("common.loading")}
				</p>
			)}
			{connection && (
				<div className="flex flex-col gap-4">
					{(connection.connected || authSupported) && (
						<p data-testid="issues-state" className="break-words text-text-muted">
							{connection.connected && provider
								? t("issues.connectedTo", { provider: t(PROVIDER_KEY[provider]) })
								: connection.connected
									? t("issues.connected")
									: t("issues.reconnectHint")}
						</p>
					)}
					<p className="break-words text-text-muted">
						{connection.instanceUrl} · {connection.remoteProjectId}
					</p>
				</div>
			)}
			{!authSupported && (
				<p data-testid="issues-auth-unsupported" className="text-feedback-warning">
					{t("issues.authUnsupported")}
				</p>
			)}
			{showForm && (
				<IssueAssociationForm
					connection={connection}
					pending={pending}
					authSupported={authSupported}
					githubSupported={githubSupported}
					onConnect={connect}
					onError={(connectError) =>
						dispatch(
							connectError
								? { type: "connectFailed", error: connectError }
								: { type: "clearActionError" },
						)
					}
					{...(connection?.connected && reconnecting
						? { onCancelReconnect: () => dispatch({ type: "cancelReconnect" }) }
						: {})}
				/>
			)}
			{connection?.connected && !capabilities.trusted && (
				<Button
					size="s"
					variant="outline"
					data-testid="issues-trust"
					disabled={pending || trustPending || !onTrustProject}
					onClick={() => {
						if (trustLock.current || !onTrustProject) return;
						trustLock.current = true;
						setTrustPending(true);
						void Promise.resolve()
							.then(onTrustProject)
							.catch(() => {})
							.finally(() => {
								trustLock.current = false;
								setTrustPending(false);
							});
					}}
				>
					{t("issues.trustAction")}
				</Button>
			)}
			{capabilities.trusted &&
				!pending &&
				!failure &&
				connection?.connected &&
				issues.length === 0 && <p className="text-text-muted">{t("issues.empty")}</p>}
			{capabilities.trusted &&
				stages.map((stage) => {
					const sectionId = `${previewId}-${stage}`;
					const stageIssues = issues.filter((issue) => issue.stage === stage);
					return (
						<section key={stage} className="flex flex-col gap-8" aria-label={t(STAGE_KEY[stage])}>
							<h3 className="text-text-muted tr-text-ui">
								<Button
									size="s"
									variant="ghost"
									aria-expanded={expanded[stage]}
									aria-controls={sectionId}
									aria-label={t(expanded[stage] ? "issues.collapseStage" : "issues.expandStage", {
										stage: t(STAGE_KEY[stage]),
									})}
									data-testid={`issue-stage-${stage}`}
									onClick={() => {
										const next = { ...expanded, [stage]: !expanded[stage] };
										setExpanded(next);
										onDisclosureChange?.(next);
									}}
								>
									{expanded[stage] ? "⌄" : "›"} {t(STAGE_KEY[stage])} · {stageIssues.length}
								</Button>
							</h3>
							<div id={sectionId} hidden={!expanded[stage]} className="flex flex-col gap-8">
								{stageIssues.map((issue) => {
									const repositoryView = repositoriesFor?.(issue);
									const labelColors = issueLabelColors(issue.labelColors, issue.labels);
									return (
										<article
											key={issueKey(issue)}
											className="flex flex-col gap-4 rounded-sm border border-border-muted p-8"
										>
											<div className="flex items-start gap-6">
												<div className="min-w-0 flex-1 break-words">
													<a
														href={safeIssueUrl(issue.url)}
														target="_blank"
														rel="noopener noreferrer"
														className="text-primary"
													>
														#{issue.reference.number} {issue.title}
													</a>
													{typeof repositoryView === "object" && repositoryView.blocked && (
														<TooltipProvider>
															<IconButton
																icon={RiLockLine}
																size="s"
																variant="ghost"
																label={t("issues.error.launchBlocked")}
																data-testid="issue-lock"
																className="ml-4 align-middle"
															/>
														</TooltipProvider>
													)}
												</div>
												{onTogglePreview && (
													<TooltipProvider>
														<IconButton
															size="s"
															icon={preview?.key === issueKey(issue) ? RiEyeOffLine : RiEyeLine}
															variant={preview?.key === issueKey(issue) ? "soft-primary" : "ghost"}
															label={t(
																preview?.key === issueKey(issue)
																	? "issues.previewClose"
																	: "issues.previewOpen",
															)}
															tooltip={t(
																previewSupported
																	? preview?.key === issueKey(issue)
																		? "issues.previewClose"
																		: "issues.previewOpen"
																	: "issues.previewUnsupported",
															)}
															disabled={!previewSupported || pending}
															aria-expanded={preview?.key === issueKey(issue)}
															aria-controls={
																preview?.key === issueKey(issue) ? previewId : undefined
															}
															data-testid="issue-preview-toggle"
															onClick={() => onTogglePreview(issue)}
														/>
													</TooltipProvider>
												)}
												{repositoriesSupported &&
													primaryProjectId &&
													repositoryProjects &&
													onToggleRepository && (
														<TooltipProvider>
															<IssueRepositoriesControl
																issue={issue}
																primaryProjectId={primaryProjectId}
																projects={repositoryProjects}
																view={repositoriesFor?.(issue)}
																disabled={pending || actionPending === true}
																onOpen={() => onLoadRepositories?.(issue)}
																onToggle={(projectId) => {
																	void onToggleRepository(issue, projectId);
																}}
																onJoin={
																	onJoinRepository
																		? (projectId) => onJoinRepository(issue, projectId)
																		: undefined
																}
																onCleanup={
																	onCleanupRepositories
																		? () => onCleanupRepositories(issue)
																		: undefined
																}
															/>
														</TooltipProvider>
													)}
												{onRunAction && (
													<IssueActionRow
														issue={issue}
														capabilities={capabilities}
														pending={actionPending === true}
														error={actionErrorIssue === issueKey(issue) ? actionError : null}
														onRun={(action) => run(issue, action)}
													/>
												)}
											</div>
											{actionProgress?.issue === issueKey(issue) && (
												<p
													role="status"
													data-testid="issue-action-progress"
													className="flex items-center gap-4 text-text-muted"
												>
													<RiLoader4Line
														aria-hidden="true"
														className="size-14 shrink-0 motion-safe:animate-spin"
													/>
													{t(
														actionProgress.phase === "opening"
															? "issues.progress.opening"
															: actionProgress.action === "design"
																? "issues.progress.design"
																: "issues.progress.implement",
													)}
												</p>
											)}
											{preview?.key === issueKey(issue) && onTogglePreview && (
												<IssueBody
													id={previewId}
													preview={preview}
													onRetry={() => onRetryPreview?.(issue)}
												/>
											)}
											{issue.labels.length > 0 && (
												<div className="flex max-w-full flex-wrap gap-4" data-testid="issue-labels">
													{issue.labels.map((label, index) => {
														const style = labelColors[label];
														return (
															<span
																key={`${label}-${index}`}
																data-testid="issue-label"
																className={`max-w-full overflow-wrap-anywhere rounded-issue-pill bg-container-elevated-bg px-8 py-2 text-text-default tr-text-metadata${style ? " issue-provider-label" : ""}`}
																ref={(element) => {
																	if (!element || !style) return;
																	element.style.setProperty(
																		"--issue-label-background",
																		style.background,
																	);
																	element.style.setProperty(
																		"--issue-label-foreground",
																		style.foreground,
																	);
																}}
															>
																{label}
															</span>
														);
													})}
												</div>
											)}
											{onOpenIssue && (
												<Button
													size="s"
													variant="ghost"
													disabled={pending}
													onClick={() => {
														dispatch({ type: "clearActionError" });
														void Promise.resolve()
															.then(() => onOpenIssue(issue.reference))
															.catch(() => dispatch({ type: "actionFailed", error: "open" }));
													}}
												>
													{t("issues.open")}
												</Button>
											)}
										</article>
									);
								})}
							</div>
						</section>
					);
				})}
		</div>
	);
}
