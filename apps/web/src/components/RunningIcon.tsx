import { useT } from "@thinkrail/locales/react";
import { cn } from "@thinkrail/ui/utils";
import { useId } from "react";
import { BRAND_MARK_SEGMENTS } from "../constants/branding";

const FRAME_HALVES = [
	"M20 195 V110 A90 90 0 0 1 110 20 H650 A90 90 0 0 1 740 110 V552",
	"M20 225 V650 A90 90 0 0 0 110 740 H650 A90 90 0 0 0 740 650 V548",
] as const;

const STROKES: ReadonlyArray<{
	d: string;
	join: "miter" | "round";
	width: number;
	clip: keyof typeof BRAND_MARK_SEGMENTS;
	className: string;
}> = [
	{
		d: "M197 45 L160 15 H90 C45 15 14 45 14 90 V278 C14 320 45 350 90 350 H150 C175 350 182 330 182 305",
		join: "round",
		width: 40,
		clip: "o",
		className: "motion-safe:animate-loader-t-bar",
	},
	{
		d: "M182 310 V100 C182 80 170 65 145 65 H100 C80 65 65 80 65 100 V270 C65 290 80 300 100 300 H150 L182 290",
		join: "round",
		width: 40,
		clip: "o",
		className: "motion-safe:animate-loader-t-stem",
	},
	{
		d: "M233 366 V16 L310 125 L386 16 V366",
		join: "miter",
		width: 42,
		clip: "m",
		className: "motion-safe:animate-loader-r-tail",
	},
	{
		d: "M233 90 L310 195 L386 90",
		join: "miter",
		width: 40,
		clip: "m",
		className: "motion-safe:animate-loader-r-bowl",
	},
	{
		d: "M422 15 H623 M422 65 H623 M491 65 V366",
		join: "miter",
		width: 40,
		clip: "tStem",
		className: "motion-safe:animate-loader-r-stem",
	},
	{
		d: "M542 366 V102",
		join: "miter",
		width: 40,
		clip: "tRight",
		className: "motion-safe:animate-loader-r-leg",
	},
	{
		d: "M422 15 H623",
		join: "miter",
		width: 40,
		clip: "tBar",
		className: "motion-safe:animate-loader-r-stem",
	},
];

export function RunningIcon({ className }: { className?: string | undefined }) {
	const t = useT();
	const id = useId();
	const clipId = (name: string) => `${id}-${name}`;

	return (
		<span
			data-testid="running-icon"
			data-running="true"
			role="img"
			aria-label={t("components.runningIcon.label")}
			className={cn("inline-flex shrink-0 items-center justify-center", className)}
		>
			<svg aria-hidden="true" viewBox="0 0 760 760" className="size-full">
				<defs>
					{Object.entries(BRAND_MARK_SEGMENTS).map(([name, d]) => (
						<clipPath key={name} id={clipId(name)}>
							<path d={d} />
						</clipPath>
					))}
				</defs>
				{FRAME_HALVES.map((d) => (
					<path
						key={d}
						data-testid="running-icon-frame"
						d={d}
						fill="none"
						stroke="currentColor"
						strokeWidth="40"
						strokeLinejoin="round"
						strokeDasharray="1000 1000"
						pathLength="1000"
						className="motion-safe:animate-loader-frame"
					/>
				))}
				<g transform="translate(68.5 197)">
					{STROKES.map((stroke) => (
						<path
							key={stroke.d}
							d={stroke.d}
							fill="none"
							stroke="currentColor"
							strokeWidth={stroke.width}
							strokeLinejoin={stroke.join}
							strokeDasharray="1000 1000"
							pathLength="1000"
							clipPath={`url(#${clipId(stroke.clip)})`}
							className={stroke.className}
						/>
					))}
				</g>
			</svg>
		</span>
	);
}
