import { defineServerExtension } from "@thinkrail/extension-api/server";
import piWebAccess from "./piWebAccess.js";

export default defineServerExtension({
	name: "web-access",
	title: "Web access",
	description:
		"Lets the agent search the web, fetch pages, GitHub repositories, PDFs and videos, and research open-source libraries with its librarian skill.",
	extensions: [],
	childExtensions: [],
	settings: {
		allowRanges: {
			type: "cidr-list",
			default: [],
		},
	},
	sessionExtensions: (services) => [
		(pi) => piWebAccess(pi, services.cidrListSetting("allowRanges")),
	],
	childSessionExtensions: (settings) => [
		(pi) => piWebAccess(pi, settings.cidrListSetting("allowRanges")),
	],
	skillPackages: ["@thinkrail/ext-web-access"],
});
