import {
	RiAlertLine,
	RiArrowDownLine,
	RiArrowDownSLine,
	RiArrowRightSLine,
	RiArrowUpLine,
	RiDeleteBin6Line,
	RiDownloadCloud2Line,
	RiEditLine,
	RiGitBranchLine,
	RiGitCommitLine,
	RiGitRepositoryLine,
	RiRefreshLine,
	RiSearchLine,
	RiStackLine,
	RiUploadCloud2Line,
} from "@remixicon/react";
import type {
	Project,
	ProjectGroupFetchResult,
	ProjectGroupIssue,
	ProjectGroupIssueRepository,
	ProjectGroupRepositoryStatus,
	ProjectGroupStatus,
} from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@thinkrail/ui/dialog";
import { LoadingRegion } from "@thinkrail/ui/skeleton";
import { cn } from "@thinkrail/ui/utils";
import { useEffect, useState } from "react";
import { toast, useAppStore } from "../store";
import { errorText, getTransport } from "../transport";
import {
	issueKey,
	issueTotals,
	MAIN_BEHIND_WARNING,
	mainCheckoutWarnings,
	persistExpandedIssues,
	readExpandedIssues,
	repositoryState,
} from "./groupHomeModel";
import { useOpenProject } from "./useOpenProject";
import { goToProjectHome, loadProjectWorkspaces } from "./workspaceActions";

const CHIP_CLASS = "shrink-0 rounded-full border px-4 leading-tight whitespace-nowrap";

async function openIssueWorkspace(projectId: string, workspaceId: string): Promise<void> {
	const rows = await loadProjectWorkspaces(projectId);
	const workspace = rows.find((row) => row.id === workspaceId);
	if (!workspace) throw new Error(workspaceId);
	useAppStore.getState().activateWorkspace(workspace);
}

/**
 * The group home: one imported folder's started Issues (what each changed in its worktrees), a notice
 * only when a member's main checkout needs attention, and the group actions. The rail browses repos.
 */
