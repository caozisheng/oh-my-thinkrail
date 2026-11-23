import type { TranscriptMessage } from "@thinkrail/contracts";

interface MatrixQuestion {
	question: string;
	options: { label: string; description: string }[];
	multiSelect: boolean;
}

export function matrixQuestions(
	messages: readonly TranscriptMessage[],
	toolCallId: string,
): MatrixQuestion[] | null {
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (
				block.type !== "toolCall" ||
				block.id !== toolCallId ||
				block.name !== "ask_user_question"
			)
				continue;
			const args: unknown = block.arguments;
			if (
				!args ||
				typeof args !== "object" ||
				!("questions" in args) ||
				!Array.isArray(args.questions)
			)
				return null;
			const result: MatrixQuestion[] = [];
			for (const item of args.questions) {
				if (
					!item ||
					typeof item !== "object" ||
					typeof item.question !== "string" ||
					!Array.isArray(item.options)
				)
					return null;
				const options: MatrixQuestion["options"] = [];
				for (const option of item.options) {
					if (
						!option ||
						typeof option !== "object" ||
						typeof option.label !== "string" ||
						typeof option.description !== "string"
					)
						return null;
					options.push({ label: option.label, description: option.description });
				}
				result.push({ question: item.question, options, multiSelect: item.multiSelect === true });
			}
			return result;
		}
	}
	return null;
}

export function matrixAnswer(questions: readonly MatrixQuestion[], text: string): unknown {
	if (text === "skip") return { answers: [], cancelled: true };
	const parts = text.split(";");
	if (parts.length !== questions.length)
		throw new Error("Answer each question separated by semicolons.");
	return {
		answers: questions.map((question, index) => {
			const part = parts[index]?.trim() ?? "";
			if (!part) throw new Error("Empty Matrix answer");
			if (part.startsWith("text:"))
				return {
					questionIndex: index,
					question: question.question,
					kind: "custom",
					answer: part.slice(5).trim(),
				};
			const numbers = part.split(",").map((value) => Number(value.trim()));
			if (
				numbers.some(
					(value) => !Number.isInteger(value) || value < 1 || value > question.options.length,
				) ||
				(!question.multiSelect && numbers.length !== 1)
			)
				throw new Error("Invalid Matrix answer option");
			const selected = numbers.map((value) => question.options[value - 1]?.label ?? "");
			return question.multiSelect
				? {
						questionIndex: index,
						question: question.question,
						kind: "multi",
						answer: selected.join(", "),
						selected,
					}
				: {
						questionIndex: index,
						question: question.question,
						kind: "option",
						answer: selected[0],
					};
		}),
		cancelled: false,
	};
}
