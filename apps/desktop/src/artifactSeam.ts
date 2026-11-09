const ARTIFACT_TEST_ENVIRONMENT_KEYS = [
	"THINKRAIL_DESKTOP_READY_FILE",
	"THINKRAIL_DESKTOP_CONTROL_FILE",
	"THINKRAIL_DESKTOP_USER_DATA",
	"THINKRAIL_DESKTOP_E2E_HOST",
	"THINKRAIL_DESKTOP_HIDDEN",
	"THINKRAIL_DESKTOP_NAVIGATION_PROBE_FILE",
] as const;

export function hasDesktopArtifactTestSeam(
	environment: Readonly<Record<string, string | undefined>>,
): boolean {
	return ARTIFACT_TEST_ENVIRONMENT_KEYS.some((key) => Boolean(environment[key]));
}