export function ProjectGroupHome({ groupId }: { groupId: string }) {
	const t = useT();
	const allProjects = useAppStore((s) => s.projects);
	const members = allProjects.filter((project) => project.projectGroup?.id === groupId);
	const group = members[0]?.projectGroup;
	const membershipKey = members
		.map((project) => `${project.id}:${project.projectGroup?.path}`)
		.join("|");
	const [loaded, setLoaded] = useState<{ key: string; status: ProjectGroupStatus } | null>(null);
	const [statusError, setStatusError] = useState<string | null>(null);
	const [generation, setGeneration] = useState(0);
	const [fetching, setFetching] = useState(false);
	const [fetchResults, setFetchResults] = useState<ProjectGroupFetchResult[] | null>(null);
	const [removeOpen, setRemoveOpen] = useState(false);
	const [removing, setRemoving] = useState(false);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => readExpandedIssues());
	const { rescanGroup, dialogs } = useOpenProject(() => {});

	const requestKey = `${groupId}\n${membershipKey}\n${generation}`;
	useEffect(() => {
		let cancelled = false;
		setStatusError(null);
		getTransport()
			.request("project.groupStatus", { groupId })
			.then((status) => {
				if (!cancelled) setLoaded({ key: requestKey, status });
			})
			.catch((err) => {
				if (!cancelled) setStatusError(errorText(err, t("panels.groupHome.statusFailed")));
			});
		return () => {
			cancelled = true;
		};
	}, [groupId, requestKey, t]);

	if (!group) return null;
	const status = loaded?.status.id === groupId ? loaded.status : null;
	const projectById = new Map(members.map((project) => [project.id, project]));
	const refresh = () => setGeneration((value) => value + 1);

	const fetchAll = () => {
		setFetching(true);
		void getTransport()
			.request("project.fetchGroup", { groupId }, { timeoutMs: 180_000 })
			.then(({ results }) => {
				setFetchResults(results);
				refresh();
			})
			.catch((err) => toast.error(errorText(err, t("panels.groupHome.fetchFailed"))))
			.then(() => setFetching(false));
	};

	const removeGroup = (close: boolean) => {
		setRemoving(true);
		void getTransport()
			.request("project.removeGroup", { groupId, close })
			.then(({ projects }) => {
				const store = useAppStore.getState();
				for (const project of projects) store.applyProjectUpdated(project);
				setRemoving(false);
				setRemoveOpen(false);
				store.selectMain();
			})
			.catch((err) => {
				setRemoving(false);
				toast.error(errorText(err, t("panels.groupHome.removeFailed")));
			});
	};

	const toggleIssue = (key: string) => {
		const next = new Set(expanded);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		setExpanded(next);
		persistExpandedIssues(next);
	};

	const openWorkspace = (projectId: string, workspaceId: string) => {
		void openIssueWorkspace(projectId, workspaceId).catch(() =>
			toast.error(t("panels.groupHome.workspaceMissing")),
		);
	};

	return (
		<div
			data-testid="project-group-home"
			data-group={groupId}
			className="flex h-full min-h-0 flex-col overflow-auto px-24 py-24"
		>
			<div className="mx-auto flex w-full max-w-[760px] flex-col gap-24">
				<header className="flex flex-col gap-8">
					<div className="flex min-w-0 items-center gap-8">
						<RiStackLine className="size-24 shrink-0 text-primary" aria-hidden="true" />
						<h1
							data-testid="project-group-home-title"
							className="min-w-0 truncate tr-title-entity text-text-default"
						>
							{group.name}
						</h1>
					</div>
					<p className="truncate tr-code-text text-text-muted" title={group.root}>
						{group.root}
					</p>
					<p className="tr-text-metadata text-text-subtle">
						{t("panels.groupHome.summary", {
							count: members.length,
							issues: status?.issues.length ?? 0,
						})}
					</p>
					<div className="mt-4 flex flex-wrap gap-8">
						{rescanGroup ? (
							<Button
								variant="outline"
								size="m"
								iconLeft={RiSearchLine}
								data-testid="group-home-rescan"
								onClick={() => rescanGroup(group.root)}
							>
								{t("panels.groupHome.rescan")}
							</Button>
						) : null}
						<Button
							variant="outline"
							size="m"
							iconLeft={RiDownloadCloud2Line}
							loading={fetching}
							data-testid="group-home-fetch"
							onClick={fetchAll}
						>
							{fetching ? t("panels.groupHome.fetching") : t("panels.groupHome.fetchAll")}
						</Button>
						<Button
							variant="ghost"
							size="m"
							iconLeft={RiRefreshLine}
							data-testid="group-home-refresh"
							onClick={refresh}
						>
							{t("panels.groupHome.refresh")}
						</Button>
						<Button
							variant="outline"
							tone="danger"
							size="m"
							iconLeft={RiDeleteBin6Line}
							data-testid="group-home-remove"
							onClick={() => setRemoveOpen(true)}
						>
							{t("panels.groupHome.remove")}
						</Button>
					</div>
				</header>

				{fetchResults ? (
					<FetchResults
						results={fetchResults}
						projectById={projectById}
						onDismiss={() => setFetchResults(null)}
					/>
				) : null}

				{status ? (
					<MainCheckoutNotice repositories={status.repositories} projectById={projectById} />
				) : null}

				<section className="flex flex-col gap-8" aria-labelledby="group-home-issues">
					<div className="flex flex-col gap-2">
						<h2 id="group-home-issues" className="tr-title-section text-text-default">
							{t("panels.groupHome.issues")}
						</h2>
						<p className="tr-text-metadata text-text-subtle">{t("panels.groupHome.issuesHint")}</p>
					</div>
					{statusError ? (
						<p role="alert" className="tr-text-ui text-feedback-error">
							{statusError}
						</p>
					) : null}
					{status === null && !statusError ? (
						<LoadingRegion rows={2} className="py-4" />
					) : (status?.issues.length ?? 0) === 0 ? (
						<p className="tr-text-metadata text-text-muted">{t("panels.groupHome.noIssues")}</p>
					) : (
						<GroupIssueList
							groupId={groupId}
							issues={status?.issues ?? []}
							projectById={projectById}
							expanded={expanded}
							onToggle={toggleIssue}
							onOpen={openWorkspace}
						/>
					)}
				</section>
			</div>

			<Dialog open={removeOpen} onOpenChange={(open) => !removing && setRemoveOpen(open)}>
				<DialogContent
					role="alertdialog"
					className="max-w-[28rem]"
					data-testid="group-remove-dialog"
				>
					<DialogHeader>
						<DialogTitle>{t("panels.groupHome.removeTitle", { name: group.name })}</DialogTitle>
						<DialogDescription>{t("panels.groupHome.removeDescription")}</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="ghost" disabled={removing} onClick={() => setRemoveOpen(false)}>
							{t("common.cancel")}
						</Button>
						<Button
							variant="outline"
							tone="danger"
							disabled={removing}
							data-testid="group-remove-ungroup"
							onClick={() => removeGroup(false)}
						>
							{t("panels.groupHome.ungroup")}
						</Button>
						<Button
							variant="destructive"
							disabled={removing}
							data-testid="group-remove-close"
							onClick={() => removeGroup(true)}
						>
							{t("panels.groupHome.ungroupAndClose")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			{dialogs}
		</div>
	);
}

