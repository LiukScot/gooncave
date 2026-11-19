import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { activeTagTerm, replaceActiveTagTerm } from './tagInputTokens';

import { api, type TagSuggestion } from '@/api';

// Short enough not to show, long enough to skip a request for a fast keystroke.
const SUGGEST_DEBOUNCE_MS = 50;
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
  onSubmit,
  onClear,
  onPick,
  recent = []
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  /** Distinct per mount: two boxes sharing one id break their labels. */
  id?: string;
  scope?: 'library' | 'vocabulary';
  /** Enter with no suggestion highlighted. */
  onSubmit?: () => void;
  onClear?: () => void;
  /** Takes the new value when a suggestion is chosen, instead of onChange. */
  onPick?: (next: string) => void;
  /** Whole searches offered while the box is empty, newest first. */
  recent?: readonly string[];
}): React.ReactElement {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([]);
  const [highlighted, setHighlighted] = useState(0);
  // Recent searches start with none highlighted, so Enter in an empty box still submits it.
  const [browsed, setBrowsed] = useState(false);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
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
    setSuggestionError(null);
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
          if (controller.signal.aborted) return;
          setSuggestionError(err instanceof Error ? err.message : 'Tag suggestions could not be loaded. Try again.');
          setSuggestions([]);
        });
    }, SUGGEST_DEBOUNCE_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [value, caret, scope, retry]);

  const apply = (tag: string) => {
    const next = replaceActiveTagTerm(value, caret, tag);
    (onPick ?? onChange)(next.value);
    setSuggestions([]);
    setOpen(false);
    // The caret has to land after the inserted term, which React will not do
    // on its own once the value is controlled.
    requestAnimationFrame(() => {
      inputRef.current?.setSelectionRange(next.caret, next.caret);
      inputRef.current?.focus();
    });
  };

  const showingRecent = value.trim() === '' && recent.length > 0;
  const options = showingRecent
    ? recent.map((search) => ({ label: search, files: 0 }))
    : suggestions.map((suggestion) => ({ label: suggestion.tag, files: suggestion.files }));
  const visible = open && options.length > 0;
  const active = showingRecent && !browsed ? -1 : Math.min(highlighted, options.length - 1);
  const choose = (index: number) => {
    if (!showingRecent) {
      apply(options[index].label);
      return;
    }
    (onPick ?? onChange)(options[index].label);
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!visible || (active < 0 && event.key === 'Enter')) {
      if (event.key === 'Enter' && onSubmit) {
        event.preventDefault();
        onSubmit();
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setBrowsed(true);
      setHighlighted((active + 1) % options.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setBrowsed(true);
      setHighlighted(active < 0 ? options.length - 1 : (active - 1 + options.length) % options.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(active);
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
        className={`form-control form-control-sm bg-background text-foreground border-secondary gallery-control-search-input${value && onClear ? ' has-clear' : ''}`}
        placeholder={placeholder}
        value={value}
        role="combobox"
        aria-expanded={visible}
        aria-autocomplete="list"
        aria-controls={visible ? `${id}-suggestions` : undefined}
        aria-activedescendant={visible && active >= 0 ? `${id}-suggestion-${active}` : undefined}
        autoComplete="off"
        onChange={(event) => {
          onChange(event.target.value);
          syncCaret(event.target);
          setBrowsed(false);
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
          setBrowsed(false);
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
      {value && onClear ? (
        <button
          type="button"
          className="gallery-tag-clear"
          aria-label="Clear search"
          title="Clear search"
          onClick={() => {
            onClear();
            inputRef.current?.focus();
          }}
        >
          <X size={16} aria-hidden="true" />
        </button>
      ) : null}
      {suggestionError ? (
        <span className="block text-destructive text-xs mt-2" role="status">
          Suggestions unavailable: {suggestionError}{' '}
          <button type="button" className="btn btn-outline-light btn-sm" onClick={() => setRetry((attempt) => attempt + 1)}>
            Load suggestions again
          </button>
        </span>
      ) : null}
      {visible ? (
        <ul
          id={`${id}-suggestions`}
          className="gallery-tag-suggestions"
          role="listbox"
          aria-label={showingRecent ? 'Recent searches' : 'Tag suggestions'}
        >
          {showingRecent ? (
            <li role="presentation" className="gallery-tag-suggestions-caption">
              Recent searches
            </li>
          ) : null}
          {options.map((option, index) => (
            <li key={option.label} role="presentation">
              <button
                type="button"
                role="option"
                id={`${id}-suggestion-${index}`}
                aria-selected={index === active}
                className={`gallery-tag-suggestion${
                  index === active ? ' is-highlighted' : ''
                }`}
                onMouseEnter={() => {
                  setBrowsed(true);
                  setHighlighted(index);
                }}
                onClick={() => choose(index)}
              >
                <span className="gallery-tag-suggestion-name">
                  {option.label}
                </span>
                {/* Vocabulary tags carry no count: the library holds none
                    of them yet, and a bare "0" reads as a broken number. */}
                {option.files > 0 ? (
                  <span className="gallery-tag-suggestion-count">
                    {option.files}
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
