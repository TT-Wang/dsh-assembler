/** Minimal ambient declaration for the CJS js-yaml package (types not installed). */
declare module 'js-yaml' {
  export function load(input: string, options?: Record<string, unknown>): unknown
  export function dump(value: unknown, options?: Record<string, unknown>): string
}
