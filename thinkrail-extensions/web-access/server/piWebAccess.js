export default async function piWebAccess(pi, allowRanges = []) {
	const { default: factory, runWithThinkrailSsrfAllowRanges } = await import(
		"pi-web-access/dist/index.js"
	);
	const scopedPi = new Proxy(pi, {
		get(target, key, receiver) {
			const value = Reflect.get(target, key, receiver);
			if (key !== "registerTool" || typeof value !== "function") return value;
			return (tool) =>
				value.call(target, {
					...tool,
					...(typeof tool.execute === "function"
						? {
								execute: (...args) =>
									runWithThinkrailSsrfAllowRanges(allowRanges, () => tool.execute(...args)),
							}
						: {}),
				});
		},
	});
	await factory(scopedPi);
}
