/**
 * @b2bc-devkit/gas-class-entrypoints
 *
 * Vite/Rollup plugin for Google Apps Script (GAS) projects that bridges
 * ES-module class-based code with the GAS runtime's function-discovery
 * mechanism.
 *
 * Background
 * ----------
 * GAS scans each script file for top-level `function Name() {}` declarations
 * at parse time to build the list of callable functions (shown in the editor
 * run menu, usable as trigger targets, etc.).  When code is bundled with
 * Vite/Rollup the functions end up inside an IIFE or module scope and remain
 * invisible to the scanner.
 *
 * What this plugin does
 * ---------------------
 * 1. Injects a virtual entry module (resolved as `gas-entry`) that
 *    imports the compiled entry file produced by `tsc` and assigns every
 *    configured class static method to `globalThis`, making them callable
 *    at runtime.
 * 2. Prepends `function Name() {}` stubs for each binding so that GAS
 *    discovers the function names at parse time.
 * 3. Wraps the entire bundle in an IIFE to prevent internal helpers and
 *    module-scoped variables from polluting the GAS global scope.
 *
 * @module gas-class-entrypoints
 */

import fs from "fs";
import path from "path";

/**
 * Rollup virtual module identifier for the synthetic GAS entry point.
 *
 * The leading NUL character (`\0`) is a Rollup convention that prevents
 * other plugins from accidentally trying to resolve or transform this id.
 */
const VIRTUAL_ID = "\0gas-entry";

/**
 * Locate the compiled TypeScript entry file in the project's build output.
 *
 * Checks the two most common `tsc` output layouts in order:
 *  - `<root>/build/index.js`      — flat output (no `rootDir` remapping)
 *  - `<root>/build/src/index.js`  — mirrored layout when `rootDir` is `src/`
 *
 * Falls back to the first candidate path if neither file exists, so that
 * Rollup can emit a descriptive "file not found" error rather than a
 * cryptic plugin crash.
 *
 * @param {string} rootDir  Absolute path to the Vite/Rollup project root.
 * @returns {string}        Absolute path to the entry JS file.
 */
function resolveRealEntry(rootDir) {
  const candidates = [path.resolve(rootDir, "build/index.js"), path.resolve(rootDir, "build/src/index.js")];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return candidates[0];
}

/**
 * Parse a compiled JS file to discover all exported symbol names.
 *
 * Supports the two export forms emitted by `tsc`:
 *  - Re-export list:   `export { Foo, Bar as Baz }`
 *    → The *external* name (after `as`, if present) is collected.
 *  - Inline export:    `export class Foo`, `export function bar`,
 *                      `export const/let/var qux`
 *
 * Names are deduplicated via a Set before being returned.
 *
 * @param {string} entryPath  Absolute path to the compiled JS entry file.
 * @returns {string[]}        Deduplicated array of exported symbol names.
 */
