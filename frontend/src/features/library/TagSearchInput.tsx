import { useEffect, useRef, useState } from 'react';

import { activeTagTerm, replaceActiveTagTerm } from './tagInputTokens';

import { api, type TagSuggestion } from '@/api';

const SUGGEST_DEBOUNCE_MS = 150;

/**
 * The gallery search box, with completion for the term the caret is in.
 *
 * Suggestions come from the user's own library rather than the whole booru
 * vocabulary: a tag no file carries would only ever return an empty gallery.
 */
export function TagSearchInput({
  value,
  onChange,
  placeholder
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
}): React.ReactElement {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([]);
  const [highlighted, setHighlighted] = useState(0);
  const [open, setOpen] = useState(false);
  const [caret, setCaret] = useState(0);

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
        .suggestTags(term.query, { signal: controller.signal })
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
  }, [value, caret]);

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
    if (!visible) return;
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
        className="form-control form-control-sm bg-background text-foreground border-secondary gallery-control-search-input"
        placeholder={placeholder}
        value={value}
        role="combobox"
        aria-expanded={visible}
        aria-autocomplete="list"
        aria-controls="gallery-tag-suggestions"
        autoComplete="off"
        onChange={(event) => {
          onChange(event.target.value);
          syncCaret(event.target);
          setOpen(true);
        }}
        onKeyUp={(event) => syncCaret(event.currentTarget)}
        onClick={(event) => syncCaret(event.currentTarget)}
        onFocus={() => setOpen(true)}
        // Deferred: a click on a suggestion blurs the input first, and
        // closing straight away would unmount the option before it fires.
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
      />
      {visible ? (
        <ul
          id="gallery-tag-suggestions"
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
                <span className="gallery-tag-suggestion-count">
                  {suggestion.files}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </span>
  );
}
