import type { InputHTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

/**
 * The app's one on/off control: the pill of `.form-switch` (app.css). It is a
 * native checkbox read as a switch, so Space toggles it, a label's `htmlFor`
 * and `aria-label` name it, and it takes taps and clicks alike.
 */
export function PillSwitch({
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'role'>) {
  return (
    <span className="form-switch contents">
      <input {...props} type="checkbox" role="switch" className={cn('form-check-input shrink-0', className)} />
    </span>
  );
}
