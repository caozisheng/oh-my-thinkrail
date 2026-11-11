import type { Workspace } from "@thinkrail/contracts";
import type { CreateSessionResult } from "../agent";
import { createHostSession } from "./createHostSession";
import type { NewChatModelRequest } from "./newChatModel";

export interface ChatStartOptions {
	readonly pick?: boolean;
	readonly assertClaimed?: () => void;
}

export async function startChatSession(
	workspace: Workspace,
	requested: NewChatModelRequest,
	{ pick = false, assertClaimed = () => {} }: ChatStartOptions = {},
): Promise<CreateSessionResult> {
	try {
		return await createHostSession({ workspaceId: workspace.id, ...requested }, assertClaimed, {
			pick,
		});
	} catch (error) {
		assertClaimed();
		throw error;
	}
}
