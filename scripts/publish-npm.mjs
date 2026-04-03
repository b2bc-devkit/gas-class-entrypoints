/**
 * Interactive publish script for @b2bc-devkit/gas-class-entrypoints.
 *
 * Pipeline:
 *   1. Interactive menu: choose access (public / restricted) and dist-tag.
 *   2. Temporarily patch package.json with selected options.
 *   3. Publish to the npm registry.
 *   4. Restore original package.json regardless of success or failure.
 *
 * Prerequisites:
 *   - Authenticate with `npm login` before running this script.
 *   - Bump the version in package.json before publishing.
 *
 * Usage: `node scripts/publish-npm.mjs`
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { createInterface } from "readline";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgPath = resolve(__dirname, "..", "package.json");

/** Execute a shell command with inherited stdio for real-time output.
 * @param {string} cmd  The shell command to run.
 */
const run = (cmd) => execSync(cmd, { stdio: "inherit" });

// ─── ANSI color codes ────────────────────────────────────────────────
// Used only for terminal formatting; have no effect on the published package.

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/**
 * Show an interactive single-select menu in the terminal.
 *
 * Renders a list of labeled options with an optional description for each
 * entry.  The user navigates with the ↑/↓ arrow keys and confirms the
 * selection with Enter.  Pressing Ctrl-C exits the process.
 *
 * The function takes full control of raw stdin during interaction and
 * restores it (plus closes the readline interface) before resolving.
 *
 * @param {string}   title         Prompt text displayed above the options.
 * @param {Array<{label: string, value: *, description?: string}>} options
 *   Array of option objects.  `label` is displayed in the menu; `value`
 *   is returned indirectly via the resolved index.
 * @param {number}  [defaultIndex=0]  Zero-based index of the initially
 *   highlighted option.
 * @returns {Promise<number>}  Resolves with the zero-based index of the
 *   option the user confirmed.
 */
function selectMenu(title, options, defaultIndex = 0) {
  return new Promise((resolvePromise) => {
    let selected = defaultIndex;

    const render = () => {
      if (render.drawn) {
        process.stdout.write(`\x1b[${options.length + 1}A`);
      }
      process.stdout.write(`${BOLD}${CYAN}? ${title}${RESET}\n`);
      for (let i = 0; i < options.length; i++) {
        const marker = i === selected ? `${GREEN}>` : " ";
        const label = i === selected ? `${GREEN}${options[i].label}${RESET}` : ` ${options[i].label}`;
        const desc = options[i].description ? ` ${DIM}${options[i].description}${RESET}` : "";
        process.stdout.write(`  ${marker} ${label}${desc}\n`);
      }
      render.drawn = true;
    };

    render();

    const rl = createInterface({ input: process.stdin });
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const onKeypress = (chunk) => {
      const key = chunk.toString();
      if (key === "\x1b[A") {
        selected = (selected - 1 + options.length) % options.length;
        render();
      } else if (key === "\x1b[B") {
        selected = (selected + 1) % options.length;
        render();
      } else if (key === "\r" || key === "\n") {
        process.stdin.setRawMode(false);
        process.stdin.removeListener("data", onKeypress);
        rl.close();
        process.stdout.write(`  ${DIM}-> ${options[selected].label}${RESET}\n\n`);
        resolvePromise(selected);
      } else if (key === "\x03") {
        process.stdin.setRawMode(false);
        process.stdout.write("\n");
        process.exit(1);
      }
    };

    process.stdin.on("data", onKeypress);
  });
}

// ─── Interactive menu helpers ────────────────────────────────────────

// ─── Menu option definitions ─────────────────────────────────────────

const ACCESS_OPTIONS = [
  {
    label: "public",
    value: "public",
    description: "– visible to everyone",
  },
  {
    label: "restricted (private)",
    value: "restricted",
    description: "– you / org members only (requires npm Pro)",
  },
];

const TAG_OPTIONS = [
  {
    label: "latest",
    value: "latest",
    description: "– default production tag",
  },
  {
    label: "beta",
    value: "beta",
    description: "– pre-release, not installed by default",
  },
  {
    label: "next",
    value: "next",
    description: "– upcoming version",
  },
  {
    label: "canary",
    value: "canary",
    description: "– experimental build",
  },
];

// ─── Main ────────────────────────────────────────────────────────────

/**
 * Entry point for the interactive npm publish wizard.
 *
 * Guides the user through three prompts:
 *  1. Access level   — `public` (default) or `restricted`.
 *  2. Dist-tag       — `latest`, `beta`, `next`, or `canary`.
 *  3. Final confirm  — prints a summary and asks before publishing.
 *
 * Workflow:
 *  - Reads the current `package.json` and displays the version and name.
 *  - Temporarily patches `publishConfig.access` in `package.json` with the
 *    chosen access level, then calls `npm publish`.
 *  - Restores the original `package.json` in a `finally` block so the file
 *    is never left in a patched state, even on error.
 *
 * Error handling:
 *  - 402 Payment Required — guides the user to upgrade or switch to public.
 *  - ENEEDAUTH            — instructs the user to run `npm login`.
 *  - EPUBLISHCONFLICT     — instructs the user to bump the package version.
 *
 * @returns {Promise<void>}
 */
