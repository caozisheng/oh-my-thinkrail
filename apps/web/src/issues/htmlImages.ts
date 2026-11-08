import { type DefaultTreeAdapterMap, parseFragment } from "parse5";

interface MarkdownNode {
	type: string;
	value?: string;
	url?: string;
	alt?: string;
	children?: MarkdownNode[];
}

export function issueHtmlImages() {
	return (tree: MarkdownNode) => {
		for (const node of tree.children ?? []) {
			if (node.type !== "html" || !node.value) continue;
			const images: MarkdownNode[] = [];
			const collect = (element: DefaultTreeAdapterMap["childNode"]) => {
				if ("tagName" in element) {
					if (["script", "style", "template", "iframe", "noscript"].includes(element.tagName))
						return;
					if (element.tagName === "img") {
						const attribute = (name: string) =>
							element.attrs.find((attr) => attr.name === name)?.value ?? "";
						images.push({ type: "image", url: attribute("src"), alt: attribute("alt") });
						return;
					}
				}
				if ("childNodes" in element) element.childNodes.forEach(collect);
			};
			parseFragment(node.value).childNodes.forEach(collect);
			node.type = "paragraph";
			node.children = images;
			delete node.value;
		}
	};
}
