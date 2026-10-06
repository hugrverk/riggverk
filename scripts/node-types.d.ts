// Minimal ambient Node declarations so check scripts and tests type-check without @types/node.
// Covers only the APIs they use. Delete this file once @types/node is a declared devDependency.

declare module "node:assert/strict" {
  interface StrictAssert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    match(value: string, regExp: RegExp, message?: string): void;
    doesNotMatch(value: string, regExp: RegExp, message?: string): void;
  }
  const assert: StrictAssert;
  export default assert;
}

declare module "node:fs" {
  interface DirEntry {
    name: string;
    isDirectory(): boolean;
  }
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
  export function readdirSync(path: string): string[];
  export function readdirSync(path: string, options: { withFileTypes: true }): DirEntry[];
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}

declare namespace NodeJS {
  interface ErrnoException extends Error {
    code?: string;
  }
}

interface ImportMeta {
  dirname: string;
}
