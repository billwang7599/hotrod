// Kothar's mark (an anvil and a spark), drawn in currentColor so it follows the theme. Same paths as logo.svg.
const ANVIL = 'M232 372C262 360 284 356 314 356L796 356L796 434L700 468C664 496 648 540 648 580L648 600C690 610 724 632 742 668L742 700L358 700L358 668C376 632 410 610 452 600L452 580C452 540 436 500 404 482C336 468 272 430 232 372Z'
const SPARK = 'M612 144L630 212L698 230L630 248L612 316L594 248L526 230L594 212Z'

export function KotharMark({ className }: { className?: string }) {
  return (
    <svg viewBox="202 110 624 624" aria-hidden="true" className={className} fill="currentColor">
      <path d={ANVIL} />
      <path d={SPARK} />
    </svg>
  )
}
