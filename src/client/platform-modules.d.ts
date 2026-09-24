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
  export function IconSparkleRegular(props: { size?: number; className?: string }): import('react').ReactNode
  export function IconSparkleMedium(props: { size?: number; className?: string }): import('react').ReactNode
  export function IconSparkle16(props: { size?: number; className?: string }): import('react').ReactNode

  export function IconDataOutlineRegular(props: { size?: number; className?: string }): import('react').ReactNode
  export function IconDataOutlineMedium(props: { size?: number; className?: string }): import('react').ReactNode
  export function IconDataOutline16(props: { size?: number; className?: string }): import('react').ReactNode

  export interface AnchoredPositionOptions {
    open: boolean
    anchorRef: import('react').RefObject<HTMLElement | null>
    panelRef: import('react').RefObject<HTMLElement | null>
    side?: 'top' | 'bottom' | 'left' | 'right'
    align?: 'start' | 'center' | 'end'
    gap?: number
    margin?: number
  }

  export function useAnchoredPosition(options: AnchoredPositionOptions): { left: number; top: number } | null

  export function useDismissOnOutsidePointer(
    anchorRef: import('react').RefObject<HTMLElement | null>,
    open: boolean,
    setOpen: (open: boolean) => void,
    panelRef?: import('react').RefObject<HTMLElement | null>,
  ): void
}

declare module 'react-dom' {
  export function createPortal(
    children: import('react').ReactNode,
    container: Element | DocumentFragment,
    key?: null | string,
  ): import('react').ReactPortal
}
