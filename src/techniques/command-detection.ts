const ENV_PREFIX_PATTERN = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)*/;
const CHAIN_OPERATORS = ["&&", "||", ";", "|"] as const;

function sliceFirstSegment(command: string): string {
	let cutIndex = -1;
	for (const operator of CHAIN_OPERATORS) {
		const index = command.indexOf(operator);
		if (index === -1) {
			continue;
		}
		if (cutIndex === -1 || index < cutIndex) {
			cutIndex = index;
		}
	}

	if (cutIndex === -1) {
		return command;
	}
	return command.slice(0, cutIndex);
}

export function normalizeCommandForDetection(command: string | undefined | null): string | null {
	if (typeof command !== "string") {
		return null;
	}

	const firstNonEmptyLine = command
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!firstNonEmptyLine) {
		return null;
	}

	const withoutEnvPrefix = firstNonEmptyLine.replace(ENV_PREFIX_PATTERN, "").trim();
	if (!withoutEnvPrefix) {
		return null;
	}

	const firstSegment = sliceFirstSegment(withoutEnvPrefix).trim().toLowerCase();
	return firstSegment || null;
}

/**
 * Every segment a shell string can execute: each non-empty line, split on
 * `&&` / `||` / `;` / `|`, with env prefixes stripped.
 *
 * Detection needs all of them rather than just the first. `cd repo && npm test`
 * and scripts opening with `set -e` both start with a segment no command
 * pattern matches, so first-segment-only detection skipped them entirely.
 */
export function commandSegmentsForDetection(command: string | undefined | null): string[] {
	if (typeof command !== "string") {
		return [];
	}

	const segments: string[] = [];
	for (const rawLine of command.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}
		const withoutEnvPrefix = line.replace(ENV_PREFIX_PATTERN, "").trim();
		if (!withoutEnvPrefix) {
			continue;
		}
		for (const part of withoutEnvPrefix.split(/&&|\|\||;|\|/)) {
			const segment = part.trim().toLowerCase();
			if (segment) {
				segments.push(segment);
			}
		}
	}
	return segments;
}

export function matchesCommandPatterns(
	command: string | undefined | null,
	patterns: readonly RegExp[],
): boolean {
	const segments = commandSegmentsForDetection(command);
	if (segments.length === 0) {
		return false;
	}
	return segments.some((segment) => patterns.some((pattern) => pattern.test(segment)));
}

/**
 * Commands that do not contribute output of their own.
 *
 * Two kinds live here: silent setup (`cd`, `export`, `set -e`) and pass-through
 * filters (`head`, `tail`, `cat`), which only forward a slice of the output
 * produced by the command they read from.
 */
const NON_PRODUCING_COMMAND_PATTERN =
	/^(?:cd|pushd|popd|set|export|unset|source|\.|true|:|ulimit|umask|head|tail|cat)\b/;

/**
 * Whether this command's only output producer belongs to `patterns`.
 *
 * Whole-result techniques replace the ENTIRE tool result, which is sound only
 * when nothing else in the command wrote anything. Detection deliberately stays
 * any-segment (`matchesCommandPatterns`) so a build behind `cd` is found; that
 * same property makes it unsafe as a gate, because `echo x && npm run build`
 * then discards the echo along with the build.
 *
 * So a whole-result technique needs this stronger property: every segment is
 * either a member of its family or produces nothing, and at least one is a
 * member. `commandSegmentsForDetection` splits on newlines and `&&`/`||`/`;`/`|`,
 * so a quoted separator is not a segment and a filter after `|` is one.
 */
export function isOnlyFamilyCommand(
	command: string | undefined | null,
	patterns: readonly RegExp[],
): boolean {
	let matched = false;
	for (const segment of commandSegmentsForDetection(command)) {
		if (patterns.some((pattern) => pattern.test(segment))) {
			matched = true;
			continue;
		}
		if (NON_PRODUCING_COMMAND_PATTERN.test(segment)) {
			continue;
		}
		return false;
	}
	return matched;
}
