import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

import { compactToolResult, WHOLE_RESULT_TECHNIQUES } from "./output-compactor.ts";
import { clearOutputMetrics, getOutputMetricsSummary, trackOutputSavings } from "./output-metrics.ts";
import { cloneDefaultConfig, mock, runTest } from "./test-helpers.test.ts";
import {
	isOnlyFamilyCommand,
	matchesCommandPatterns,
	normalizeCommandForDetection,
} from "./techniques/command-detection.ts";
import { aggregateLinterOutput, LINTER_COMMAND_PATTERNS } from "./techniques/linter.ts";
import { compactPath } from "./techniques/path-utils.ts";
import { filterAggressive } from "./techniques/source.ts";
import { aggregateTestOutput, isTestCommand } from "./techniques/test-output.ts";
import { applyWindowsBashCompatibilityFixes } from "./windows-command-helpers.ts";
import { applyRewrittenCommandShellSafetyFixups } from "./rewrite-pipeline-safety.ts";
import { applyRtkCommandEnvironment } from "./rtk-command-environment.ts";
import { sanitizeStreamingBashExecutionResult } from "./tool-execution-sanitizer.ts";

mock.module("@earendil-works/pi-coding-agent", {
	namedExports: {
		getAgentDir: () => "/tmp/.pi/agent",
	},
});

const {
	ensureConfigExists,
	getRtkIntegrationConfigPath,
	loadRtkIntegrationConfig,
	normalizeRtkIntegrationConfig,
	saveRtkIntegrationConfig,
} = await import("./config-store.ts");

