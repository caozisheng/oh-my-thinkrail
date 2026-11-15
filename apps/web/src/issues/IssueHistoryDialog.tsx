import type { IssueReference, WsMethodMap } from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@thinkrail/ui/dialog";
import { useEffect, useState } from "react";
import { getTransport } from "../transport";

type History = WsMethodMap["issues.implementationHistory"]["result"];
export function IssueHistoryDialog({
	projectId,
	reference,
	onClose,
}: {
	projectId: string;
	reference: IssueReference;
	onClose: () => void;
}) {
	const t = useT();
	const [history, setHistory] = useState<History | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		let active = true;
		void getTransport()
			.request("issues.implementationHistory", { projectId, reference })
			.then((value) => {
				if (active) setHistory(value);
			})
			.catch(() => {
				if (active) setFailed(true);
			});
		return () => {
			active = false;
		};
	}, [projectId, reference]);
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{t("issues.history.title")}</DialogTitle>
				</DialogHeader>
				{failed && (
					<p role="alert" className="text-feedback-error tr-text-ui">
						{t("issues.history.failed")}
					</p>
				)}
				{history?.entries.length === 0 && (
					<p className="text-text-muted tr-text-ui">{t("issues.history.empty")}</p>
				)}
				{history?.entries.map((entry) => (
					<section key={entry.workspaceId} className="flex flex-col gap-8">
						<p className="tr-text-ui break-all">{entry.branch}</p>
						{entry.messages === null ? (
							<p className="text-text-muted tr-text-ui">{t("issues.history.unavailable")}</p>
						) : (
							entry.messages
								.filter((message) => message.role === "user" || message.role === "assistant")
								.map((message, index) => (
									<pre
										key={`${entry.sessionId}-${index}`}
										className="tr-code-text whitespace-pre-wrap break-words"
									>
										{typeof message.content === "string"
											? message.content
											: message.content
													.flatMap((block) => (block.type === "text" ? [block.text] : []))
													.join("\n")}
									</pre>
								))
						)}
					</section>
				))}
			</DialogContent>
		</Dialog>
	);
}
