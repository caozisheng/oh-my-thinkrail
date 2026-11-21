import { RiQuestionLine } from "@remixicon/react";
import { useT } from "@thinkrail/locales/react";

export function WorkspaceAttention() {
	const t = useT();
	const label = t("chat.attention.needed");
	return (
		<span
			data-testid="workspace-attention"
			role="img"
			aria-label={label}
			title={label}
			className="flex size-20 shrink-0 items-center justify-center text-feedback-warning"
		>
			<RiQuestionLine aria-hidden className="size-14" />
		</span>
	);
}
