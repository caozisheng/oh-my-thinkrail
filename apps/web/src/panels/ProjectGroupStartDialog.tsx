import {
	RiArrowLeftLine as ArrowLeft,
	RiHome2Line as House,
	RiRocketLine as Rocket,
	RiSparkling2Line as Sparkles,
} from "@remixicon/react";
import type { IssueSessionLaunch, Project } from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@thinkrail/ui/dialog";
import { type ReactNode, useEffect, useState } from "react";
import { IssuesTool } from "../issues";
import { toast, useAppStore } from "../store";
import { errorText, getTransport } from "../transport";
import { enterDefaultWorkspace } from "./defaultWorkspace";
import { openIssueSession } from "./issueSession";
import { NewWorkspaceDialog, ProjectPicker } from "./NewWorkspaceDialog";
import { startChatInTab } from "./openChat";
import { groupMemberLabel } from "./projectGroups";
import { SETUP_PROMPT, type WorkspaceDialogRequest } from "./setupPrompt";
import { Card } from "./WelcomeCard";

/**
 * The member an Issue starts in by default: the first (by relative path) whose Issue tracker is
 * connected. None connected → no default, the user picks. No member is special for sitting at the
 * group folder; a project group is a folder plus its member repositories, never an outer repository.
 */
export function defaultGroupPrimary(
	members: readonly Project[],
	connected: ReadonlySet<string>,
): Project | null {
	return members.find((member) => connected.has(member.id)) ?? null;
}

/** The members whose Issue tracker is connected; read once per dialog, a failed read counts as none. */
function useTrackerConnections(members: readonly Project[]): ReadonlySet<string> | null {
	const [connected, setConnected] = useState<ReadonlySet<string> | null>(null);
	const ids = members.map((member) => member.id).join("\n");
	useEffect(() => {
		let current = true;
		const transport = getTransport();
		void Promise.all(
			ids
				.split("\n")
				.filter(Boolean)
				.map((projectId) =>
					transport
						.request("issues.connection", { projectId })
						.then((connection) => (connection?.connected ? projectId : null))
						.catch(() => null),
				),
		).then((found) => {
			if (current) setConnected(new Set(found.filter((id): id is string => id !== null)));
		});
		return () => {
			current = false;
		};
	}, [ids]);
	return connected;
}

/** The group context an agent gets: the plain group folder and every member repository in it. */
export function groupContextLines(root: string, members: readonly Project[]): string {
	return [root, ...members.map((member) => `- ${groupMemberLabel(member)} — ${member.path}`)].join(
		"\n",
	);
}

type Step = "choose" | "issue" | "setup" | "folder";

/**
 * The group row's "+" — the project start screen's three choices, scoped to a project group (a plain
 * folder plus its member repositories; the folder itself is never required to be a repository).
 * "Start building" picks an Issue in a primary repository (default: a tracker-connected member) and
 * starts it through the Issues tool's own flow — the worktree starts with that repository only and the
 * others join on demand. "Set up project" drafts the group's specs into a member repository the user
 * picks (specs are read from Git). "Work in project folder" opens an unisolated chat anchored at a
 * member's main checkout whose draft hands the agent the group folder and every member to edit in place.
 */
