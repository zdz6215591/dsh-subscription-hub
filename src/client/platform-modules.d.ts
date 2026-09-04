/**
 * Ambient declarations for shell platform modules this package imports at
 * VALUE level but cannot resolve at typecheck time: they are entries of the
 * shell's loader module table (tsdown externals), answered at runtime, yet
 * not declared devDependencies, so pnpm's isolated layout hides them from
 * tsc. Each declaration mirrors the verified source contract cited in its
 * comment; adding the real link: devDependencies later makes these redundant
 * (delete this file then — the real types win).
 *
 * `@deepseek-ai/dsh-client-ui-attachment` is deliberately absent: since
 * web-app rc.8 its browser module exports only the cordis plugin surface, so
 * this package renders its own gallery (src/client/ImageGallery.tsx) instead
 * of importing platform components.
 */

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  /** Mirror of IconSparkle16 (packages/client/ui-primitives/src/icons/index.tsx). */
  export function IconSparkle16(props: {
    size?: number
    className?: string
  }): import('react').ReactNode
}
