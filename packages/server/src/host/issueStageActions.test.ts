import { expect, test } from "bun:test";
import { createIssueStageActions } from "./issueStageActions";

function fixture() {
	let issue = {
		iid: 38,
		title: "Confirm",
		description: "Original",
		state: "opened" as "opened" | "closed",
		labels: ["team", "workflow::backlog"],
		updatedAt: "1",
	};
	const notes: { id: number; body: string; createdAt: string }[] = [];
	const writes: unknown[] = [];
	const prepared = new Map<string, { digest: string; payload: unknown }>();
	const completed = new Map<string, unknown>();
	let answered = false;
	let dirty = false;
	let intents = 0;
	let sha = "a".repeat(40);
	const binding = {
		sessionId: "session",
		projectId: "local",
		workspaceId: "workspace",
		reference: {
			provider: "github" as const,
			instanceUrl: "https://github.com",
			projectId: "123",
			number: 38,
		},
		stage: "design" as "design" | "implementation",
		locale: "en",
	};
	const remote = {
		issue: async () => structuredClone(issue),
		notes: async () => notes,
		addNote: async (_iid: number, body: string) => {
			writes.push(body);
			const note = { id: notes.length + 1, body, createdAt: "2026-11-11T00:00:00Z" };
			notes.push(note);
			return note;
		},
		updateIssue: async (_iid: number, input: { labels?: string[] }) => {
			writes.push(input);
			issue = { ...issue, labels: input.labels ?? issue.labels };
			return issue;
		},
	};
	const actions = createIssueStageActions({
		binding: async () => binding,
		access: async () => ({ remote, guard: () => {} }),
		repositories: async () => [
			{
				projectId: "local",
				workspaceId: "workspace",
				name: "Repo",
				path: "/repo",
				role: "primary" as const,
			},
		],
		checkout: async () => ({ sha, branch: "feature", dirty }),
		verifyAnswer: async () => {
			if (!answered) throw new Error("missing answer");
		},
		journal: {
			prepare: async (_sid: string, op: string, payload: unknown) => {
				const entry = { digest: JSON.stringify(payload), payload };
				prepared.set(op, entry);
				return entry;
			},
			get: async (_sid: string, op: string) => prepared.get(op) ?? null,
			execute: async (
				_sid: string,
				op: string,
				_digest: string,
				_call: string,
				run: () => Promise<unknown>,
				preflight?: () => Promise<void>,
			) => {
				if (completed.has(op)) return completed.get(op);
				await preflight?.();
				intents++;
				const result = await run();
				completed.set(op, result);
				return result;
			},
			listCompleted: async () =>
				[...completed].map(([operationId, result]) => ({
					sessionId: "session",
					operationId,
					payload: prepared.get(operationId)?.payload,
					result,
				})),
		},
	});
	return {
		actions,
		get intents() {
			return intents;
		},
		setDirty: (value: boolean) => {
			dirty = value;
		},
		close: () => {
			issue = { ...issue, state: "closed" };
		},
		get issue() {
			return issue;
		},
		writes,
		notes,
		binding,
		approve: () => {
			answered = true;
		},
		changeIssue: () => {
			issue = { ...issue, updatedAt: "2" };
		},
		changeSha: () => {
			sha = "b".repeat(40);
		},
		setLabels: (labels: string[]) => {
			issue = { ...issue, labels };
		},
	};
}

test("stage recovery observes a unique report and labels without writing again", async () => {
	const f = fixture();
	await f.actions.prepare("session", { operationId: "design", report: "Full design" });
	f.approve();
	await f.actions.execute("session", "design", "answer");
	const payload = {
		sessionId: "session",
		reference: f.binding.reference,
		stage: "design" as const,
		operationId: "design",
		report: "Full design",
		issueRevision: "ignored-for-observation",
		designOperationId: null,
		commits: [],
	};
	const before = f.writes.length;
	expect(await f.actions.observe("session", payload)).toMatchObject({
		result: { stage: "design", noteId: 1 },
	});
	expect(f.writes).toHaveLength(before);
	f.notes.push({ id: 2, body: "Full design", createdAt: "later" });
	await expect(f.actions.observe("session", payload)).rejects.toThrow("ambiguous-or-missing");
});

test("design requires a real answer before publishing exact report and preserving unrelated labels", async () => {
	const f = fixture();
	const prepared = await f.actions.prepare("session", {
		operationId: "design",
		report: "Full design",
	});
	expect(prepared.questions.questions[0]?.options).toEqual([
		{ label: "Looks right", description: expect.any(String) },
	]);
	await expect(f.actions.execute("session", "design", "answer")).rejects.toThrow();
	expect(f.writes).toEqual([]);
	f.approve();
	const result = await f.actions.execute("session", "design", "answer");
	expect(result).toMatchObject({ stage: "design", noteId: 1 });
	expect(f.notes[0]?.body).toContain("Full design");
	expect(f.writes[1]).toEqual({ labels: ["team", "workflow::in-progress"] });
});

