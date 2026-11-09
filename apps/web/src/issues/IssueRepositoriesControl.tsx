import {
	RiLink as LinkIcon,
	RiLinkUnlink as LinkUnlink,
	RiCheckboxCircleFill as Selected,
	RiCheckboxBlankCircleLine as Unselected,
} from "@remixicon/react";
import type { IssueRepositories, IssueSummary } from "@thinkrail/contracts";
import type { MessageKey } from "@thinkrail/locales";
import { useT } from "@thinkrail/locales/react";
import { IconButton } from "@thinkrail/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@thinkrail/ui/popover";
import { useState } from "react";
import { issueKey } from "./model";

/** `loading`/`error` describe the read of this issue's selection, never an empty saved list. */
export type IssueRepositoriesView = IssueRepositories | "loading" | "error";

export function IssueRepositoriesControl({
	issue,
	primaryProjectId,
	projects,
	view,
	disabled,
	onOpen,
	onToggle,
}: {
	issue: IssueSummary;
	/** The local project that owns this issue; never a candidate, the reference id is the remote one. */
	primaryProjectId: string;
	projects: readonly { id: string; name: string }[];
	view: IssueRepositoriesView | undefined;
	disabled: boolean;
	onOpen: () => void;
	onToggle: (projectId: string) => void;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const selection = view && typeof view === "object" ? view : null;
	const locked = selection?.locked === true;
	const selected = new Set(selection?.projectIds ?? []);
	const count = selected.size;
	const candidates = projects.filter((project) => project.id !== primaryProjectId);
	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (next) onOpen();
			}}
		>
			<PopoverTrigger asChild>
				<IconButton
					size="s"
					icon={count > 0 ? LinkIcon : LinkUnlink}
					variant={count > 0 ? "soft-primary" : "ghost"}
					label={t("issues.repositories")}
					tooltip={
						locked
							? `${t("issues.repositories")} — ${t("issues.repositoriesLocked")}`
							: count > 0
								? t("issues.repositoriesSelected", { count })
								: t("issues.repositories")
					}
					disabled={disabled}
					data-testid="issue-repositories"
					data-issue={issueKey(issue)}
					data-locked={locked || undefined}
					aria-haspopup="listbox"
				/>
			</PopoverTrigger>
			<PopoverContent className="flex w-320 flex-col gap-8 p-12" align="end">
				<span className="tr-title-compact text-text-default">{t("issues.repositories")}</span>
				<p className="tr-text-metadata text-text-muted">{t("issues.repositoriesHint")}</p>
				{view === "loading" && (
					<p className="tr-text-metadata text-text-muted">{t("common.loading")}</p>
				)}
				{view === "error" && (
					<p role="alert" className="tr-text-metadata text-feedback-error">
						{t("issues.repositoriesFailed")}
					</p>
				)}
				{locked && (
					<p data-testid="issue-repositories-locked" className="tr-text-metadata text-text-subtle">
						{t("issues.repositoriesLocked")}
					</p>
				)}
				<div
					role="listbox"
					aria-multiselectable="true"
					aria-label={t("issues.repositories")}
					className="flex max-h-320 flex-col gap-2 overflow-auto"
				>
					{candidates.length === 0 && (
						<p className="px-4 tr-text-metadata text-text-muted">{t("issues.repositoriesNone")}</p>
					)}
					{candidates.map((project) => {
						const checked = selected.has(project.id);
						const Icon = checked ? Selected : Unselected;
						return (
							<button
								key={project.id}
								type="button"
								role="option"
								aria-selected={checked}
								disabled={locked}
								data-testid="issue-repository-option"
								data-project={project.id}
								onClick={() => {
									if (!locked) onToggle(project.id);
								}}
								className="flex w-full items-center gap-6 rounded-sm px-4 py-4 text-left tr-text-ui text-text-default hover:bg-control-bg-hovered disabled:opacity-60"
							>
								<Icon
									className={`size-14 shrink-0 ${checked ? "text-primary" : "text-text-muted"}`}
									aria-hidden="true"
								/>
								{project.name}
							</button>
						);
					})}
				</div>
			</PopoverContent>
		</Popover>
	);
}

export const ISSUE_REPOSITORIES_ERROR_KEY: MessageKey = "issues.repositoriesFailed";