async function main() {
  console.log(`\n${BOLD}${CYAN}+--------------------------------------------------+${RESET}`);
  console.log(`${BOLD}${CYAN}|  gas-class-entrypoints  -  npm publish wizard     |${RESET}`);
  console.log(`${BOLD}${CYAN}+--------------------------------------------------+${RESET}\n`);

  const originalPkgContent = readFileSync(pkgPath, "utf-8");
  const pkg = JSON.parse(originalPkgContent);

  console.log(`  ${DIM}Current version: ${RESET}${YELLOW}${pkg.version}${RESET}`);
  console.log(`  ${DIM}Current name:    ${RESET}${YELLOW}${pkg.name}${RESET}\n`);

  // 1. Choose access level
  const accessIdx = await selectMenu("Access level:", ACCESS_OPTIONS, 0);
  const chosenAccess = ACCESS_OPTIONS[accessIdx].value;

  // 2. Choose dist-tag
  const tagIdx = await selectMenu("Dist-tag:", TAG_OPTIONS, 0);
  const chosenTag = TAG_OPTIONS[tagIdx].value;

  // ── Summary ──
  console.log(`${BOLD}${CYAN}── Summary ──${RESET}`);
  console.log(`  Name:    ${GREEN}${pkg.name}${RESET}`);
  console.log(`  Access:  ${GREEN}${chosenAccess}${RESET}`);
  console.log(`  Tag:     ${GREEN}${chosenTag}${RESET}`);
  console.log(`  Version: ${GREEN}${pkg.version}${RESET}\n`);

  // Confirm
  const confirmIdx = await selectMenu("Publish?", [
    { label: "Yes", value: true },
    { label: "No, cancel", value: false },
  ]);
  if (confirmIdx === 1) {
    console.log(`${YELLOW}Cancelled.${RESET}`);
    process.exit(0);
  }

  // ── Temporarily patch package.json ──
  // Write the chosen access level so `npm publish` picks it up.
  // The original content is always restored in the `finally` block below.
  pkg.publishConfig = { access: chosenAccess };
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");

  /**
   * Restore `package.json` to its original content.
   * Called from the `finally` block to guarantee cleanup on any code path.
   */
  const restore = () => {
    writeFileSync(pkgPath, originalPkgContent, "utf-8");
    console.log(`\n${DIM}✔ package.json restored to original.${RESET}`);
  };

  try {
    // ── Check npm auth ──
    console.log(`\n${BOLD}${CYAN}[1/2]${RESET} Checking npm login...`);
    try {
      const whoami = execSync("npm whoami", { encoding: "utf-8" }).trim();
      console.log(`  ${DIM}Logged in as:${RESET} ${GREEN}${whoami}${RESET}`);
    } catch {
      console.log(`  ${YELLOW}Not logged in. Opening npm login...${RESET}\n`);
      run("npm login");
    }

    // ── Publish ──
    console.log(`\n${BOLD}${CYAN}[2/2]${RESET} Publishing...`);
    const publishArgs = ["npm", "publish", "--access", chosenAccess];
    if (chosenTag !== "latest") {
      publishArgs.push("--tag", chosenTag);
    }
    try {
      run(publishArgs.join(" "));
    } catch (pubErr) {
      const msg = pubErr.stderr?.toString() ?? pubErr.message ?? "";
      if (/E402|402 Payment Required|sign up for private/i.test(msg)) {
        console.error(`\n${YELLOW}Error: npm returned 402 Payment Required.${RESET}`);
        console.error(`${YELLOW}Private (restricted) scoped packages require a paid npm plan.${RESET}`);
        console.error(`${DIM}Options:${RESET}`);
        console.error(
          `${DIM}  1. Upgrade to npm Pro / Org paid plan at https://www.npmjs.com/settings/billing${RESET}`,
        );
        console.error(`${DIM}  2. Re-run this wizard and choose "public" access instead.${RESET}`);
        throw new Error("Publish failed: paid plan required for restricted packages.");
      }
      if (/ENEEDAUTH|npm adduser|You need to authorize/i.test(msg)) {
        console.error(`\n${YELLOW}Error: not logged in to npm.${RESET}`);
        console.error(`${DIM}Run "npm login" and try again.${RESET}`);
        throw new Error("Publish failed: npm authentication required.");
      }
      if (/EPUBLISHCONFLICT|cannot publish over|previously published/i.test(msg)) {
        console.error(`\n${YELLOW}Error: version ${pkg.version} already exists on the registry.${RESET}`);
        console.error(`${DIM}Bump the version in package.json and try again.${RESET}`);
        throw new Error(`Publish failed: ${pkg.name}@${pkg.version} already exists.`);
      }
      throw pubErr;
    }

    console.log(`\n${GREEN}${BOLD}✔ Published ${pkg.name}@${pkg.version} [${chosenTag}]${RESET}`);
  } finally {
    restore();
  }
}

main().catch((err) => {
  console.error(`\n${YELLOW}Error: ${err.message}${RESET}`);
  process.exit(1);
});
