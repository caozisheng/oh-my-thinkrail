import type { IssueImplementationRecovery } from "@thinkrail/contracts";
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
import { useState } from "react";

export function IssueRecoveryDialog({
	diagnosis,
	pending,
	onClose,
	onConfirm,
}: {
	diagnosis: IssueImplementationRecovery;
	pending: boolean;
	onClose: () => void;
	onConfirm: (restart: boolean) => void;
}) {
	const t = useT();
	const [restartConfirmed, setRestartConfirmed] = useState(false);
	const restartStep = diagnosis.requiresRestart && !restartConfirmed;
	const blockedReason =
		diagnosis.reason === "missing-record"
			? t("issues.recovery.reason.missing-record")
			: diagnosis.reason === "not-completed"
				? t("issues.recovery.reason.not-completed")
				: diagnosis.reason === "pending-operation"
					? t("issues.recovery.reason.pending-operation")
					: t("issues.recovery.reason.resources-remain");
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !pending) onClose();
			}}
		>
			<DialogContent className="max-w-lg" hideClose={pending}>
				<DialogHeader>
					<DialogTitle>
						{t(restartStep ? "issues.recovery.restartTitle" : "issues.recovery.title")}
					</DialogTitle>
					<DialogDescription>{t("issues.recovery.description")}</DialogDescription>
				</DialogHeader>
				{diagnosis.status === "available" ? (
					<>
						<p className="tr-text-ui text-text-muted">{t("issues.recovery.evidence")}</p>
						{diagnosis.members.map((member) => (
							<div key={member.projectId} className="flex flex-col gap-4 tr-text-ui">
								<span className="break-all">{member.worktreePath}</span>
								<span className="break-all text-text-muted">{member.branch}</span>
								<code className="tr-code-text break-all">{member.baseCommit}</code>
							</div>
						))}
						<p className="tr-text-ui text-feedback-warning">{t("issues.recovery.loss")}</p>
					</>
				) : (
					<p role="alert" className="tr-text-ui text-feedback-warning">
						{blockedReason}
					</p>
				)}
				<DialogFooter>
					<Button variant="outline" disabled={pending} onClick={onClose}>
						{t(
							diagnosis.status === "available" ? "issues.recovery.cancel" : "issues.history.close",
						)}
					</Button>
					{diagnosis.status === "available" && (
						<Button
							disabled={pending}
							onClick={() => {
								if (restartStep) setRestartConfirmed(true);
								else onConfirm(restartConfirmed);
							}}
						>
							{t(restartStep ? "issues.recovery.restartConfirm" : "issues.recovery.confirm")}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