function detectExportNames(entryPath) {
  const src = fs.readFileSync(entryPath, "utf8");
  const names = new Set();

  for (const [, list] of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const token of list.split(",")) {
      const name = token
        .trim()
        .split(/\s+as\s+/)
        .pop()
        .trim();
      if (name) names.add(name);
    }
  }
  for (const [, name] of src.matchAll(/export\s+(?:class|function|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    if (name) names.add(name.trim());
  }

  return [...names];
}

/**
 * Convert a list of export names into binding descriptor objects.
 *
 * For each export name:
 *  - If the name appears as a key in `classEntrypoints`, it is treated as
 *    a class and expanded into one descriptor per configured static method.
 *    The `globalName` (top-level GAS function name) equals the method name.
 *  - Otherwise the export is treated as a plain value and produces a single
 *    descriptor where `methodName` is `null` (direct assignment).
 *
 * @param {string[]}                 exportNames       Exports discovered in the entry file.
 * @param {Record<string, string[]>} classEntrypoints  Plugin option mapping class name → method names.
 * @returns {Array<{globalName: string, exportName: string, methodName: string|null}>}
 *   Flat array of binding descriptors consumed by the `load` and
 *   `generateBundle` hooks.
 */
function resolveBindings(exportNames, classEntrypoints) {
  return exportNames.flatMap((name) => {
    const methods = classEntrypoints[name];
    return methods
      ? methods.map((m) => ({ globalName: m, exportName: name, methodName: m }))
      : [{ globalName: name, exportName: name, methodName: null }];
  });
}

/**
 * Create the Vite/Rollup plugin.
 *
 * @param {Object}                   options
 * @param {Record<string, string[]>} options.classEntrypoints
 *   Map of exported class names to arrays of static method names that
 *   should be exposed as individual top-level GAS functions.
 *   Example: `{ GasEntrypoints: ["demoCreate", "demoRead"] }`
 *
 * @returns {import("vite").Plugin}
 */
export default function gasClassEntrypoints({ classEntrypoints = {} } = {}) {
  /** Binding descriptors built during the `load` hook and consumed by `generateBundle`. */
  let gasBindings = [];

  /** Absolute path to the Vite project root; updated by `configResolved`. */
  let rootDir = process.cwd();

  return {
    /** Plugin name used by Vite/Rollup for error messages and ordering. */
    name: "gas-class-entrypoints",

    /**
     * Vite hook — called once the resolved Vite config is available.
     * Captures the project root so that `resolveRealEntry` can locate the
     * compiled entry file relative to the correct directory rather than the
     * current working directory.
     *
     * @param {import("vite").ResolvedConfig} config  Resolved Vite configuration.
     */
    configResolved(config) {
      rootDir = config.root;
    },

    /**
     * Rollup hook — intercepts module resolution for the `gas-entry` specifier.
     *
     * When Rollup tries to resolve `gas-entry` (imported by the user's Vite
     * config input or internally by the plugin), this hook returns the virtual
     * module ID so that the `load` hook below can provide synthetic source code
     * without requiring an actual file on disk.
     *
     * @param {string} source  The import specifier being resolved.
     * @returns {string|null}  Virtual ID when matched, otherwise `null` to defer
     *                         resolution to the next plugin.
     */
    resolveId(source) {
      if (source === "gas-entry") return VIRTUAL_ID;
      return null;
    },

    /**
     * Rollup hook — provides synthetic source code for the virtual GAS entry.
     *
     * Steps:
     *  1. Locate the compiled entry file (`tsc` output) in the project.
     *  2. Detect all exported symbol names from that file.
     *  3. Resolve them into binding descriptors (class-method pairs or direct
     *     assignments), storing them in `gasBindings` for `generateBundle`.
     *  4. Return an ES module snippet that:
     *       a. Imports the required exports from the real entry file.
     *       b. Assigns each binding to `globalThis` so they are callable at
     *          GAS runtime after IIFE wrapping.
     *
     * @param {string} id  The module ID being loaded.
     * @returns {string|undefined}  Synthetic module source, or `undefined` to
     *                              defer loading to the next plugin.
     */
    load(id) {
      if (id !== VIRTUAL_ID) return;

      const realEntry = resolveRealEntry(rootDir);
      const exportNames = detectExportNames(realEntry);
      gasBindings = resolveBindings(exportNames, classEntrypoints);

      // Deduplicate class names that appear multiple times (one per method).
      const imports = [...new Set(gasBindings.map((b) => b.exportName))].join(", ");

      // Rollup requires forward slashes in virtual module source paths.
      const entryUrl = realEntry.replace(/\\/g, "/");

      // For class methods: wrap in a function so `this` is not the global.
      // For plain exports: assign the value directly.
      const assignments = gasBindings
        .map((b) =>
          b.methodName
            ? `__g.${b.globalName} = function(){ return ${b.exportName}.${b.methodName}(); };`
            : `__g.${b.globalName} = ${b.exportName};`,
        )
        .join("\n");

      return [
        `import { ${imports} } from "${entryUrl}";`,
        // Prefer globalThis; fall back to `this` for older V8 builds used by GAS.
        `var __g = typeof globalThis !== "undefined" ? globalThis : this;`,
        assignments,
      ].join("\n");
    },

    /**
     * Rollup hook — post-processes every output chunk.
     *
     * For each JS chunk in the bundle:
     *  1. Prepends empty `function Name() {}` stubs for every binding so that
     *     the GAS parser discovers the function names at parse time (before
     *     any code runs).
     *  2. Wraps the original chunk code in a self-invoking IIFE (`!function(){
     *     ...}()`) to prevent helper variables and imported names from leaking
     *     into the GAS global scope.
     *
     * @param {import("rollup").NormalizedOutputOptions} _options  Output options (unused).
     * @param {import("rollup").OutputBundle}            bundle    Map of chunk/asset file names
     *                                                             to their descriptor objects.
     */
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === "chunk" && gasBindings.length > 0) {
          const stubs = gasBindings.map((b) => `function ${b.globalName}() {}`).join("\n");
          chunk.code = stubs + "\n!function(){\n" + chunk.code + "\n}();";
        }
      }
    },
  };
}
