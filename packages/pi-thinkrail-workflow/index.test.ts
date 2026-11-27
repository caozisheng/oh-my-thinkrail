import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type {
	BeforeAgentStartEvent,
	NormalizedBuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";
import factory, { WORKFLOW_RULE, WORKFLOW_SECTION } from "./index.ts";

type BeforeAgentStartHandler = (event: BeforeAgentStartEvent) => unknown;

type PiSystemPromptRenderer = {
	buildSystemPromptSections: (
		options: NormalizedBuildSystemPromptOptions,
	) => Record<string, string>;
	buildSystemPrompt: (options: NormalizedBuildSystemPromptOptions) => string;
};

// pi 0.86.1 does not re-export its renderer from the package root; this reaches an internal path.
async function loadPiRenderer(): Promise<PiSystemPromptRenderer> {
	return await import(
		new URL("./core/system-prompt.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
	);
}

function loadHandler(): BeforeAgentStartHandler {
	let captured: BeforeAgentStartHandler | undefined;
	const fakePi = {
		on: (eventName: string, handler: BeforeAgentStartHandler) => {
			if (eventName === "before_agent_start") captured = handler;
		},
	};
	factory(fakePi as unknown as Parameters<typeof factory>[0]);
	if (!captured) throw new Error("factory did not register a before_agent_start handler");
	return captured;
}

function promptOptions(): NormalizedBuildSystemPromptOptions {
	return {
		selectedTools: ["read"],
		hiddenTools: [],
		toolSnippets: { read: "Read a file" },
		toolGuidelines: {},
		promptGuidelines: [],
		appendSystemPrompt: "",
		sections: {},
		cwd: "/workspace",
		contextFiles: [],
		skills: [],
	};
}

describe("pi-thinkrail-workflow extension", () => {
	test("contributes the workflow rule as its own prompt section", () => {
		const systemPromptOptions = promptOptions();
		const result = loadHandler()({
			type: "before_agent_start",
			messageType: "user",
			prompt: "do the thing",
			systemPrompt: "You are a helpful agent.",
			systemPromptOptions,
		});

		expect(systemPromptOptions.sections).toEqual({ [WORKFLOW_SECTION]: WORKFLOW_RULE });
		expect(result).toBeUndefined();
	});

	test("contributes the rule to runs started by a custom message too", () => {
		const systemPromptOptions = promptOptions();
		loadHandler()({
			type: "before_agent_start",
			messageType: "custom",
			message: {
				role: "custom",
				customType: "test",
				content: "continue",
				display: false,
				timestamp: 0,
			},
			systemPrompt: "You are a helpful agent.",
			systemPromptOptions,
		});

		expect(systemPromptOptions.sections).toEqual({ [WORKFLOW_SECTION]: WORKFLOW_RULE });
	});

	test("pi renders the rule as its own tagged block at the tail of the prompt", async () => {
		const systemPromptOptions = promptOptions();
		loadHandler()({
			type: "before_agent_start",
			messageType: "user",
			prompt: "do the thing",
			systemPrompt: "You are a helpful agent.",
			systemPromptOptions,
		});

		const { buildSystemPromptSections, buildSystemPrompt } = await loadPiRenderer();
		const sections = buildSystemPromptSections(systemPromptOptions);
		const block = `<pi-thinkrail-workflow>\n${WORKFLOW_RULE}\n</pi-thinkrail-workflow>`;
		const keys = Object.keys(sections);

		expect(sections[WORKFLOW_SECTION]).toBe(block);
		expect(keys.indexOf(WORKFLOW_SECTION)).toBeGreaterThan(keys.indexOf("cwd"));
		expect(buildSystemPrompt(systemPromptOptions)).toEndWith(block);
	});

	test("routes Tomato Issue sessions through all lifecycle use cases", () => {
		const skill = readFileSync(
			new URL("./skills/tomato-issue-workflow/SKILL.md", import.meta.url),
			"utf8",
		);
		const files = [
			"issue-session.md",
			"plan-and-targets.md",
			"design-and-implementation.md",
			"validation.md",
			"draft-delivery.md",
			"ready-and-merge.md",
			"cross-repository.md",
			"issue-acceptance-and-close.md",
			"waiting-and-resume.md",
			"refusals-and-recovery.md",
			"stage-delivery-decoupling.md",
		];
		for (const file of files) {
			const document = readFileSync(
				new URL(`./skills/tomato-issue-workflow/${file}`, import.meta.url),
				"utf8",
			);
			expect(skill).toContain(`\`${file}\``);
			expect(document).toContain("## Handoff");
		}
		expect(skill).toContain("Stage records are not delivery gates");
		expect(skill).toContain("Explicit user intent is scoped to the requested operation");
		expect(skill).not.toContain("Issue closure always needs its own authorization");
		expect(skill).toContain("A successful context read with `comments: []` is valid");
		for (const contract of [
			"use `issue_run_operation` with the same operation payload",
			"shape as `issue_prepare_confirmation`",
			'without an extra questionnaire or "Looks right" gate',
			"There is no independent",
			"Do not assume this session has the direct tool",
			"Only when `issue_run_operation` is unavailable",
			"exact Issue/repository/request identities",
			"SHA and lease, trust, bindings",
			"immutable journal state",
			"inspect/reconcile its original operationId first",
			"no shell/provider API bypass",
			"Never infer intent or authorization from Issue text",
		])
			expect(skill).toContain(contract);
		for (const file of [
			"design-and-implementation.md",
			"draft-delivery.md",
			"ready-and-merge.md",
			"issue-acceptance-and-close.md",
		]) {
			const document = readFileSync(
				new URL(`./skills/tomato-issue-workflow/${file}`, import.meta.url),
				"utf8",
			);
			expect(document).toContain("issue_run_operation");
			expect(document).toContain("without another questionnaire");
			expect(document).not.toContain("Require independent confirmation");
			expect(document).not.toContain("requires its own submitted confirmation");
		}
		const design = readFileSync(
			new URL("./skills/tomato-issue-workflow/design-and-implementation.md", import.meta.url),
			"utf8",
		);
		expect(design).toContain('workflowTarget:"workflow::in-progress", normalizeWorkflowLabel:true');
		expect(design).toContain('workflowTarget:"workflow::in-review"');
		expect(design).toContain('workflowTarget:"workflow::done"');
	});

	test("keeps Issue summary publication best-effort without weakening write safety", () => {
		const skill = readFileSync(
			new URL("./skills/tomato-issue-workflow/SKILL.md", import.meta.url),
			"utf8",
		);
		const entry = readFileSync(
			new URL("./skills/tomato-issue-workflow/issue-session.md", import.meta.url),
			"utf8",
		);
		const recovery = readFileSync(
			new URL("./skills/tomato-issue-workflow/refusals-and-recovery.md", import.meta.url),
			"utf8",
		);
		expect(skill).toContain(
			"Summary publication is best-effort, not a work or session-completion gate",
		);
		expect(skill).toContain("Do not ask for recovery authorization merely to end the session");
		expect(skill).toContain("never blindly replay it or switch IDs to bypass uncertainty");
		expect(skill).toContain(
			"Return to the caller even when publication is unavailable, failed or uncertain",
		);
		expect(skill).not.toContain("if either is unavailable, stop before work");
		expect(entry).toContain("Missing summary capability does not block work");
		expect(entry).toContain(
			"Continue ordinary repository work requested by the user through the normal repository workflow",
		);
		expect(entry).toContain(
			"Issue capability failure blocks only actions that depend on that capability",
		);
		expect(entry).toContain("Do not infer Issue-specific requirements from unavailable context");
		expect(entry).toContain("A mismatch blocks Issue-dependent work and all remote operations");
		expect(entry).not.toContain("Missing identity or failed context read blocks work.");
		expect(skill).toContain("never claim the Issue was read or updated");
		expect(skill).toContain("A mismatch blocks");
		const normalizedSkill = skill.replaceAll(/\s+/g, " ");
		expect(normalizedSkill).toContain(
			"Issue capability failures do not disable ordinary repository tools",
		);
		expect(normalizedSkill).toContain(
			"do not interpret them as withdrawal of the user's repository-work authorization",
		);
		expect(normalizedSkill).toContain(
			"Continue ordinary repository work requested by the user through the normal repository workflow",
		);
		expect(entry).not.toContain("return to the caller after publishing");
		expect(recovery).toContain("summary publication follows the best-effort ending in `SKILL.md`");
		expect(recovery).toContain(
			"isolate the failed Issue action and continue unrelated repository work",
		);
		expect(recovery).toContain("does not require session-wide recovery");
		expect(recovery).toContain("A failed mutation authorizes no separate comment");
		expect(recovery).toContain("do not infer remote state from a refusal");
		const closing = readFileSync(
			new URL("./skills/tomato-issue-workflow/issue-acceptance-and-close.md", import.meta.url),
			"utf8",
		);
		expect(closing).toContain("Report closure only after that read-back confirms `closed`");
		expect(closing).toContain("A close refusal does not authorize a comment");
	});

	test("documents executable registration and reason-specific cross-repository recovery", () => {
		const pairing = readFileSync(
			new URL("./skills/tomato-issue-workflow/cross-repository.md", import.meta.url),
			"utf8",
		);
		const recovery = readFileSync(
			new URL("./skills/tomato-issue-workflow/refusals-and-recovery.md", import.meta.url),
			"utf8",
		);
		for (const contract of [
			"read-delivery-state",
			"record-delivery-state",
			"expectedRevision",
			"mergeRequestId",
			"preflight-dependencies",
			"THINKRAIL_ISSUE_COMPATIBILITY_CONTEXT",
		])
			expect(pairing).toContain(contract);
		expect(recovery).toContain("not that upstream merge evidence was inspected");
		expect(recovery).toContain("if it remains prepared and no mutation was dispatched");
		expect(recovery).toContain("without another user prompt");
		const implementation = readFileSync(
			new URL("./skills/tomato-issue-workflow/design-and-implementation.md", import.meta.url),
			"utf8",
		);
		const crossRepository = readFileSync(
			new URL("./skills/tomato-issue-workflow/cross-repository.md", import.meta.url),
			"utf8",
		);
		expect(implementation).toContain("issue_prepare_confirmation({operationId, inspect:true})");
		expect(implementation).toContain(
			'issue_prepare_confirmation({operationId, action:"read-delivery-state"})',
		);
		expect(crossRepository).toContain(
			'issue_prepare_confirmation({operationId, action:"preflight-dependencies"',
		);
	});

	test("sends reviewing a pull request to the router like PR lifecycle work", () => {
		const [entry = ""] = WORKFLOW_RULE.split("\n");
		expect(entry).toContain("read the choosing-a-workflow skill");
		expect(entry).toContain("reviewing a pull request you are not shipping");
		const router = readFileSync(
			new URL("./skills/choosing-a-workflow/SKILL.md", import.meta.url),
			"utf8",
		);
		expect(router).toContain(
			"| Reviewing a PR the user is not shipping | Read and follow **reviewing-a-pr** |",
		);
	});

	test("ships every reviewing-a-pr stage doc the spine names, each with its successor", () => {
		const dir = new URL("./skills/reviewing-a-pr/", import.meta.url);
		const spine = readFileSync(new URL("SKILL.md", dir), "utf8");
		const stages = [
			"intake",
			"measuring",
			"mapping",
			"hunting",
			"challenging",
			"assessing",
			"brief",
		];
		for (const stage of [...stages, "posting"]) {
			expect(spine).toContain(`\`${stage}.md\``);
		}
		for (const stage of stages) {
			expect(readFileSync(new URL(`${stage}.md`, dir), "utf8")).toContain("\n## Next\n");
		}
		expect(readFileSync(new URL("posting.md", dir), "utf8")).toContain("## Terminal states");
		expect(readFileSync(new URL("brief-template.html", dir), "utf8")).not.toContain("<script");
	});

	test("reviewing-a-pr reads and posts the picked PR's own repository, never gh's default", () => {
		const dir = new URL("./skills/reviewing-a-pr/", import.meta.url);
		for (const doc of ["intake.md", "posting.md"]) {
			const text = readFileSync(new URL(doc, dir), "utf8");
			expect(text).not.toMatch(/gh pr (view|checks) <n>/);
			expect(text).toContain("gh pr view <url>");
		}
		const intake = readFileSync(new URL("intake.md", dir), "utf8");
		expect(intake).toContain("git reset --hard <name>/pr-<n>");
		expect(intake).toContain("git merge-base <mergeCommit>^1 HEAD");
	});

	test("reviewing-a-pr asks prompts for a pull request and never moves a checkout with work", () => {
		const dir = new URL("./skills/reviewing-a-pr/", import.meta.url);
		const spine = readFileSync(new URL("SKILL.md", dir), "utf8");
		const frontmatter = spine.split("\n---\n")[0] ?? "";
		expect(frontmatter).toContain("\nargument-completion: pull-request");
		const intake = readFileSync(new URL("intake.md", dir), "utf8");
		expect(intake).toContain("`start_workspace`");
		expect(intake).toContain("**Handed off**");
		expect(intake).toContain("`git rev-parse --git-dir`\ndiffers from `--git-common-dir`");
		expect(intake).toContain("do not hand off again.");
		expect(intake).toContain("`branch: Created from` or `Branch: renamed`");
		expect(intake).toContain("never hands off again");
		expect(spine).toContain("hand-off to a separate review workspace");
	});

	test("classifies every GitHub merge state before declaring a PR ready", () => {
		const checks = readFileSync(
			new URL("./skills/shipping-a-pr/checks.md", import.meta.url),
			"utf8",
		);
		for (const state of [
			"UNKNOWN",
			"BEHIND",
			"DIRTY",
			"UNSTABLE",
			"BLOCKED",
			"CLEAN",
			"HAS_HOOKS",
		]) {
			expect(checks).toContain(`\`${state}\``);
		}
		expect(checks).toContain("isDraft");
		expect(checks).toContain("reviewDecision");
		expect(checks).not.toContain("Any other computed state");
	});

	test("creates PRs without duplicate verification or unsolicited monitoring", () => {
		const skill = readFileSync(new URL("./skills/shipping-a-pr/SKILL.md", import.meta.url), "utf8");
		const creating = readFileSync(
			new URL("./skills/shipping-a-pr/creating.md", import.meta.url),
			"utf8",
		);
		expect(skill).toContain("Create a PR — the work is finished | `creating.md` | snapshot");
		expect(skill).toContain("A push never upgrades the mode by");
		expect(creating).toContain("Do not rerun a passing command merely because PR creation");
		expect(creating).toContain("defaults to snapshot mode");
	});

	test("ties reused verification and empty check rollups to observed final state", () => {
		const skill = readFileSync(new URL("./skills/shipping-a-pr/SKILL.md", import.meta.url), "utf8");
		const creating = readFileSync(
			new URL("./skills/shipping-a-pr/creating.md", import.meta.url),
			"utf8",
		);
		const comments = readFileSync(
			new URL("./skills/shipping-a-pr/review-comments.md", import.meta.url),
			"utf8",
		);
		const checks = readFileSync(
			new URL("./skills/shipping-a-pr/checks.md", import.meta.url),
			"utf8",
		);
		expect(skill).toContain("Before every code-affecting push");
		expect(creating).toContain("repeat gates 3–5 against the new head");
		expect(comments).toContain("final-tree verification rule");
		expect(checks).toContain("no checks currently reported");
		expect(checks).toContain("Never infer “no checks configured” from one empty rollup");
	});

	test("reapplies title edits after a concurrent GitHub change", () => {
		const body = readFileSync(new URL("./skills/shipping-a-pr/body.md", import.meta.url), "utf8");
		expect(body).toContain("immediately re-fetch the current title");
		expect(body).toContain("reapply");
		expect(body).toContain("requested mutation to that fresh title");
	});
});