export function ProjectGroupStartDialog({
	groupName,
	members,
	onOpenChange,
}: {
	groupName: string;
	members: readonly Project[];
	onOpenChange: (open: boolean) => void;
}) {
	const t = useT();
	const connected = useTrackerConnections(members);
	const [step, setStep] = useState<Step>("choose");
	const [pickedId, setPickedId] = useState<string | null>(null);
	const [workspaceRequest, setWorkspaceRequest] = useState<WorkspaceDialogRequest | null>(null);
	const root = members[0]?.projectGroup?.root ?? "";
	const suggested = connected ? defaultGroupPrimary(members, connected) : null;
	// The folder chat only needs an anchor: fall back to the first member when none is connected.
	const fallback = step === "folder" ? (members[0] ?? null) : null;
	const selected =
		members.find((member) => member.id === pickedId) ?? suggested ?? fallback ?? null;
	const context = groupContextLines(root, members);

	if (workspaceRequest) {
		return (
			<NewWorkspaceDialog
				open
				projectId={workspaceRequest.projectId}
				initialPrompt={workspaceRequest.prompt}
				{...(workspaceRequest.note !== undefined ? { promptNote: workspaceRequest.note } : {})}
				onOpenChange={(open) => {
					if (!open) onOpenChange(false);
				}}
			/>
		);
	}

	const launchIssue = async (launch: IssueSessionLaunch, isCurrent: () => boolean) => {
		if (!selected) return;
		await openIssueSession(selected.id, launch, isCurrent);
		if (isCurrent()) onOpenChange(false);
	};
	const trustSelected = () => {
		if (!selected) return;
		void getTransport()
			.request("project.setTrust", { id: selected.id, trusted: true, resources: true })
			.then((project) => useAppStore.getState().applyProjectUpdated(project))
			.catch((error: unknown) => toast.error(errorText(error), t("issues.trustAction")));
	};
	const openFolderChat = async (anchor: Project) => {
		onOpenChange(false);
		const workspace = await enterDefaultWorkspace(anchor.id);
		if (!workspace) return;
		await startChatInTab(workspace.id, {
			draft: t("panels.projectGroupStart.folderDraft", { name: groupName, repositories: context }),
		});
	};
	const description =
		step === "issue"
			? t("panels.projectGroupStart.issueDescription")
			: step === "setup"
				? t("panels.projectGroupStart.setupDescription")
				: step === "folder"
					? t("panels.projectGroupStart.folderDescription", { root })
					: t("panels.projectGroupStart.description");
	const picker = (
		<RepositoryPicker
			members={members}
			selected={selected}
			label={
				step === "issue"
					? t("panels.projectGroupStart.primaryLabel")
					: step === "setup"
						? t("panels.projectGroupStart.specRepositoryLabel")
						: t("panels.projectGroupStart.anchorLabel")
			}
			onBack={() => setStep("choose")}
			onSelect={setPickedId}
		/>
	);
	return (
		<Dialog open onOpenChange={onOpenChange}>
			<DialogContent
				data-testid="project-group-start-dialog"
				data-step={step}
				className={step === "choose" ? "max-w-[740px]" : "max-w-[640px]"}
			>
				<DialogHeader>
					<DialogTitle>{t("panels.projectGroupStart.title", { name: groupName })}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				{step === "choose" ? (
					<ProjectGroupStartChoices
						canStart={members.length > 0}
						onStartBuilding={() => setStep("issue")}
						onSetup={() => setStep("setup")}
						onProjectFolder={() => setStep("folder")}
					/>
				) : step === "issue" ? (
					<div className="flex min-h-0 flex-col gap-12">
						{picker}
						<p className="tr-text-metadata text-text-muted">
							{t("panels.projectGroupStart.joinHint")}
						</p>
						<div
							data-testid="project-group-start-issues"
							className="h-[420px] min-h-0 overflow-hidden rounded-sm border border-border-default"
						>
							{selected ? (
								<IssuesTool
									key={selected.id}
									projectId={selected.id}
									onLaunchSession={launchIssue}
									onTrustProject={trustSelected}
								/>
							) : (
								<ChoosePrompt loading={connected === null}>
									{t("panels.projectGroupStart.choosePrimaryPrompt")}
								</ChoosePrompt>
							)}
						</div>
						<div className="flex flex-wrap items-center justify-between gap-8">
							<span className="tr-text-metadata text-text-muted">
								{t("panels.projectGroupStart.newIssueHint")}
							</span>
							<Button
								variant="outline"
								size="m"
								data-testid="project-group-start-no-issue"
								disabled={!selected}
								onClick={() => {
									if (selected) setWorkspaceRequest({ projectId: selected.id, prompt: "" });
								}}
							>
								{t("panels.projectGroupStart.withoutIssue")}
							</Button>
						</div>
					</div>
				) : (
					<div className="flex min-h-0 flex-col gap-12">
						{picker}
						<p
							data-testid="project-group-start-explain"
							className="whitespace-pre-line tr-text-metadata text-text-muted"
						>
							{step === "setup"
								? t("panels.projectGroupStart.setupHint")
								: t("panels.projectGroupStart.folderHint")}
						</p>
						{!selected ? (
							<ChoosePrompt loading={connected === null}>
								{t("panels.projectGroupStart.chooseSpecPrompt")}
							</ChoosePrompt>
						) : null}
						<div className="flex justify-end">
							<Button
								variant="primary"
								size="m"
								data-testid="project-group-start-continue"
								disabled={!selected}
								onClick={() => {
									if (!selected) return;
									if (step === "folder") {
										void openFolderChat(selected);
										return;
									}
									setWorkspaceRequest({
										projectId: selected.id,
										prompt: `${SETUP_PROMPT}${t("panels.projectGroupStart.setupDraft", { name: groupName, repositories: context })}`,
										note: t("panels.welcome.setupNote"),
									});
								}}
							>
								{step === "folder"
									? t("panels.projectGroupStart.openFolderChat")
									: t("panels.projectGroupStart.continueSetup")}
							</Button>
						</div>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}

function RepositoryPicker({
	members,
	selected,
	label,
	onBack,
	onSelect,
}: {
	members: readonly Project[];
	selected: Project | null;
	label: string;
	onBack: () => void;
	onSelect: (projectId: string) => void;
}) {
	const t = useT();
	return (
		<div className="flex flex-wrap items-center gap-8">
			<Button
				variant="ghost"
				size="m"
				iconLeft={ArrowLeft}
				data-testid="project-group-start-back"
				onClick={onBack}
			>
				{t("common.back")}
			</Button>
			<span className="tr-text-ui text-text-muted">{label}</span>
			<ProjectPicker
				projects={members.map((member) => ({ id: member.id, name: groupMemberLabel(member) }))}
				current={selected ? groupMemberLabel(selected) : t("panels.projectGroupStart.choose")}
				container={null}
				onSelect={onSelect}
			/>
		</div>
	);
}

function ChoosePrompt({ loading, children }: { loading: boolean; children: ReactNode }) {
	const t = useT();
	return (
		<div
			data-testid="project-group-start-choose-prompt"
			className="flex h-full min-h-[80px] items-center justify-center p-16 text-center tr-text-ui text-text-muted"
		>
			{loading ? t("panels.projectGroupStart.checkingTrackers") : children}
		</div>
	);
}

/** The three start cards. None depends on the group folder being a repository. */
export function ProjectGroupStartChoices({
	canStart,
	onStartBuilding,
	onSetup,
	onProjectFolder,
}: {
	canStart: boolean;
	onStartBuilding: () => void;
	onSetup: () => void;
	onProjectFolder: () => void;
}) {
	const t = useT();
	const disabledCard = "disabled:cursor-not-allowed disabled:opacity-60";
	return (
		<div className="flex flex-wrap justify-center gap-12">
			<Card
				cta
				primary
				icon={Rocket}
				title={t("panels.welcome.startBuildingTitle")}
				subtitle={t("panels.projectGroupStart.startBuildingSubtitle")}
				data-testid="project-group-start-building"
				disabled={!canStart}
				className={disabledCard}
				onClick={onStartBuilding}
			/>
			<Card
				icon={Sparkles}
				title={t("panels.welcome.setupTitle")}
				tag={t("panels.welcome.setupTag")}
				subtitle={t("panels.projectGroupStart.setupSubtitle")}
				data-testid="project-group-start-setup"
				disabled={!canStart}
				className={disabledCard}
				onClick={onSetup}
			/>
			<Card
				icon={House}
				title={t("panels.welcome.projectFolderTitle")}
				subtitle={t("panels.projectGroupStart.projectFolderSubtitle")}
				data-testid="project-group-start-folder"
				disabled={!canStart}
				className={disabledCard}
				onClick={onProjectFolder}
			/>
		</div>
	);
}