test("changed Issue snapshot invalidates the card before writes", async () => {
	const f = fixture();
	await f.actions.prepare("session", { operationId: "design", report: "Full design" });
	f.approve();
	f.changeIssue();
	await expect(f.actions.execute("session", "design", "answer")).rejects.toThrow();
	expect(f.writes).toEqual([]);
});

test("implementation binds the confirmed design and every observed repository commit", async () => {
	const f = fixture();
	await f.actions.prepare("session", { operationId: "design", report: "Full design" });
	f.approve();
	await f.actions.execute("session", "design", "answer");
	f.binding.stage = "implementation";
	const prepared = await f.actions.prepare("session", {
		operationId: "implementation",
		report: "Implementation report",
	});
	expect(prepared.questions.questions[0]?.preview).toContain("a".repeat(40));
	f.changeSha();
	await expect(f.actions.execute("session", "implementation", "answer2")).rejects.toThrow();
	expect(f.writes).toHaveLength(2);
});

test("stage transition rejects an invalid source workflow label before publishing", async () => {
	const f = fixture();
	f.setLabels(["workflow::in-review"]);
	await expect(
		f.actions.prepare("session", { operationId: "design", report: "Full design" }),
	).rejects.toThrow();
	expect(f.writes).toEqual([]);
});

test("implementation cannot silently invent an approved design", async () => {
	const f = fixture();
	f.binding.stage = "implementation";
	await expect(
		f.actions.prepare("session", { operationId: "implementation", report: "Report" }),
	).rejects.toThrow();
	expect(f.writes).toEqual([]);
});

test("missing design requires a warned card and a real answer", async () => {
	const f = fixture();
	f.binding.stage = "implementation";
	f.setLabels(["team", "workflow::in-progress"]);
	await expect(
		f.actions.prepare("session", { operationId: "impl", report: "Report" }),
	).rejects.toThrow("No completed design receipt was found. Retry with continueDespiteChecks:true");
	const card = await f.actions.prepare("session", {
		operationId: "impl",
		report: "Report",
		continueDespiteChecks: true,
	});
	expect(card.questions.questions[0]?.preview).toContain("Warnings requiring explicit approval:");
	expect(card.questions.questions[0]?.preview).toContain("No completed design receipt");
	await expect(f.actions.execute("session", "impl", "answer")).rejects.toThrow("missing answer");
	expect(f.writes).toEqual([]);
	expect(f.intents).toBe(0);
	f.approve();
	await f.actions.execute("session", "impl", "answer");
	expect(f.writes[1]).toEqual({ labels: ["team", "workflow::in-review"] });
});

test("dirty checkout, closed Issue and invalid multiple labels require explicit reviewed exceptions", async () => {
	const f = fixture();
	f.binding.stage = "implementation";
	f.setLabels(["team", "workflow::backlog", "workflow::in-review"]);
	f.setDirty(true);
	f.close();
	const card = await f.actions.prepare("session", {
		operationId: "impl",
		report: "Report",
		continueDespiteChecks: true,
	});
	const preview = card.questions.questions[0]?.preview;
	for (const warning of [
		"Issue is closed",
		"multiple workflow labels",
		"expected source stage",
		"No completed design receipt",
		"Checkout is dirty",
	])
		expect(preview).toContain(warning);
	await expect(f.actions.execute("session", "impl", "answer")).rejects.toThrow();
	expect(f.writes).toEqual([]);
	f.approve();
	await f.actions.execute("session", "impl", "answer");
	expect(f.writes[1]).toEqual({ labels: ["team", "workflow::in-review"] });
	expect(f.issue.state).toBe("closed");
});

for (const fact of ["issue", "sha", "dirty", "labels", "binding"] as const) {
	test(`warned cards reject changed ${fact} before intent or writes`, async () => {
		const f = fixture();
		f.binding.stage = "implementation";
		f.setDirty(true);
		await f.actions.prepare("session", {
			operationId: "impl",
			report: "Report",
			continueDespiteChecks: true,
		});
		f.approve();
		if (fact === "issue") f.changeIssue();
		if (fact === "sha") f.changeSha();
		if (fact === "dirty") f.setDirty(false);
		if (fact === "labels") f.setLabels(["other"]);
		if (fact === "binding") f.binding.reference.number = 39;
		await expect(f.actions.execute("session", "impl", "answer")).rejects.toThrow();
		expect(f.writes).toEqual([]);
		expect(f.intents).toBe(0);
	});
}
