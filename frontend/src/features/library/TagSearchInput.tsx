import { useEffect, useRef, useState } from 'react';

import { activeTagTerm, replaceActiveTagTerm } from './tagInputTokens';

import { api, type TagSuggestion } from '@/api';

const SUGGEST_DEBOUNCE_MS = 150;
// Long enough for a click on a suggestion to land: the click blurs the input
// first, and closing the list on blur would unmount the option mid-press.
const BLUR_CLOSE_DELAY_MS = 120;

/**
 * The search box, with completion for the term the caret is in.
 *
 * The gallery completes from the user's own library: a tag no file carries
 * would only ever return an empty gallery. Explore searches remote boorus,
 * where the opposite holds — a tag the library has never seen is exactly
 * what the user is reaching for — so it passes scope="vocabulary".
 */
export function TagSearchInput({
  value,
  onChange,
  placeholder,
  id = 'gallery-tag-search',
  scope,
  onSubmit
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  /** Distinct per mount: two boxes sharing one id break their labels. */
  id?: string;
  scope?: 'library' | 'vocabulary';
  /** Enter with no suggestion highlighted. The gallery filters as you type
   *  and passes nothing; explore has to go ask the remote sites. */
  onSubmit?: () => void;
}): React.ReactElement {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([]);
  const [highlighted, setHighlighted] = useState(0);
  const [open, setOpen] = useState(false);
  const [caret, setCaret] = useState(0);
  const blurTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (blurTimerRef.current !== null) {
        window.clearTimeout(blurTimerRef.current);
      }
    },
    []
  );

  useEffect(() => {
    const term = activeTagTerm(value, caret);
    if (!term) {
      setSuggestions([]);
      return;
    }
    // Debounced and abortable: the box fires a request per keystroke
    // otherwise, and a slow one landing late would overwrite a newer list.
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api
        .suggestTags(term.query, { signal: controller.signal, scope })
        .then((result) => {
          setSuggestions(result.suggestions);
          setHighlighted(0);
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          // A failed suggestion must not break typing: drop the list and
          // leave the box alone.
          setSuggestions([]);
        });
    }, SUGGEST_DEBOUNCE_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [value, caret, scope]);

  const apply = (tag: string) => {
    const next = replaceActiveTagTerm(value, caret, tag);
    onChange(next.value);
    setSuggestions([]);
    setOpen(false);
    // The caret has to land after the inserted term, which React will not do
    // on its own once the value is controlled.
    requestAnimationFrame(() => {
      inputRef.current?.setSelectionRange(next.caret, next.caret);
      inputRef.current?.focus();
    });
  };

  const visible = open && suggestions.length > 0;

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!visible) {
      if (event.key === 'Enter' && onSubmit) {
        event.preventDefault();
        onSubmit();
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlighted((current) => (current + 1) % suggestions.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlighted(
        (current) => (current - 1 + suggestions.length) % suggestions.length
      );
    } else if (event.key === 'Enter') {
      event.preventDefault();
      apply(suggestions[highlighted].tag);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  const syncCaret = (element: HTMLInputElement) => {
    setCaret(element.selectionStart ?? element.value.length);
  };

  return (
    <span className="gallery-tag-search">
      <input
        ref={inputRef}
        id={id}
        name="tags"
        type="text"
        className="form-control form-control-sm bg-background text-foreground border-secondary gallery-control-search-input"
        placeholder={placeholder}
        value={value}
        role="combobox"
        aria-expanded={visible}
        aria-autocomplete="list"
        aria-controls={`${id}-suggestions`}
        autoComplete="off"
        onChange={(event) => {
          onChange(event.target.value);
          syncCaret(event.target);
          setOpen(true);
        }}
        onKeyUp={(event) => syncCaret(event.currentTarget)}
        onClick={(event) => syncCaret(event.currentTarget)}
        onFocus={() => {
          // Cancels a close still pending from a blur a moment ago, which
          // would otherwise shut the list right after focus came back.
          if (blurTimerRef.current !== null) {
            window.clearTimeout(blurTimerRef.current);
            blurTimerRef.current = null;
          }
          setOpen(true);
        }}
        onBlur={() => {
          blurTimerRef.current = window.setTimeout(() => {
            blurTimerRef.current = null;
            setOpen(false);
          }, BLUR_CLOSE_DELAY_MS);
        }}
        onKeyDown={onKeyDown}
      />
      {visible ? (
        <ul
          id={`${id}-suggestions`}
          className="gallery-tag-suggestions"
          role="listbox"
        >
          {suggestions.map((suggestion, index) => (
            <li key={suggestion.tag} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={index === highlighted}
                className={`gallery-tag-suggestion${
                  index === highlighted ? ' is-highlighted' : ''
                }`}
                onMouseEnter={() => setHighlighted(index)}
                onClick={() => apply(suggestion.tag)}
              >
                <span className="gallery-tag-suggestion-name">
                  {suggestion.tag}
                </span>
                {/* Vocabulary tags carry no count: the library holds none
                    of them yet, and a bare "0" reads as a broken number. */}
                {suggestion.files > 0 ? (
                  <span className="gallery-tag-suggestion-count">
                    {suggestion.files}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </span>
  );
}
