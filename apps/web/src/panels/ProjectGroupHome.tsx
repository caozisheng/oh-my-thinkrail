import {
	RiArrowDownLine,
	RiArrowUpLine,
	RiDeleteBin6Line,
	RiDownloadCloud2Line,
	RiFolderOpenLine,
	RiGitBranchLine,
	RiGitRepositoryLine,
	RiRefreshLine,
	RiSearchLine,
	RiStackLine,
} from "@remixicon/react";
import type {
	Project,
	ProjectGroupFetchResult,
	ProjectGroupIssue,
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
import { type ProjectGroupTreeNode, projectGroupTree } from "./projectGroups";
import { useOpenProject } from "./useOpenProject";
import { goToProjectHome, loadProjectWorkspaces } from "./workspaceActions";

const CHIP_CLASS =
	"shrink-0 rounded-full border px-4 tr-text-caption leading-tight whitespace-nowrap";

async function openIssueWorkspace(projectId: string, workspaceId: string): Promise<void> {
	const rows = await loadProjectWorkspaces(projectId);
	const workspace = rows.find((row) => row.id === workspaceId);
	if (!workspace) throw new Error(workspaceId);
	useAppStore.getState().activateWorkspace(workspace);
}

/** The group home: one imported folder's members, their checkouts, Issues and group actions. */
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
	const tree = projectGroupTree(groupId, members);
	const byProject = new Map(status?.repositories.map((row) => [row.projectId, row]) ?? []);
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

				<section className="flex flex-col gap-8" aria-labelledby="group-home-repositories">
					<h2 id="group-home-repositories" className="tr-title-section text-text-default">
						{t("panels.groupHome.repositories")}
					</h2>
					{statusError ? (
						<p role="alert" className="tr-text-ui text-feedback-error">
							{statusError}
						</p>
					) : null}
					<ul
						data-testid="group-home-tree"
						className="flex flex-col rounded-sm border border-border-muted py-4"
					>
						<TreeRows nodes={tree} byProject={byProject} loading={status === null} />
					</ul>
				</section>

				<section className="flex flex-col gap-8" aria-labelledby="group-home-issues">
					<h2 id="group-home-issues" className="tr-title-section text-text-default">
						{t("panels.groupHome.issues")}
					</h2>
					{status === null && !statusError ? (
						<LoadingRegion rows={2} className="py-4" />
					) : (status?.issues.length ?? 0) === 0 ? (
						<p className="tr-text-metadata text-text-muted">{t("panels.groupHome.noIssues")}</p>
					) : (
						<ul data-testid="group-home-issues" className="flex flex-col gap-8">
							{status?.issues.map((issue) => (
								<IssueRow
									key={`${issue.instanceUrl}#${issue.number}:${issue.projectId}`}
									issue={issue}
									projectById={projectById}
									onOpen={openWorkspace}
								/>
							))}
						</ul>
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

function TreeRows({
	nodes,
	byProject,
	loading,
}: {
	nodes: readonly ProjectGroupTreeNode[];
	byProject: ReadonlyMap<string, ProjectGroupRepositoryStatus>;
	loading: boolean;
}) {
	return nodes.map((node) => (
		<li key={node.key} data-group-path={node.path}>
			{node.kind === "repository" ? (
				<RepositoryRow
					project={node.project}
					path={node.path}
					status={byProject.get(node.project.id)}
					loading={loading}
				/>
			) : (
				<div
					className="flex h-panel-row items-center gap-4 pr-8 pl-8 text-text-subtle"
					title={node.path}
				>
					<RiFolderOpenLine className="size-14 shrink-0" aria-hidden="true" />
					<span className="truncate tr-text-metadata">{node.label}</span>
				</div>
			)}
			{node.children.length > 0 ? (
				<ul className="ml-16 flex flex-col border-border-muted border-l">
					<TreeRows nodes={node.children} byProject={byProject} loading={loading} />
				</ul>
			) : null}
		</li>
	));
}

function RepositoryRow({
	project,
	path,
	status,
	loading,
}: {
	project: Project;
	path: string;
	status: ProjectGroupRepositoryStatus | undefined;
	loading: boolean;
}) {
	const t = useT();
	return (
		<button
			type="button"
			data-testid="group-home-repository"
			data-project={project.id}
			data-dirty={status?.dirty ?? undefined}
			title={path || t("panels.groupHome.rootPath")}
			onClick={() => goToProjectHome(project.id)}
			className="flex h-panel-row w-full min-w-0 items-center gap-8 pr-8 pl-8 text-left hover:bg-control-bg-hovered"
		>
			<RiGitRepositoryLine className="size-14 shrink-0 text-text-muted" aria-hidden="true" />
			<span className="min-w-0 truncate tr-text-ui text-text-default">{project.name}</span>
			{path === "" ? (
				<span className={cn(CHIP_CLASS, "border-border-default text-text-subtle")}>
					{t("panels.projectTree.groupRootBadge")}
				</span>
			) : null}
			<span className="flex-1" />
			{status ? (
				<RepositoryStatusChips status={status} />
			) : loading ? (
				<span className="tr-text-caption text-text-subtle">{t("panels.groupHome.loading")}</span>
			) : null}
		</button>
	);
}

function RepositoryStatusChips({ status }: { status: ProjectGroupRepositoryStatus }) {
	const t = useT();
	return (
		<span className="flex shrink-0 items-center gap-4">
			{status.ahead !== undefined && status.behind !== undefined ? (
				<span
					data-testid="group-home-divergence"
					title={t("panels.groupHome.divergence", {
						upstream: status.upstream ?? "",
						ahead: status.ahead,
						behind: status.behind,
					})}
					className="flex items-center gap-2 tr-text-caption text-text-subtle"
				>
					<RiArrowUpLine className="size-12" aria-hidden="true" />
					{status.ahead}
					<RiArrowDownLine className="size-12" aria-hidden="true" />
					{status.behind}
				</span>
			) : (
				<span className="tr-text-caption text-text-subtle">{t("panels.groupHome.noUpstream")}</span>
			)}
			<span
				className={cn(
					CHIP_CLASS,
					status.dirty === null
						? "border-border-default text-text-subtle"
						: status.dirty
							? "border-feedback-warning-muted text-feedback-warning"
							: "border-border-default text-text-subtle",
				)}
			>
				{status.dirty === null
					? t("panels.groupHome.unreadable")
					: status.dirty
						? t("panels.groupHome.dirty")
						: t("panels.groupHome.clean")}
			</span>
			<span className="flex max-w-[160px] items-center gap-2 tr-text-caption text-text-muted">
				<RiGitBranchLine className="size-12 shrink-0" aria-hidden="true" />
				<span className="truncate">{status.branch ?? t("panels.groupHome.detached")}</span>
			</span>
		</span>
	);
}

function IssueRow({
	issue,
	projectById,
	onOpen,
}: {
	issue: ProjectGroupIssue;
	projectById: ReadonlyMap<string, Project>;
	onOpen: (projectId: string, workspaceId: string) => void;
}) {
	const t = useT();
	const primary = issue.repositories.find((repository) => repository.role === "primary");
	const place = (projectId: string) => {
		const project = projectById.get(projectId);
		if (!project) return projectId;
		return project.projectGroup?.path || project.name;
	};
	return (
		<li
			data-testid="group-home-issue"
			data-number={issue.number}
			className="flex flex-col gap-8 rounded-sm border border-border-muted px-12 py-8"
		>
			<div className="flex min-w-0 items-center gap-8">
				<button
					type="button"
					disabled={!primary?.workspaceId}
					onClick={() =>
						primary?.workspaceId ? onOpen(primary.projectId, primary.workspaceId) : undefined
					}
					className="min-w-0 truncate text-left tr-text-ui text-text-default hover:text-primary disabled:hover:text-text-default"
					title={t("panels.groupHome.openIssue")}
				>
					{t("panels.groupHome.issueTitle", {
						number: issue.number,
						primary: place(issue.projectId),
					})}
				</button>
				<span className="truncate tr-text-caption text-text-subtle">{issue.instanceUrl}</span>
			</div>
			<ul className="flex flex-wrap gap-4">
				{issue.repositories.map((repository) => (
					<li key={repository.projectId}>
						<button
							type="button"
							data-testid="group-home-issue-repository"
							data-changed={repository.changed}
							disabled={!repository.workspaceId}
							onClick={() =>
								repository.workspaceId
									? onOpen(repository.projectId, repository.workspaceId)
									: undefined
							}
							className={cn(
								CHIP_CLASS,
								"py-2",
								repository.changed
									? "border-feedback-info-muted text-feedback-info"
									: "border-border-default text-text-muted",
								repository.workspaceId && "hover:bg-control-bg-hovered",
							)}
						>
							{t(
								repository.changed === undefined
									? repository.role === "primary"
										? "panels.groupHome.issueRepositoryPrimary"
										: "panels.groupHome.issueRepository"
									: repository.changed
										? "panels.groupHome.issueRepositoryChanged"
										: "panels.groupHome.issueRepositoryUnchanged",
								{ path: place(repository.projectId) },
							)}
						</button>
					</li>
				))}
			</ul>
		</li>
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
