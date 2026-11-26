import { RiChatNewLine } from "@remixicon/react";
import type { Workspace } from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";

export function GroupWorkspaceWelcome({
	workspace,
	name,
	starting,
	onStart,
}: {
	workspace: Workspace;
	name: string;
	starting: boolean;
	onStart: () => void;
}) {
	const t = useT();
	return (
		<div
			data-testid="workspace-ready"
			className="flex h-full flex-col items-center justify-center gap-4 px-16 text-center"
		>
			<span className="tr-text-eyebrow text-text-muted">{t("panels.groupHome.workbench")}</span>
			<h2 className="max-w-full truncate tr-title-entity text-text-default">{name}</h2>
			<p className="max-w-full truncate tr-code-text text-text-muted">{workspace.worktreePath}</p>
			<p className="mt-4 tr-text-ui text-text-muted">{t("panels.groupHome.workbenchHint")}</p>
			<Button
				variant="outline"
				size="m"
				iconLeft={RiChatNewLine}
				loading={starting}
				data-testid="start-chat"
				data-starting={starting || undefined}
				disabled={starting}
				onClick={onStart}
				className="mt-4"
			>
				{t(starting ? "shell.workbench.ready.startingChat" : "shell.workbench.ready.newChat")}
			</Button>
		</div>
	);
}
