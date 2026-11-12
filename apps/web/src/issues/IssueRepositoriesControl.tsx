import {
	RiAddLine as JoinIcon,
	RiLink as LinkIcon,
	RiLinkUnlink as LinkUnlink,
	RiCheckboxCircleFill as Selected,
	RiCheckboxBlankCircleLine as Unselected,
} from "@remixicon/react";
import type { IssueRepositories, IssueSummary } from "@thinkrail/contracts";
import type { MessageKey } from "@thinkrail/locales";
import { useT } from "@thinkrail/locales/react";
import { Button, IconButton } from "@thinkrail/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@thinkrail/ui/popover";
import { useState } from "react";
import { issueKey } from "./model";

/** `loading`/`error` describe the read of this issue's selection, never an empty saved list. */
export type IssueRepositoriesView =
	| (IssueRepositories & { pending?: boolean; failed?: boolean })
	| "loading"
	| "error";

/** A join/cleanup outcome the popover reports inline; `detail` is the host's refusal text. */
export type IssueRepositoriesNotice =
	| { kind: "joinFailed"; detail?: string }
	| { kind: "cleanupFailed" }
	| { kind: "cleaned"; count: number };

export function IssueRepositoriesControl({
	issue,
	primaryProjectId,
	projects,
	view,
	disabled,
	onOpen,
	onToggle,
	onJoin,
	onCleanup,
}: {
	issue: IssueSummary;
	/** The local project that owns this issue; never a candidate, the reference id is the remote one. */
	primaryProjectId: string;
	projects: readonly { id: string; name: string }[];
	view: IssueRepositoriesView | undefined;
	disabled: boolean;
	onOpen: () => void;
	onToggle: (projectId: string) => void;
	/** Present when the host joins repositories on demand after implementation starts (v126). */
	onJoin?: ((projectId: string) => Promise<IssueRepositoriesNotice | null>) | undefined;
	onCleanup?: (() => Promise<IssueRepositoriesNotice>) | undefined;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const selection = view && typeof view === "object" ? view : null;
	const locked = selection?.locked === true;
	const joinable = locked && onJoin !== undefined;
	const count = selection?.projectIds.length ?? 0;
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
						locked && !joinable
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
				<IssueRepositoriesPanel
					candidates={candidates}
					view={selection?.pending ? "loading" : selection?.failed ? "error" : view}
					onToggle={onToggle}
					onJoin={onJoin}
					onCleanup={onCleanup}
				/>
			</PopoverContent>
		</Popover>
	);
}

/** The popover body: the candidate list, plus on-demand join and cleanup once implementation runs. */
export function IssueRepositoriesPanel({
	candidates,
	view,
	onToggle,
	onJoin,
	onCleanup,
}: {
	candidates: readonly { id: string; name: string }[];
	view: IssueRepositoriesView | undefined;
	onToggle: (projectId: string) => void;
	onJoin?: ((projectId: string) => Promise<IssueRepositoriesNotice | null>) | undefined;
	onCleanup?: (() => Promise<IssueRepositoriesNotice>) | undefined;
}) {
	const t = useT();
	const [busy, setBusy] = useState<string | null>(null);
	const [notice, setNotice] = useState<IssueRepositoriesNotice | null>(null);
	const selection = view && typeof view === "object" ? view : null;
	const locked = selection?.locked === true;
	const joinable = locked && onJoin !== undefined;
	const selected = new Set(selection?.projectIds ?? []);
	const count = selected.size;
	function run(key: string, action: () => Promise<IssueRepositoriesNotice | null>) {
		setBusy(key);
		setNotice(null);
		void action().then(
			(next) => {
				setNotice(next);
				setBusy(null);
			},
			() => setBusy(null),
		);
	}
	return (
		<>
			<span className="tr-title-compact text-text-default">{t("issues.repositories")}</span>
			<p className="tr-text-metadata text-text-muted">
				{t(joinable ? "issues.repositoriesJoinHint" : "issues.repositoriesHint")}
			</p>
			{view === "loading" && (
				<p className="tr-text-metadata text-text-muted">{t("common.loading")}</p>
			)}
			{view === "error" && (
				<p role="alert" className="tr-text-metadata text-feedback-error">
					{t("issues.repositoriesFailed")}
				</p>
			)}
			{locked && !joinable && (
				<p data-testid="issue-repositories-locked" className="tr-text-metadata text-text-subtle">
					{t("issues.repositoriesLocked")}
				</p>
			)}
			{(!locked || joinable) && (
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
						const Icon = checked ? Selected : joinable ? JoinIcon : Unselected;
						const joining = busy === project.id;
						return (
							<button
								key={project.id}
								type="button"
								role="option"
								aria-selected={checked}
								disabled={(joinable && checked) || busy !== null}
								data-testid="issue-repository-option"
								data-project={project.id}
								data-joined={(joinable && checked) || undefined}
								title={joinable && !checked ? t("issues.repositoryJoin") : undefined}
								onClick={() => {
									if (!locked) onToggle(project.id);
									else if (onJoin && !checked) run(project.id, () => onJoin(project.id));
								}}
								className="flex w-full items-center gap-6 rounded-sm px-4 py-4 text-left tr-text-ui text-text-default hover:bg-control-bg-hovered disabled:opacity-60"
							>
								<Icon
									className={`size-14 shrink-0 ${checked ? "text-primary" : "text-text-muted"}`}
									aria-hidden="true"
								/>
								<span className="min-w-0 flex-1 truncate">{project.name}</span>
								{joining && (
									<span className="tr-text-metadata text-text-muted">
										{t("issues.repositoriesJoining")}
									</span>
								)}
							</button>
						);
					})}
				</div>
			)}
			{notice && (
				<p
					role={notice.kind === "cleaned" ? "status" : "alert"}
					data-testid="issue-repositories-notice"
					className={`tr-text-metadata ${notice.kind === "cleaned" ? "text-text-muted" : "text-feedback-error"}`}
				>
					{notice.kind === "cleaned"
						? notice.count > 0
							? t("issues.repositoriesCleaned", { count: notice.count })
							: t("issues.repositoriesCleanNone")
						: notice.kind === "cleanupFailed"
							? t("issues.repositoriesCleanupFailed")
							: notice.detail
								? `${t("issues.repositoriesJoinFailed")} ${notice.detail}`
								: t("issues.repositoriesJoinFailed")}
				</p>
			)}
			{joinable && onCleanup && count > 0 && (
				<Button
					variant="ghost"
					size="s"
					disabled={busy !== null}
					data-testid="issue-repositories-cleanup"
					onClick={() => {
						run("cleanup", onCleanup);
					}}
				>
					{t("issues.repositoriesCleanup")}
				</Button>
			)}
		</>
	);
}

export const ISSUE_REPOSITORIES_ERROR_KEY: MessageKey = "issues.repositoriesFailed";
