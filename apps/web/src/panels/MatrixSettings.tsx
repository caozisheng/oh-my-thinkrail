import {
	RiErrorWarningLine,
	RiLoader4Line,
	RiLogoutBoxLine,
	RiRefreshLine,
} from "@remixicon/react";
import {
	canonicalMatrixHomeserver,
	isMatrixConnectionInput,
	MATRIX_PROTOCOL_VERSION,
	type MatrixConnectionInput,
	type MatrixStatus,
} from "@thinkrail/contracts";
import { T, useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import { useCallback, useEffect, useRef, useState } from "react";
import { SETTINGS_INPUT, SettingsGroup, SettingsPage, SettingsRow } from "@/settingsKit";
import { useAppStore } from "@/store";
import { getTransport } from "@/transport";
import { ConfirmDialog } from "./ConfirmDialog";

export function MatrixSettings() {
	const t = useT();
	const protocol = useAppStore((state) => state.protocolVersion);
	const [status, install] = useState<MatrixStatus | null>(null);
	const [homeserver, setHomeserver] = useState("");
	const [botUserId, setBotUserId] = useState("");
	const [controllerUserId, setControllerUserId] = useState("");
	const [mode, setMode] = useState<"password" | "access-token">("password");
	const [secret, setSecret] = useState("");
	const [acknowledged, setAcknowledged] = useState(false);
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	const [confirmDisconnect, setConfirmDisconnect] = useState(false);
	const requestGeneration = useRef(0);
	const mounted = useRef(false);
	const refresh = useCallback(() => {
		const generation = ++requestGeneration.current;
		getTransport()
			.request("matrix.status", {})
			.then(
				(value) => {
					if (mounted.current && generation === requestGeneration.current) install(value);
				},
				() => {
					if (mounted.current && generation === requestGeneration.current) setFailed(true);
				},
			);
	}, []);
	useEffect(() => {
		mounted.current = true;
		refresh();
		const unsubscribe = getTransport().subscribe("matrix.changed", (value) => {
			requestGeneration.current++;
			install(value as MatrixStatus);
		});
		return () => {
			mounted.current = false;
			requestGeneration.current++;
			unsubscribe();
		};
	}, [refresh]);
	const request = async (
		method: "matrix.configure" | "matrix.disconnect" | "matrix.sync",
		input: MatrixConnectionInput | Record<string, never>,
	) => {
		const generation = ++requestGeneration.current;
		const current = () => mounted.current && generation === requestGeneration.current;
		setBusy(true);
		setFailed(false);
		try {
			const value = await getTransport().request(method, input);
			if (current()) install(value);
		} catch {
			if (current()) setFailed(true);
		}
		if (mounted.current) setBusy(false);
	};

	const submit = async () => {
		const input = {
			operationId: crypto.randomUUID(),
			homeserver,
			botUserId,
			controllerUserId,
			plaintextAcknowledged: acknowledged,
			mode,
			...(mode === "password" ? { password: secret } : { accessToken: secret }),
		} as MatrixConnectionInput;
		if (!isMatrixConnectionInput(input)) {
			setFailed(true);
			return;
		}
		setSecret("");
		void request("matrix.configure", input);
	};
	const disconnect = () => setConfirmDisconnect(true);
	const sync = () => void request("matrix.sync", {});

	if (protocol === null || protocol < MATRIX_PROTOCOL_VERSION) return null;
	const connected = status?.hasCredential === true || Boolean(status?.operationId);
	const phase = status?.phase ?? "disconnected";
	const phaseKey = {
		authenticating: "settings.matrix.phase.authenticating",
		connected: "settings.matrix.phase.connected",
		disconnected: "settings.matrix.phase.disconnected",
		error: "settings.matrix.phase.error",
		paused: "settings.matrix.phase.paused",
		syncing: "settings.matrix.phase.syncing",
	} as const;
	const secretName =
		mode === "password" ? t("settings.matrix.password") : t("settings.matrix.accessToken");
	const valid =
		canonicalMatrixHomeserver(homeserver) !== null &&
		botUserId.length > 0 &&
		controllerUserId.length > 0 &&
		acknowledged &&
		secret.length > 0;
	return (
		<SettingsPage
			title={t("settings.nav.matrix")}
			description={t("settings.matrix.pageDescription")}
			testId="settings-matrix"
		>
			<SettingsGroup
				title={t("settings.matrix.title")}
				description={t("settings.matrix.description")}
			>
				<SettingsRow
					settingId="matrix-integration"
					label={t("settings.matrix.statusLabel")}
					description={
						<div data-testid="matrix-status" data-phase={phase} className="flex items-center gap-2">
							{phase === "authenticating" || phase === "syncing" ? (
								<RiLoader4Line className="size-16 motion-safe:animate-spin" aria-hidden />
							) : null}
							{status?.error ? (
								<RiErrorWarningLine className="size-16 text-feedback-error" aria-hidden />
							) : null}
							<span>{t(phaseKey[phase])}</span>
						</div>
					}
				/>
				{status?.homeserver ? (
					<SettingsRow
						rowId="matrix-homeserverLabel-summary"
						label={t("settings.matrix.homeserverLabel")}
						description={<span>{status.homeserver}</span>}
					/>
				) : null}
				{status?.botUserId ? (
					<SettingsRow
						rowId="matrix-botLabel-summary"
						label={t("settings.matrix.botLabel")}
						description={<span>{status.botUserId}</span>}
					/>
				) : null}
				{status?.controllerUserId ? (
					<SettingsRow
						rowId="matrix-controllerLabel-summary"
						label={t("settings.matrix.controllerLabel")}
						description={<span>{status.controllerUserId}</span>}
					/>
				) : null}
				{connected ? (
					<>
						<SettingsRow
							rowId="matrix-syncNotReadyLabel"
							label={t("settings.matrix.syncNotReadyLabel")}
							description={<span>{t("settings.matrix.syncNotReady")}</span>}
						/>
						<SettingsRow
							rowId="matrix-actions"
							label={t("settings.matrix.actions")}
							control={
								<div className="flex flex-wrap gap-8">
									<Button
										tabIndex={0}
										variant="outline"
										size="m"
										iconLeft={RiRefreshLine}
										disabled={busy}
										onClick={sync}
									>
										{t("settings.matrix.syncNow")}
									</Button>
									<Button
										tabIndex={0}
										variant="outline"
										size="m"
										iconLeft={RiLogoutBoxLine}
										disabled={busy}
										onClick={disconnect}
									>
										{t("settings.matrix.disconnect")}
									</Button>
								</div>
							}
						/>
					</>
				) : (
					<>
						<SettingsRow
							rowId="matrix-homeserverLabel"
							label={t("settings.matrix.homeserverLabel")}
							control={
								<input
									tabIndex={0}
									type="url"
									autoComplete="url"
									value={homeserver}
									onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
										setHomeserver(event.target.value)
									}
									aria-label={t("settings.matrix.homeserverLabel")}
									placeholder={t("settings.matrix.homeserverPlaceholder")}
									className={SETTINGS_INPUT + " w-full"}
								/>
							}
						/>
						<SettingsRow
							rowId="matrix-botLabel"
							label={t("settings.matrix.botLabel")}
							control={
								<input
									tabIndex={0}
									value={botUserId}
									onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
										setBotUserId(event.target.value)
									}
									aria-label={t("settings.matrix.botLabel")}
									placeholder={t("settings.matrix.botPlaceholder")}
									className={SETTINGS_INPUT + " w-full"}
								/>
							}
						/>
						<SettingsRow
							rowId="matrix-controllerLabel"
							label={t("settings.matrix.controllerLabel")}
							control={
								<input
									tabIndex={0}
									value={controllerUserId}
									onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
										setControllerUserId(event.target.value)
									}
									aria-label={t("settings.matrix.controllerLabel")}
									placeholder={t("settings.matrix.controllerPlaceholder")}
									className={SETTINGS_INPUT + " w-full"}
								/>
							}
						/>
						<SettingsRow
							rowId="matrix-loginMode"
							label={t("settings.matrix.loginMode")}
							control={
								<div className="flex gap-8">
									<Button
										tabIndex={0}
										variant={mode === "password" ? "primary" : "outline"}
										size="s"
										onClick={() => {
											setMode("password");
											setSecret("");
										}}
									>
										{t("settings.matrix.passwordMode")}
									</Button>
									<Button
										tabIndex={0}
										variant={mode === "access-token" ? "primary" : "outline"}
										size="s"
										onClick={() => {
											setMode("access-token");
											setSecret("");
										}}
									>
										{t("settings.matrix.tokenMode")}
									</Button>
								</div>
							}
						/>
						<SettingsRow
							rowId="matrix-secret"
							label={secretName}
							control={
								<input
									tabIndex={0}
									aria-label={secretName}
									type="password"
									autoComplete={mode === "password" ? "new-password" : "off"}
									value={secret}
									onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
										setSecret(event.target.value)
									}
									className={SETTINGS_INPUT + " w-full"}
								/>
							}
						/>
						<SettingsRow
							rowId="matrix-plaintextLabel"
							label={t("settings.matrix.plaintextLabel")}
							description={
								<p className="text-feedback-warning">{t("settings.matrix.plaintextWarning")}</p>
							}
							control={
								<label className="flex items-start gap-8">
									<input
										tabIndex={0}
										type="checkbox"
										checked={acknowledged}
										onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
											setAcknowledged(event.target.checked)
										}
									/>
									<span>{t("settings.matrix.plaintextConfirm")}</span>
								</label>
							}
						/>
						<SettingsRow
							rowId="matrix-loginAction"
							label={t("settings.matrix.loginAction")}
							control={
								<Button
									tabIndex={0}
									variant="outline"
									size="m"
									disabled={!valid || busy}
									onClick={submit}
								>
									{busy ? t("settings.matrix.working") : t("settings.matrix.loginAction")}
								</Button>
							}
						/>
					</>
				)}
				{failed ? (
					<SettingsRow
						rowId="matrix-failureLabel"
						label={t("settings.matrix.failureLabel")}
						description={<T i18nKey="settings.matrix.failure" />}
					/>
				) : null}
			</SettingsGroup>
			<ConfirmDialog
				open={confirmDisconnect}
				onOpenChange={setConfirmDisconnect}
				title={t("settings.matrix.disconnectConfirm")}
				confirmLabel={t("settings.matrix.disconnect")}
				destructive
				onConfirm={() => void request("matrix.disconnect", {})}
			/>
		</SettingsPage>
	);
}
