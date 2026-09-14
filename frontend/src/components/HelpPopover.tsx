import type { ReactElement } from 'react';

import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '@/components/ui/popover';

export function HelpPopover({ text }: { text: string }): ReactElement {
  return (
    <>
      <span
        className="favorites-help-dot favorites-help-desktop"
        role="img"
        title={text}
        aria-label={text}
      >
        ?
      </span>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="favorites-help-dot favorites-help-mobile"
            aria-label={text}
            onClick={(event) => event.stopPropagation()}
          >
            ?
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64 text-sm" sideOffset={4}>
          {text}
        </PopoverContent>
      </Popover>
    </>
  );
}