function makeTempConfigPath(): string {
	return `${getRtkIntegrationConfigPath()}.test-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
}

function cleanupFile(path: string): void {
	for (const candidate of [path, `${path}.tmp`]) {
		try {
			if (existsSync(candidate)) {
				unlinkSync(candidate);
			}
		} catch {
			// Ignore cleanup failures in tests.
		}
	}
}

runTest("config-store normalizes invalid values and clamps numeric ranges", () => {
	const normalized = normalizeRtkIntegrationConfig({
		enabled: "yes",
		mode: "invalid",
		rewriteGitGithub: false,
		outputCompaction: {
			stripAnsi: false,
			sourceCodeFilteringEnabled: "sometimes",
			sourceCodeFiltering: "extreme",
			truncate: {
				enabled: true,
				maxChars: 12,
			},
			smartTruncate: {
				enabled: true,
				maxLines: 999_999,
			},
			trackSavings: false,
		},
	});

	assert.equal(normalized.enabled, true);
	assert.equal(normalized.mode, "rewrite");
	assert.equal(Object.hasOwn(normalized, "rewriteGitGithub"), false);
	assert.equal(normalized.outputCompaction.stripAnsi, false);
	assert.equal(normalized.outputCompaction.readCompaction.enabled, true);
	assert.equal(normalized.outputCompaction.sourceCodeFilteringEnabled, true);
	assert.equal(normalized.outputCompaction.sourceCodeFiltering, "minimal");
	assert.equal(normalized.outputCompaction.truncate.maxChars, 1_000);
	assert.equal(normalized.outputCompaction.smartTruncate.maxLines, 4_000);
	assert.equal(normalized.outputCompaction.trackSavings, false);
});

runTest("config-store uses safer read defaults when readCompaction is explicit", () => {
	const normalized = normalizeRtkIntegrationConfig({
		outputCompaction: {
			readCompaction: { enabled: false },
		},
	});

	assert.equal(normalized.outputCompaction.readCompaction.enabled, false);
	assert.equal(normalized.outputCompaction.sourceCodeFilteringEnabled, false);
	assert.equal(normalized.outputCompaction.sourceCodeFiltering, "none");
	assert.equal(normalized.outputCompaction.smartTruncate.enabled, false);
});

runTest("config-store can ensure, save, and reload isolated config files", () => {
	const tempPath = makeTempConfigPath();
	cleanupFile(tempPath);

	try {
		const ensured = ensureConfigExists(tempPath);
		assert.equal(ensured.error, undefined);
		assert.equal(existsSync(tempPath), true);

		const defaultLoad = loadRtkIntegrationConfig(tempPath);
		assert.equal(defaultLoad.warning, undefined);
		assert.equal(defaultLoad.config.mode, "rewrite");
		assert.equal(defaultLoad.config.outputCompaction.readCompaction.enabled, false);

		const saved = saveRtkIntegrationConfig(
			{
				...defaultLoad.config,
				mode: "suggest",
				outputCompaction: {
					...defaultLoad.config.outputCompaction,
					truncate: {
						...defaultLoad.config.outputCompaction.truncate,
						maxChars: 250_000,
					},
				},
			},
			tempPath,
		);
		assert.equal(saved.success, true);

		const reloaded = loadRtkIntegrationConfig(tempPath);
		assert.equal(reloaded.config.mode, "suggest");
		assert.equal(reloaded.config.outputCompaction.truncate.maxChars, 200_000);
		assert.ok(readFileSync(tempPath, "utf-8").endsWith("\n"));
	} finally {
		cleanupFile(tempPath);
	}
});

runTest("config-store falls back to defaults when JSON is invalid", () => {
	const tempPath = makeTempConfigPath();
	cleanupFile(tempPath);

	try {
		writeFileSync(tempPath, "{not valid json", "utf-8");
		const loaded = loadRtkIntegrationConfig(tempPath);
		assert.equal(loaded.config.mode, "rewrite");
		assert.ok((loaded.warning ?? "").includes(tempPath));
		assert.ok((loaded.warning ?? "").includes("Failed to parse"));
	} finally {
		cleanupFile(tempPath);
	}
});

runTest("config-store malformed-file defaults are isolated from caller mutation", () => {
	const tempPath = makeTempConfigPath();
	cleanupFile(tempPath);

	try {
		writeFileSync(tempPath, "{not valid json", "utf-8");
		const firstLoad = loadRtkIntegrationConfig(tempPath);
		firstLoad.config.outputCompaction.truncate.maxChars = 42_424;
		firstLoad.config.outputCompaction.readCompaction.enabled = true;

		const secondLoad = loadRtkIntegrationConfig(tempPath);

		assert.equal(secondLoad.config.outputCompaction.truncate.maxChars, 12_000);
		assert.equal(secondLoad.config.outputCompaction.readCompaction.enabled, false);
	} finally {
		cleanupFile(tempPath);
	}
});

runTest("output metrics summarize tracked savings and clear state", () => {
	clearOutputMetrics();
	assert.equal(getOutputMetricsSummary(), "RTK output compaction metrics: no data yet.");

	const first = trackOutputSavings("1234567890", "12345", "bash", ["ansi", "truncate"]);
	assert.equal(first.tool, "bash");
	assert.equal(first.techniques, "ansi,truncate");
	assert.equal(first.savingsPercent, 50);

	trackOutputSavings("123456", "1234", "read", []);
	const summary = getOutputMetricsSummary();
	assert.ok(summary.includes("calls=2, saved=7 chars (43.8%)"));
	assert.ok(summary.includes("- bash: 1 calls, saved 5 chars (50.0%)"));
	assert.ok(summary.includes("- read: 1 calls, saved 2 chars (33.3%)"));

	clearOutputMetrics();
	assert.equal(getOutputMetricsSummary(), "RTK output compaction metrics: no data yet.");
});

runTest("aggressive source filtering ignores string and inline comment braces while tracking implementation blocks", () => {
	const withLiteralBrace = [
		"function first() {",
		'  const value = "{";',
		"  return value;",
		"}",
		"function second() {",
		"  return true;",
		"}",
	].join("\n");
	const withoutLiteralBrace = [
		"function first() {",
		'  const value = "plain";',
		"  return value;",
		"}",
		"function second() {",
		"  return true;",
		"}",
	].join("\n");
	const withInlineCommentBrace = [
		"function first() {",
		"  const value = 1; // {",
		"  return value;",
		"}",
		"function second() {",
		"  return true;",
		"}",
	].join("\n");
	const withoutInlineCommentBrace = [
		"function first() {",
		"  const value = 1; // no brace",
		"  return value;",
		"}",
		"function second() {",
		"  return true;",
		"}",
	].join("\n");

	assert.equal(filterAggressive(withLiteralBrace, "typescript"), filterAggressive(withoutLiteralBrace, "typescript"));
	assert.equal(filterAggressive(withInlineCommentBrace, "typescript"), filterAggressive(withoutInlineCommentBrace, "typescript"));
});

runTest("test output fallback counts unicode pass and fail symbols", () => {
	const result = aggregateTestOutput("✓ creates user\n✔ updates user\n✕ deletes user\n✗ archives user\n", "bun test");

	assert.ok(result?.includes("PASS: 2 passed"));
	assert.ok(result?.includes("FAIL: 2 failed"));
});

runTest("command detection ignores env prefixes, blank lines, and chained suffixes", () => {
	assert.equal(normalizeCommandForDetection("NODE_ENV=test FOO=bar npm test && echo done"), "npm test");
	assert.equal(normalizeCommandForDetection("\n\n PYTHONPATH=src git status\n echo later"), "git status");
	assert.equal(normalizeCommandForDetection("   "), null);
	assert.equal(matchesCommandPatterns("CI=1 bun test | head -5", [/^bun test/]), true);
	assert.equal(matchesCommandPatterns("echo hello", [/^bun test/]), false);
});

runTest("command detection looks past a leading cd or set -e segment", () => {
	// The first segment of these is `cd`/`set`, so matching only segment one
	// silently skipped compaction for the real command further along.
	assert.equal(matchesCommandPatterns("cd /repo && npm test", [/^npm\s+test\b/]), true);
	assert.equal(matchesCommandPatterns("cd /repo && npm test | tail -20", [/^npm\s+test\b/]), true);
	assert.equal(matchesCommandPatterns("set -e\ncd /repo\nnpm test", [/^npm\s+test\b/]), true);
	assert.equal(matchesCommandPatterns("cd /tmp && printf 'x' && cargo test", [/^cargo\s+test\b/]), true);

	// Broadening the scan must not start matching unrelated commands.
	assert.equal(matchesCommandPatterns("cd /repo && git status", [/^npm\s+test\b/]), false);
	assert.equal(matchesCommandPatterns("echo npm test", [/^npm\s+test\b/]), false);
	assert.equal(matchesCommandPatterns("cd /repo", [/^npm\s+test\b/]), false);
	assert.equal(matchesCommandPatterns(undefined, [/^npm\s+test\b/]), false);
});

runTest("node --test is recognized as a test command", () => {
	assert.equal(isTestCommand("node --test"), true);
	assert.equal(isTestCommand("node --test dcli/tests/*.mjs"), true);
	assert.equal(isTestCommand("cd /repo && node --test"), true);
	assert.equal(isTestCommand("node --test-only foo.mjs"), true);
	assert.equal(isTestCommand("node ./script.js"), false);
});

runTest("node --test output parses its own summary, not the fail word", () => {
	// Node prints `\u2139 fail 0` on a fully green run. Counting the bare word
	// `fail` reported a passing run as a failure.
	const passing = [
		"\u2714 alpha (0.8ms)",
		"\u2714 beta (0.1ms)",
		"\u2139 tests 2",
		"\u2139 suites 0",
		"\u2139 pass 2",
		"\u2139 fail 0",
		"\u2139 skipped 0",
	].join("\n");

	const passingResult = aggregateTestOutput(passing, "node --test");
	assert.ok(passingResult?.includes("PASS: 2 passed"), passingResult ?? "null");
	assert.ok(!passingResult?.includes("FAIL:"), passingResult ?? "null");

	const failing = [
		"\u2714 passes one (1.0ms)",
		"\u2716 fails one (1.0ms)",
		"\u2139 tests 2",
		"\u2139 pass 1",
		"\u2139 fail 1",
		"\u2139 skipped 0",
		"",
		"\u2716 failing tests:",
		"",
		"test at a.test.mjs:5:1",
		"\u2716 fails one (1.0ms)",
		"  AssertionError [ERR_ASSERTION]: 1 !== 2",
	].join("\n");

	const failingResult = aggregateTestOutput(failing, "node --test");
	assert.ok(failingResult?.includes("PASS: 1 passed"), failingResult ?? "null");
	assert.ok(failingResult?.includes("FAIL: 1 failed"), failingResult ?? "null");
	// The failing test name must survive, otherwise the agent cannot act on it.
	assert.ok(failingResult?.includes("fails one"), failingResult ?? "null");
});

runTest("RTK command environment preserves explicit leading RTK_DB_PATH overrides", () => {
	const command = 'RTK_DB_PATH="/custom/history.db" rtk git diff';
	assert.equal(applyRtkCommandEnvironment(command), command);

	const singleQuotedCommand = "RTK_DB_PATH='/custom/it'\\''s/history.db' rtk git diff";
	assert.equal(applyRtkCommandEnvironment(singleQuotedCommand), singleQuotedCommand);

	const exportedCommand = 'export RTK_DB_PATH="/custom/history.db"; rtk git diff';
	assert.equal(applyRtkCommandEnvironment(exportedCommand), exportedCommand);
});

runTest("RTK command environment respects inherited RTK_DB_PATH values", () => {
	const previousRtkDbPath = process.env.RTK_DB_PATH;
	const command = "rtk git status";

	try {
		process.env.RTK_DB_PATH = "/persistent/shared/history.db";

		assert.equal(applyRtkCommandEnvironment(command), command);
	} finally {
		if (previousRtkDbPath === undefined) {
			delete process.env.RTK_DB_PATH;
		} else {
			process.env.RTK_DB_PATH = previousRtkDbPath;
		}
	}
});

runTest("RTK command environment ignores blank inherited RTK_DB_PATH values", () => {
	const previousRtkDbPath = process.env.RTK_DB_PATH;

	try {
		process.env.RTK_DB_PATH = "   ";

		assert.match(applyRtkCommandEnvironment("rtk git status"), /^export RTK_DB_PATH=/);
	} finally {
		if (previousRtkDbPath === undefined) {
			delete process.env.RTK_DB_PATH;
		} else {
			process.env.RTK_DB_PATH = previousRtkDbPath;
		}
	}
});

runTest("RTK command environment single-quotes hostile temp paths", () => {
	const previousTmpDir = process.env.TMPDIR;
	const previousTmp = process.env.TMP;
	const previousTemp = process.env.TEMP;
	const hostilePath = process.platform === "win32" ? "C:\\Temp\\$(touch owned)`bad`'dir" : "/tmp/$(touch owned)`bad`'dir";

	try {
		process.env.TMPDIR = hostilePath;
		process.env.TMP = hostilePath;
		process.env.TEMP = hostilePath;

		const rewritten = applyRtkCommandEnvironment("rtk git status");
		assert.ok(rewritten.startsWith("export RTK_DB_PATH='"));
		assert.ok(rewritten.includes("$(touch owned)`bad`'\\''dir"));
		assert.ok(rewritten.endsWith("; rtk git status"));
		assert.equal(/^export RTK_DB_PATH=\"/.test(rewritten), false);
	} finally {
		process.env.TMPDIR = previousTmpDir;
		process.env.TMP = previousTmp;
		process.env.TEMP = previousTemp;
	}
});

runTest("path compaction preserves the tail and handles Windows separators", () => {
	const unixPath = "/Users/example/projects/pi-rtk-optimizer/src/techniques/path-utils.ts";
	const compactUnixPath = compactPath(unixPath, 28);
	assert.ok(compactUnixPath.length <= 28);
	assert.ok(compactUnixPath.endsWith("path-utils.ts"));
	assert.ok(compactUnixPath.includes("/"));

	const windowsPath = "C:\\Users\\Administrator\\Documents\\pi-rtk-optimizer\\src\\windows-command-helpers.ts";
	const compactWindowsPath = compactPath(windowsPath, 30);
	assert.ok(compactWindowsPath.length <= 30);
	assert.equal(compactWindowsPath.includes("\\"), true);
	assert.ok(compactWindowsPath.endsWith("windows-command-helpers.ts"));

	assert.equal(compactPath("src/file.ts", 40), "src/file.ts");
});

runTest("windows bash compatibility rewrites only when the runtime is Windows", () => {
	const command = "cd /d C:\\Users\\Administrator\\project && python script.py";
	const fixed = applyWindowsBashCompatibilityFixes(command, "win32");
	assert.deepEqual(fixed.applied, ["cd-/d", "python-utf8"]);
	assert.equal(
		fixed.command,
		'PYTHONIOENCODING=utf-8 cd "C:/Users/Administrator/project" && python script.py',
	);

	const unchanged = applyWindowsBashCompatibilityFixes(command, "linux");
	assert.deepEqual(unchanged.applied, []);
	assert.equal(unchanged.command, command);

	const alreadyUtf8 = applyWindowsBashCompatibilityFixes("PYTHONIOENCODING=utf-8 python script.py", "win32");
	assert.deepEqual(alreadyUtf8.applied, []);
	assert.equal(alreadyUtf8.command, "PYTHONIOENCODING=utf-8 python script.py");
});

runTest("windows bash compatibility rewrites compound cd slash-d operators", () => {
	assert.equal(
		applyWindowsBashCompatibilityFixes("cd /d C:\\work || echo failed", "win32").command,
		'cd "C:/work" || echo failed',
	);
	assert.equal(
		applyWindowsBashCompatibilityFixes("cd /d C:\\work ; echo done", "win32").command,
		'cd "C:/work" ; echo done',
	);
	assert.equal(
		applyWindowsBashCompatibilityFixes("cd /d C:\\work | cat", "win32").command,
		'cd "C:/work" | cat',
	);
	assert.equal(
		applyWindowsBashCompatibilityFixes('cd /d "C:\\work space" || echo failed', "win32").command,
		'cd "C:/work space" || echo failed',
	);
});

runTest("rewrite pipeline safety buffers rewritten Windows producer commands", () => {
	const rewritten = applyRewrittenCommandShellSafetyFixups("rtk git diff | grep TODO", "win32");
	assert.ok(rewritten.includes('mktemp'));
	assert.ok(rewritten.includes('trap'));
	assert.ok(rewritten.includes('rtk git diff > "$__pi_rtk_pipe_tmp"'));
	assert.ok(rewritten.includes('(grep TODO) < "$__pi_rtk_pipe_tmp"'));

	assert.equal(
		applyRewrittenCommandShellSafetyFixups("rtk git diff | grep TODO", "linux"),
		"rtk git diff | grep TODO",
	);
	assert.equal(applyRewrittenCommandShellSafetyFixups("git diff | grep TODO", "win32"), "git diff | grep TODO");
});

runTest("rewrite pipeline safety buffers leading pipelines before compound suffixes", () => {
	const andCommand = applyRewrittenCommandShellSafetyFixups("rtk git diff | grep TODO && echo done", "win32");
	assert.ok(andCommand.includes('(grep TODO) < "$__pi_rtk_pipe_tmp"'));
	assert.ok(andCommand.endsWith("&& echo done"));

	const orCommand = applyRewrittenCommandShellSafetyFixups("rtk git diff | grep TODO || echo none", "win32");
	assert.ok(orCommand.includes('(grep TODO) < "$__pi_rtk_pipe_tmp"'));
	assert.ok(orCommand.endsWith("|| echo none"));

	const semicolonCommand = applyRewrittenCommandShellSafetyFixups("rtk git diff | grep TODO; echo done", "win32");
	assert.ok(semicolonCommand.includes('(grep TODO) < "$__pi_rtk_pipe_tmp"'));
	assert.ok(semicolonCommand.endsWith("; echo done"));
});

runTest("rewrite pipeline safety keeps exported RTK_DB_PATH on rewritten producer commands", () => {
	const envScopedCommand = applyRtkCommandEnvironment("rtk git diff agent/extensions/pi-multi-auth/account-manager.ts | head -200");
	const rewritten = applyRewrittenCommandShellSafetyFixups(envScopedCommand, "win32");

	assert.ok(rewritten.startsWith("export RTK_DB_PATH="));
	assert.equal(rewritten.startsWith("RTK_DB_PATH="), false);
	assert.ok(rewritten.includes("; {"));
	assert.ok(
		rewritten.includes('rtk git diff agent/extensions/pi-multi-auth/account-manager.ts > "$__pi_rtk_pipe_tmp"'),
	);
	assert.ok(rewritten.includes('(head -200) < "$__pi_rtk_pipe_tmp"'));

	assert.equal(applyRewrittenCommandShellSafetyFixups(envScopedCommand, "linux"), envScopedCommand);
});

runTest("rewrite pipeline safety buffers explicit RTK_DB_PATH export preludes", () => {
	const command = 'export RTK_DB_PATH="/custom/history.db"; rtk git diff | head -200';
	const rewritten = applyRewrittenCommandShellSafetyFixups(command, "win32");

	assert.ok(rewritten.startsWith('export RTK_DB_PATH="/custom/history.db"; {'));
	assert.ok(rewritten.includes('rtk git diff > "$__pi_rtk_pipe_tmp"'));
	assert.ok(rewritten.includes('(head -200) < "$__pi_rtk_pipe_tmp"'));

	assert.equal(applyRewrittenCommandShellSafetyFixups(command, "linux"), command);
});

runTest("RTK command environment uses export prelude for shell compound commands", () => {
	const rewritten = applyRtkCommandEnvironment('for d in a b; do echo "$d"; done');
	assert.ok(/^export RTK_DB_PATH=/.test(rewritten));
	assert.ok(/; for d in a b; do echo "\$d"; done$/.test(rewritten));
});

runTest("streaming sanitizer strips ANSI codes and preserves non-text blocks", () => {
	const ansiResult = {
		content: [
			{ type: "text", text: "\x1B[32mworking tree clean\x1B[0m\n" },
			{ type: "image", url: "ignored" },
		],
	};
	const ansiSanitization = sanitizeStreamingBashExecutionResult(ansiResult, "rtk git status");
	assert.equal(ansiSanitization.changed, true);
	assert.equal(
		((ansiSanitization.result as typeof ansiResult).content[0] as { text: string }).text,
		"working tree clean\n",
	);
	assert.equal((ansiResult.content[0] as { text: string }).text, "\x1B[32mworking tree clean\x1B[0m\n");
	assert.deepEqual((ansiSanitization.result as typeof ansiResult).content[1], { type: "image", url: "ignored" });

	const plainResult = {
		content: [
			{
				type: "text",
				text: "[rtk] warning: builtin filters: parse failure\n\nworking tree clean\n",
			},
		],
	};
	const plainSanitization = sanitizeStreamingBashExecutionResult(plainResult, "rtk git status");
	assert.equal(plainSanitization.changed, false);
	assert.equal(plainSanitization.result, plainResult);
	assert.equal(
		(plainResult.content[0] as { text: string }).text,
		"[rtk] warning: builtin filters: parse failure\n\nworking tree clean\n",
	);
});

runTest("linter aggregation is skipped when another segment writes output", () => {
	// The guard lives in the compactor, not in the technique, so this asserts
	// the property at the level that applies it.
	const outcome = compactToolResult(
		{
			toolName: "bash",
			input: {
				command: 'cd repo\necho "--- git ---"\nruff check src/\ngit status --short',
			},
			content: [{ type: "text", text: "--- git ---\n M src/a.ts\n" }],
		},
		cloneDefaultConfig(),
	);
	assert.equal(outcome.changed, false);
});

runTest("linter aggregation still applies behind cd and names the linter", () => {
	assert.equal(isOnlyFamilyCommand("cd repo && ruff check src/", LINTER_COMMAND_PATTERNS), true);
	assert.equal(
		aggregateLinterOutput("", "cd repo && ruff check src/"),
		"[OK] Ruff: No issues found",
	);
});

runTest("a quoted shell separator does not make a command linter-only", () => {
	assert.equal(
		isOnlyFamilyCommand("grep -n -i 'linter\\|ruff' src/a.ts", LINTER_COMMAND_PATTERNS),
		false,
	);
	// The escape splits the quote, so the technique still sees a `ruff` segment.
	// The compactor is what refuses it, because grep is another producer.
	const outcome = compactToolResult(
		{
			toolName: "bash",
			input: { command: "grep -n -i 'linter\\|ruff' src/a.ts" },
			content: [{ type: "text", text: "src/a.ts:1:ruff" }],
		},
		cloneDefaultConfig(),
	);
	assert.equal(outcome.changed, false);
});

runTest("linter aggregation refuses a command with no linter at all", () => {
	assert.equal(isOnlyFamilyCommand("cd repo && git status", LINTER_COMMAND_PATTERNS), false);
	assert.equal(aggregateLinterOutput(" M src/a.ts", "cd repo && git status"), null);
});

runTest("isOnlyFamilyCommand admits non-producing segments only", () => {
	const build = [/^npm\s+run\s+build\b/];
	assert.equal(isOnlyFamilyCommand("cd repo && npm run build", build), true);
	assert.equal(isOnlyFamilyCommand("npm run build | head -5", build), true);
	assert.equal(isOnlyFamilyCommand("echo x && npm run build", build), false);
	assert.equal(isOnlyFamilyCommand("cd repo", build), false);
});

runTest("every whole-result technique is refused when another segment writes output", () => {
	// Driven by the compactor's own table: a technique added there without a
	// sample below fails the key comparison rather than going untested.
	const samples = new Map<string, [string, string]>([
		["build", ["npm run build", "Compiling x"]],
		["test", ["npm test", "10 passing"]],
		["git", ["git status --short", " M a.ts"]],
		["linter", ["ruff check src", "src/a.ts:1:1 F401 unused"]],
	]);
	assert.deepEqual(
		WHOLE_RESULT_TECHNIQUES.map((entry) => entry.technique).sort(),
		[...samples.keys()].sort(),
	);

	for (const { technique, patterns } of WHOLE_RESULT_TECHNIQUES) {
		const sample = samples.get(technique);
		assert.ok(sample, "no sample command for " + technique);
		if (!sample) continue;
		const [trigger, output] = sample;

		// Sole producer: this command is the technique's to replace.
		assert.equal(isOnlyFamilyCommand("cd repo && " + trigger, patterns), true, technique);
		// Another producer: refusing is the whole point.
		assert.equal(
			isOnlyFamilyCommand("echo MARK\n" + trigger + "\necho MARK", patterns),
			false,
			technique,
		);

		// And through the entry point production calls, so the config flags and
		// the technique chain are covered too, not just the guard.
		const outcome = compactToolResult(
			{
				toolName: "bash",
				input: { command: "echo MARK\n" + trigger + "\necho MARK" },
				content: [{ type: "text", text: "MARK\n" + output + "\nMARK" }],
			},
			cloneDefaultConfig(),
		);
		assert.equal(outcome.changed, false, "replaced a compound command via " + technique);
	}
});

runTest("a sole-producer command is still compacted", () => {
	const outcome = compactToolResult(
		{
			toolName: "bash",
			input: { command: "cd repo && npm run build" },
			content: [{ type: "text", text: "Compiling x" }],
		},
		cloneDefaultConfig(),
	);
	assert.equal(outcome.changed, true);
});

console.log("All additional coverage tests passed.");
