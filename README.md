# @b2bc-devkit/gas-class-entrypoints

Vite/Rollup plugin that exposes static methods of exported classes as top-level Google Apps Script functions.

## How it works

![Plugin pipeline visualization](assets/how-it-works.svg)

## Problem

Google Apps Script discovers callable functions by scanning for top-level `function Name() {}` declarations at parse time. When you bundle code with Vite/Rollup the functions end up inside an IIFE or module scope and remain invisible to the GAS scanner.

## Solution

This plugin:

1. Injects a virtual entry module (`gas-entry`) that imports the compiled entry file produced by `tsc` and assigns every configured class static method to `globalThis`, making them callable at GAS runtime.
2. Prepends `function Name() {}` stubs for each binding so that GAS discovers the function names at parse time.
3. Wraps the entire bundle in an IIFE to prevent internal helpers and module-scoped variables from polluting the GAS global scope.

## Prerequisites

- Your TypeScript source is compiled with `tsc` **before** running Vite.  
  The plugin looks for the entry file at `build/index.js` (flat layout) or `build/src/index.js` (mirrored layout when `rootDir` is `src/`).
- Vite `>= 5.0.0` is installed.

A typical build sequence:

```bash
tsc && vite build
```

## Installation

```bash
npm install @b2bc-devkit/gas-class-entrypoints --save-dev
```

## Usage

Set `input` to the virtual `"gas-entry"` specifier and add the plugin to your Vite config:

```js
// vite.config.js
import { defineConfig } from "vite";
import gasClassEntrypoints from "@b2bc-devkit/gas-class-entrypoints";

export default defineConfig({
  build: {
    rollupOptions: {
      input: "gas-entry",
    },
  },
  plugins: [
    gasClassEntrypoints({
      classEntrypoints: {
        GasEntrypoints: ["demoCreate", "demoRead"],
      },
    }),
  ],
});
```

### Options

| Option             | Type                         | Description                                                                                        |
| ------------------ | ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `classEntrypoints` | `Record<string, string[]>`   | Map of exported class names to arrays of static method names to expose as top-level GAS functions. |

### Example

Given a TypeScript class:

```ts
// src/index.ts
export class GasEntrypoints {
  static demoCreate() { /* ... */ }
  static demoRead()   { /* ... */ }
}
```

After `tsc && vite build` the output bundle will contain:

```js
function demoCreate() {}
function demoRead() {}
!function(){
  // ... bundled code ...
  globalThis.demoCreate = function(){ return GasEntrypoints.demoCreate(); };
  globalThis.demoRead   = function(){ return GasEntrypoints.demoRead(); };
}();
```

GAS sees `demoCreate` and `demoRead` as callable top-level functions and they correctly delegate to the class static methods at runtime.

## Peer Dependencies

- `vite` >= 5.0.0

## License

[GPL-3.0-or-later](https://www.gnu.org/licenses/gpl-3.0.html)