function repositoryLabel(
	repository: { projectId: string; path?: string },
	projectById: ReadonlyMap<string, Project>,
): string {
	const project = projectById.get(repository.projectId);
	const path = repository.path ?? project?.projectGroup?.path;
	if (path) return path;
	// The group folder itself, when it is a repository, is an ordinary member labelled like the rail.
	return path === "" ? "." : (project?.name ?? repository.projectId);
}

/** One line per kind of trouble in members' main checkouts (Default workspaces); nothing when fine. */
export function MainCheckoutNotice({
	repositories,
	projectById,
}: {
	repositories: readonly ProjectGroupRepositoryStatus[];
	projectById: ReadonlyMap<string, Project>;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const { dirty, behind } = mainCheckoutWarnings(repositories);
	if (dirty.length === 0 && behind.length === 0) return null;
	const names = (rows: readonly ProjectGroupRepositoryStatus[]) =>
		rows.map((row) => repositoryLabel(row, projectById)).join(t("panels.groupHome.listSeparator"));
	const Chevron = open ? RiArrowDownSLine : RiArrowRightSLine;
	return (
		<section
			data-testid="group-home-main-notice"
			className="flex flex-col gap-4 rounded-sm border border-feedback-warning-muted bg-container-elevated-bg px-12 py-8"
		>
			<button
				type="button"
				data-testid="group-home-main-notice-toggle"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				className="flex min-w-0 items-start gap-8 text-left"
			>
				<RiAlertLine className="mt-2 size-14 shrink-0 text-feedback-warning" aria-hidden="true" />
				<span className="flex min-w-0 flex-1 flex-col gap-2 tr-text-ui text-text-default">
					{dirty.length > 0 ? (
						<span className="truncate" data-testid="group-home-main-dirty">
							{t("panels.groupHome.mainDirty", { count: dirty.length, names: names(dirty) })}
						</span>
					) : null}
					{behind.length > 0 ? (
						<span className="truncate" data-testid="group-home-main-behind">
							{t("panels.groupHome.mainBehind", {
								count: behind.length,
								threshold: MAIN_BEHIND_WARNING,
								names: names(behind),
							})}
						</span>
					) : null}
				</span>
				<Chevron className="mt-2 size-14 shrink-0 text-text-muted" aria-hidden="true" />
			</button>
			{open ? (
				<div className="flex flex-col gap-4 pl-24">
					<p className="tr-text-metadata text-text-subtle">{t("panels.groupHome.mainHint")}</p>
					<ul className="flex flex-col">
						{repositories
							.filter((row) => dirty.includes(row) || behind.includes(row))
							.map((row) => (
								<li key={row.projectId}>
									<button
										type="button"
										data-testid="group-home-main-repository"
										data-project={row.projectId}
										onClick={() => goToProjectHome(row.projectId)}
										className="flex h-panel-row w-full min-w-0 items-center gap-8 rounded-sm px-4 text-left hover:bg-control-bg-hovered"
									>
										<RiGitRepositoryLine
											className="size-14 shrink-0 text-text-muted"
											aria-hidden="true"
										/>
										<span className="min-w-0 truncate tr-code-text text-text-default">
											{repositoryLabel(row, projectById)}
										</span>
										<span className="flex-1" />
										{row.dirty ? (
											<span className="shrink-0 tr-text-metadata text-feedback-warning">
												{t("panels.groupHome.mainDirtyItem")}
											</span>
										) : null}
										{(row.behind ?? 0) >= MAIN_BEHIND_WARNING ? (
											<span className="shrink-0 tr-text-metadata text-text-muted">
												{t("panels.groupHome.mainBehindItem", {
													count: row.behind ?? 0,
													upstream: row.upstream ?? "",
												})}
											</span>
										) : null}
									</button>
								</li>
							))}
					</ul>
				</div>
			) : null}
		</section>
	);
}

/** The group's started Issues, one collapsible row each (collapsed by default). */
export function GroupIssueList({
	groupId,
	issues,
	projectById,
	expanded,
	onToggle,
	onOpen,
}: {
	groupId: string;
	issues: readonly ProjectGroupIssue[];
	projectById: ReadonlyMap<string, Project>;
	expanded: ReadonlySet<string>;
	onToggle: (key: string) => void;
	onOpen: (projectId: string, workspaceId: string) => void;
}) {
	return (
		<ul
			data-testid="group-home-issues"
			className="flex flex-col divide-y divide-border-muted rounded-sm border border-border-muted"
		>
			{issues.map((issue) => {
				const key = issueKey(groupId, issue);
				return (
					<IssueRow
						key={key}
						issue={issue}
						expanded={expanded.has(key)}
						onToggle={() => onToggle(key)}
						projectById={projectById}
						onOpen={onOpen}
					/>
				);
			})}
		</ul>
	);
}

function IssueRow({
	issue,
	expanded,
	onToggle,
	projectById,
	onOpen,
}: {
	issue: ProjectGroupIssue;
	expanded: boolean;
	onToggle: () => void;
	projectById: ReadonlyMap<string, Project>;
	onOpen: (projectId: string, workspaceId: string) => void;
}) {
	const t = useT();
	const totals = issueTotals(issue);
	const primary = issue.repositories.find((repository) => repository.role === "primary");
	const Chevron = expanded ? RiArrowDownSLine : RiArrowRightSLine;
	return (
		<li
			data-testid="group-home-issue"
			data-number={issue.number}
			data-expanded={expanded}
			className="flex flex-col"
		>
			<button
				type="button"
				data-testid="group-home-issue-toggle"
				aria-expanded={expanded}
				title={issue.instanceUrl}
				onClick={onToggle}
				className="flex min-h-panel-row w-full min-w-0 items-center gap-8 px-8 py-4 text-left hover:bg-control-bg-hovered"
			>
				<Chevron className="size-16 shrink-0 text-text-muted" aria-hidden="true" />
				<span className="shrink-0 tr-text-ui text-text-muted">
					{t("panels.groupHome.issueNumber", { number: issue.number })}
				</span>
				<span className="min-w-0 truncate tr-text-ui text-text-default">
					{issue.title ?? repositoryLabel(primary ?? issue, projectById)}
				</span>
				{issue.title && primary ? (
					<span className="hidden min-w-0 shrink truncate tr-code-text-small text-text-subtle sm:inline">
						{repositoryLabel(primary, projectById)}
					</span>
				) : null}
				<span className="flex-1" />
				<IssueBadges totals={totals} />
				<span
					data-testid="group-home-issue-summary"
					className="shrink-0 tr-text-metadata text-text-subtle"
				>
					{t("panels.groupHome.issueRepositories", { count: totals.repositories })}
					{t("panels.groupHome.listDot")}
					{totals.measured
						? totals.changed > 0
							? t("panels.groupHome.issueChanged", { count: totals.changed })
							: t("panels.groupHome.issueNoChanges")
						: t("panels.groupHome.issueNotMeasured")}
				</span>
			</button>
			{expanded ? (
				<ul data-testid="group-home-issue-repositories" className="flex flex-col pb-8 pl-24">
					{issue.repositories.map((repository) => (
						<IssueRepositoryRow
							key={repository.projectId}
							repository={repository}
							projectById={projectById}
							onOpen={onOpen}
						/>
					))}
				</ul>
			) : null}
		</li>
	);
}

function IssueBadges({ totals }: { totals: ReturnType<typeof issueTotals> }) {
	const t = useT();
	if (!totals.measured) return null;
	return (
		<span className="flex shrink-0 items-center gap-4">
			{totals.ahead > 0 ? (
				<span
					data-testid="group-home-issue-ahead"
					title={t("panels.groupHome.aheadTotal", { count: totals.ahead })}
					className={cn(
						CHIP_CLASS,
						"flex items-center gap-2 tr-text-caption",
						"border-feedback-info-muted text-feedback-info",
					)}
				>
					<RiGitCommitLine className="size-12" aria-hidden="true" />
					{totals.ahead}
				</span>
			) : null}
			{totals.dirty > 0 ? (
				<span
					data-testid="group-home-issue-dirty"
					title={t("panels.groupHome.dirtyTotal", { count: totals.dirty })}
					className={cn(
						CHIP_CLASS,
						"flex items-center gap-2 tr-text-caption",
						"border-feedback-warning-muted text-feedback-warning",
					)}
				>
					<RiEditLine className="size-12" aria-hidden="true" />
					{totals.dirty}
				</span>
			) : null}
		</span>
	);
}

function IssueRepositoryRow({
	repository,
	projectById,
	onOpen,
}: {
	repository: ProjectGroupIssueRepository;
	projectById: ReadonlyMap<string, Project>;
	onOpen: (projectId: string, workspaceId: string) => void;
}) {
	const t = useT();
	const label = repositoryLabel(repository, projectById);
	const state = repositoryState(repository);
	const workspaceId = repository.workspaceId;
	const baseText =
		repository.baseSource === "recorded"
			? t("panels.groupHome.baseRecorded")
			: repository.baseSource === "created"
				? t("panels.groupHome.baseCreated")
				: repository.baseSource === "mergeBase"
					? t("panels.groupHome.baseMergeBase", { branch: repository.defaultBranch ?? "" })
					: "";
	return (
		<li>
			<button
				type="button"
				data-testid="group-home-issue-repository"
				data-project={repository.projectId}
				data-state={state}
				disabled={!workspaceId}
				title={t("panels.groupHome.openIssueRepository")}
				onClick={() => (workspaceId ? onOpen(repository.projectId, workspaceId) : undefined)}
				className="flex h-panel-row w-full min-w-0 items-center gap-8 rounded-sm pr-8 pl-4 text-left enabled:hover:bg-control-bg-hovered"
			>
				<RiGitRepositoryLine className="size-14 shrink-0 text-text-muted" aria-hidden="true" />
				<span className="min-w-0 truncate tr-code-text text-text-default">{label}</span>
				{repository.role === "primary" ? (
					<span
						className={cn(CHIP_CLASS, "border-border-default text-text-subtle tr-text-caption")}
					>
						{t("panels.groupHome.primaryBadge")}
					</span>
				) : null}
				<span className="flex-1" />
				{!workspaceId ? (
					<span className="shrink-0 tr-text-metadata text-text-subtle">
						{t("panels.groupHome.worktreePending")}
					</span>
				) : (
					<>
						{repository.branch ? (
							<span
								className="flex max-w-[180px] min-w-0 items-center gap-2 tr-code-text-small text-text-muted"
								title={repository.branch}
							>
								<RiGitBranchLine className="size-12 shrink-0" aria-hidden="true" />
								<span className="truncate">{repository.branch}</span>
							</span>
						) : null}
						{repository.ahead !== undefined ? (
							<span
								data-testid="group-home-repository-ahead"
								title={t("panels.groupHome.aheadOfStart", {
									count: repository.ahead,
									base: baseText,
								})}
								className={cn(
									"flex shrink-0 items-center gap-2 tr-text-metadata",
									repository.ahead > 0 ? "text-feedback-info" : "text-text-subtle",
								)}
							>
								<RiArrowUpLine className="size-12" aria-hidden="true" />
								{repository.ahead}
							</span>
						) : null}
						{repository.behind !== undefined && repository.behind > 0 ? (
							<span
								data-testid="group-home-repository-behind"
								title={t("panels.groupHome.behindDefault", {
									count: repository.behind,
									branch: repository.defaultBranch ?? "",
								})}
								className="flex shrink-0 items-center gap-2 tr-text-metadata text-text-subtle"
							>
								<RiArrowDownLine className="size-12" aria-hidden="true" />
								{repository.behind}
							</span>
						) : null}
						{repository.upstream ? (
							<span
								data-testid="group-home-repository-upstream"
								title={t("panels.groupHome.pushedDivergence", {
									upstream: repository.upstream,
									ahead: repository.upstreamAhead ?? 0,
									behind: repository.upstreamBehind ?? 0,
								})}
								className="flex shrink-0 items-center gap-2 tr-text-metadata text-text-subtle"
							>
								<RiUploadCloud2Line className="size-12" aria-hidden="true" />
								{repository.upstreamAhead || repository.upstreamBehind
									? `${repository.upstreamAhead ?? 0}/${repository.upstreamBehind ?? 0}`
									: null}
							</span>
						) : null}
						<RepositoryStateChip repository={repository} state={state} />
					</>
				)}
			</button>
		</li>
	);
}

function RepositoryStateChip({
	repository,
	state,
}: {
	repository: ProjectGroupIssueRepository;
	state: "changed" | "unchanged" | "unknown";
}) {
	const t = useT();
	const files = repository.changedFiles ?? 0;
	if (state === "unknown" && repository.changedFiles === undefined)
		return (
			<span className="shrink-0 tr-text-metadata text-text-subtle">
				{t("panels.groupHome.unmeasured")}
			</span>
		);
	if (files > 0)
		return (
			<span
				data-testid="group-home-repository-uncommitted"
				className={cn(
					CHIP_CLASS,
					"tr-text-caption",
					"border-feedback-warning-muted text-feedback-warning",
				)}
			>
				{t("panels.groupHome.uncommitted", { count: files })}
			</span>
		);
	if (state === "changed")
		return (
			<span
				className={cn(
					CHIP_CLASS,
					"tr-text-caption",
					"border-feedback-info-muted text-feedback-info",
				)}
			>
				{t("panels.groupHome.committedOnly")}
			</span>
		);
	return (
		<span
			data-testid="group-home-repository-unchanged"
			className={cn(CHIP_CLASS, "tr-text-caption", "border-border-default text-text-subtle")}
		>
			{t("panels.groupHome.unchanged")}
		</span>
	);
}

function FetchResults({
	results,
	projectById,
	onDismiss,
}: {
	results: readonly ProjectGroupFetchResult[];
	projectById: ReadonlyMap<string, Project>;
	onDismiss: () => void;
}) {
	const t = useT();
	const failed = results.filter((result) => result.outcome === "failed").length;
	return (
		<section
			data-testid="group-home-fetch-results"
			className="flex flex-col gap-8 rounded-sm border border-border-muted px-12 py-8"
		>
			<div className="flex items-center gap-8">
				<span
					className={cn(
						"flex-1 tr-text-ui",
						failed > 0 ? "text-feedback-warning" : "text-text-default",
					)}
				>
					{t("panels.groupHome.fetchSummary", {
						fetched: results.filter((result) => result.outcome === "fetched").length,
						failed,
						skipped: results.filter((result) => result.outcome === "noRemote").length,
					})}
				</span>
				<Button variant="ghost" size="s" onClick={onDismiss}>
					{t("panels.groupHome.dismiss")}
				</Button>
			</div>
			<ul className="flex max-h-[240px] flex-col gap-2 overflow-auto">
				{results.map((result) => (
					<li
						key={result.projectId}
						data-testid="group-home-fetch-result"
						data-outcome={result.outcome}
						className="flex min-w-0 items-baseline gap-8"
					>
						<span className="shrink-0 tr-code-text text-text-default">
							{result.path || projectById.get(result.projectId)?.name || result.projectId}
						</span>
						<span
							className={cn(
								"min-w-0 truncate tr-text-metadata",
								result.outcome === "failed" ? "text-feedback-error" : "text-text-muted",
							)}
							title={result.error}
						>
							{result.outcome === "fetched"
								? t("panels.groupHome.fetched")
								: result.outcome === "noRemote"
									? t("panels.groupHome.noRemote")
									: (result.error ?? t("panels.groupHome.fetchFailed"))}
						</span>
					</li>
				))}
			</ul>
		</section>
	);
}
