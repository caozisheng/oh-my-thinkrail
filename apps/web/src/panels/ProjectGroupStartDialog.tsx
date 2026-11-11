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
import { useState } from "react";
import { IssuesTool } from "../issues";
import { toast, useAppStore } from "../store";
import { errorText, getTransport } from "../transport";
import { enterDefaultWorkspace } from "./defaultWorkspace";
import { openIssueSession } from "./issueSession";
import { NewWorkspaceDialog, ProjectPicker } from "./NewWorkspaceDialog";
import { groupMemberLabel } from "./projectGroups";
import { setupDialogRequest, type WorkspaceDialogRequest } from "./setupPrompt";
import { Card } from "./WelcomeCard";

/** The member that sits at the group folder itself (relative path `""`), when the folder is a repository. */
export function groupRootMember(members: readonly Project[]): Project | null {
	return members.find((member) => (member.projectGroup?.path ?? "") === "") ?? null;
}

/**
 * The repository an Issue starts in by default: the root repository when the group folder is one,
 * otherwise the shallowest member (members arrive root first, then by relative path).
 */
export function defaultGroupPrimary(members: readonly Project[]): Project | null {
	return groupRootMember(members) ?? members[0] ?? null;
}

type Step = "choose" | "issue";

/**
 * The group row's "+" — the project start screen's three choices, scoped to a project group.
 * "Start building" (the highlighted path) picks an Issue in a chosen primary repository and starts it
 * through the Issues tool's own flow, so the Issue worktree starts with that repository only and the
 * others join on demand. "Set up project" and "Work in project folder" act on the group folder's
 * repository and are shown disabled, with the reason, when the folder is not one.
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
	const root = groupRootMember(members);
	const [step, setStep] = useState<Step>("choose");
	const [primaryId, setPrimaryId] = useState(defaultGroupPrimary(members)?.id ?? "");
	const [workspaceRequest, setWorkspaceRequest] = useState<WorkspaceDialogRequest | null>(null);
	const primary = members.find((member) => member.id === primaryId) ?? null;

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
		if (!primary) return;
		await openIssueSession(primary.id, launch, isCurrent);
		if (isCurrent()) onOpenChange(false);
	};
	const trustPrimary = () => {
		if (!primary) return;
		void getTransport()
			.request("project.setTrust", { id: primary.id, trusted: true, resources: true })
			.then((project) => useAppStore.getState().applyProjectUpdated(project))
			.catch((error: unknown) => toast.error(errorText(error), t("issues.trustAction")));
	};
	return (
		<Dialog open onOpenChange={onOpenChange}>
			<DialogContent
				data-testid="project-group-start-dialog"
				data-step={step}
				className={step === "issue" ? "max-w-[640px]" : "max-w-[740px]"}
			>
				<DialogHeader>
					<DialogTitle>{t("panels.projectGroupStart.title", { name: groupName })}</DialogTitle>
					<DialogDescription>
						{step === "issue"
							? t("panels.projectGroupStart.issueDescription")
							: t("panels.projectGroupStart.description")}
					</DialogDescription>
				</DialogHeader>
				{step === "choose" ? (
					<ProjectGroupStartChoices
						canStartIssue={primary !== null}
						rootProjectId={root?.id ?? null}
						onStartBuilding={() => setStep("issue")}
						onSetup={(projectId) => setWorkspaceRequest(setupDialogRequest(projectId))}
						onProjectFolder={(projectId) => {
							onOpenChange(false);
							void enterDefaultWorkspace(projectId);
						}}
					/>
				) : (
					<div className="flex min-h-0 flex-col gap-12">
						<div className="flex flex-wrap items-center gap-8">
							<Button
								variant="ghost"
								size="m"
								iconLeft={ArrowLeft}
								data-testid="project-group-start-back"
								onClick={() => setStep("choose")}
							>
								{t("common.back")}
							</Button>
							<span className="tr-text-ui text-text-muted">
								{t("panels.projectGroupStart.primaryLabel")}
							</span>
							<ProjectPicker
								projects={members.map((member) => ({
									id: member.id,
									name: groupMemberLabel(member),
								}))}
								current={primary ? groupMemberLabel(primary) : ""}
								container={null}
								onSelect={setPrimaryId}
							/>
						</div>
						<p className="tr-text-metadata text-text-muted">
							{t("panels.projectGroupStart.joinHint")}
						</p>
						<div
							data-testid="project-group-start-issues"
							className="h-[420px] min-h-0 overflow-hidden rounded-sm border border-border-default"
						>
							{primary ? (
								<IssuesTool
									key={primary.id}
									projectId={primary.id}
									onLaunchSession={launchIssue}
									onTrustProject={trustPrimary}
								/>
							) : null}
						</div>
						<div className="flex flex-wrap items-center justify-between gap-8">
							<span className="tr-text-metadata text-text-muted">
								{t("panels.projectGroupStart.newIssueHint")}
							</span>
							<Button
								variant="outline"
								size="m"
								data-testid="project-group-start-no-issue"
								disabled={!primary}
								onClick={() => {
									if (primary) setWorkspaceRequest({ projectId: primary.id, prompt: "" });
								}}
							>
								{t("panels.projectGroupStart.withoutIssue")}
							</Button>
						</div>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}

/** The three start cards; a choice the group cannot support stays visible, disabled, with its reason. */
export function ProjectGroupStartChoices({
	canStartIssue,
	rootProjectId,
	onStartBuilding,
	onSetup,
	onProjectFolder,
}: {
	canStartIssue: boolean;
	/** The group folder's own repository; `null` when the folder is not one. */
	rootProjectId: string | null;
	onStartBuilding: () => void;
	onSetup: (projectId: string) => void;
	onProjectFolder: (projectId: string) => void;
}) {
	const t = useT();
	const rootReason = t("panels.projectGroupStart.noRootRepository");
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
				disabled={!canStartIssue}
				className={disabledCard}
				onClick={onStartBuilding}
			/>
			<Card
				icon={Sparkles}
				title={t("panels.welcome.setupTitle")}
				tag={t("panels.welcome.setupTag")}
				subtitle={rootProjectId ? t("panels.projectGroupStart.setupSubtitle") : rootReason}
				data-testid="project-group-start-setup"
				disabled={rootProjectId === null}
				className={disabledCard}
				onClick={() => {
					if (rootProjectId) onSetup(rootProjectId);
				}}
			/>
			<Card
				icon={House}
				title={t("panels.welcome.projectFolderTitle")}
				subtitle={rootProjectId ? t("panels.projectGroupStart.projectFolderSubtitle") : rootReason}
				data-testid="project-group-start-folder"
				disabled={rootProjectId === null}
				className={disabledCard}
				onClick={() => {
					if (rootProjectId) onProjectFolder(rootProjectId);
				}}
			/>
		</div>
	);
}
