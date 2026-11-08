import type { IssueContent } from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { issueHtmlImages } from "./htmlImages";

export type IssuePreview = {
	key: string;
	identity: string;
	status: "loading" | "error" | "ready";
	content?: IssueContent;
};

export function issueResourceUrl(value: string, base: string): string {
	try {
		const url = new URL(value, base);
		return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
			? url.href
			: "";
	} catch {
		return "";
	}
}

export function IssueBody({
	preview,
	onRetry,
	id,
}: {
	preview: IssuePreview;
	onRetry: () => void;
	id: string;
}) {
	const t = useT();
	return (
		<div
			id={id}
			data-testid="issue-body"
			className="max-h-320 overflow-auto overscroll-contain break-words border-t border-border-muted pt-8"
		>
			{preview.status === "loading" ? (
				<p role="status">{t("common.loading")}</p>
			) : preview.status === "error" ? (
				<div role="alert" className="flex flex-col gap-4">
					<p className="text-feedback-error">{t("issues.previewError")}</p>
					<Button size="s" variant="ghost" onClick={onRetry}>
						{t("issues.previewRetry")}
					</Button>
				</div>
			) : !preview.content?.description.trim() ? (
				<p className="text-text-muted">{t("issues.previewEmpty")}</p>
			) : (
				<div className="tr-prose-chat min-w-0 [&_a]:text-primary [&_a]:underline [&_img]:h-auto [&_img]:max-w-full [&_p]:my-8 [&_ul]:list-disc [&_ul]:pl-16 [&_ol]:list-decimal [&_ol]:pl-16 [&_pre]:overflow-auto [&_table]:border-collapse [&_td]:border [&_td]:border-border-muted [&_td]:p-4 [&_th]:border [&_th]:border-border-muted [&_th]:p-4">
					<ReactMarkdown
						remarkPlugins={[remarkGfm, issueHtmlImages]}
						skipHtml
						urlTransform={(url) => issueResourceUrl(url, preview.content?.url ?? "")}
						components={{
							a: ({ children, href }) => (
								<a href={href || undefined} target="_blank" rel="noopener noreferrer">
									{children}
								</a>
							),
							img: ({ src, alt }) =>
								src ? (
									<img src={src} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" />
								) : (
									<span>{alt}</span>
								),
						}}
					>
						{preview.content.description}
					</ReactMarkdown>
				</div>
			)}
		</div>
	);
}
