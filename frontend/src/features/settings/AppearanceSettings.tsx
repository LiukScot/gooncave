import { Monitor, Moon, Sun } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';

import {
  TINT_ACCENTS,
  type AppearanceAccent,
  accentLabel,
  accentSwatch
} from '@/lib/accents';
import { scrollSidewaysOnWheel } from '@/lib/scrollSidewaysOnWheel';
import {
  type AppearanceMode,
  type AppearanceStyle,
  useAppearanceStore
} from '@/stores/appearanceStore';

const MODES: { value: AppearanceMode; label: string; icon: LucideIcon }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor }
];

const STYLES: { value: AppearanceStyle; label: string; description: string }[] = [
  {
    value: 'material',
    label: 'Material Edition',
    description: 'Colours pulled from the picture you open, round and bouncy.'
  },
  {
    value: 'apple',
    label: 'Apple Edition',
    description: 'Liquid Glass bars, iOS colours and grouped lists.'
  },
  {
    value: 'custom',
    label: 'Custom',
    description: 'The original GoonCave look: outlined controls, blue-grey panels.'
  }
];

// The basics, then the tints, split by a rule as in Android's own picker.
const ACCENT_GROUPS: readonly (readonly AppearanceAccent[])[] = [
  ['mono', 'blue'],
  TINT_ACCENTS
];

function Section({
  id,
  title,
  description,
  children
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="appearance-group" aria-labelledby={id}>
      <h2 id={id} className="appearance-group-title">
        {title}
      </h2>
      <p className="appearance-group-description">{description}</p>
      {children}
    </section>
  );
}

/** A small drawing of a settings list in each style, in the current mode. */
function StylePreview({ style }: { style: AppearanceStyle }) {
  return (
    <span className={`appearance-preview appearance-preview-${style}`} aria-hidden="true">
      <span className="appearance-preview-title" />
      <span className="appearance-preview-list">
        <span className="appearance-preview-row" />
        <span className="appearance-preview-row" />
        <span className="appearance-preview-row" />
      </span>
      <span className="appearance-preview-bar" />
    </span>
  );
}

export function AppearanceSettings() {
  const mode = useAppearanceStore((state) => state.mode);
  const style = useAppearanceStore((state) => state.style);
  const accent = useAppearanceStore((state) => state.accent);
  const setMode = useAppearanceStore((state) => state.setMode);
  const setStyle = useAppearanceStore((state) => state.setStyle);
  const setAccent = useAppearanceStore((state) => state.setAccent);

  return (
    <div className="appearance-settings">
      <Section
        id="appearance-mode"
        title="Mode"
        description="System follows your phone or computer, day and night."
      >
        <div className="btn-group appearance-mode" role="group" aria-labelledby="appearance-mode">
          {MODES.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              className={`btn ${mode === value ? 'btn-primary' : 'btn-outline-light'}`}
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
            >
              <Icon className="size-4" aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
      </Section>

      <Section
        id="appearance-accent"
        title="Accent colour"
        description={
          style === 'material'
            ? 'Every colour of the app grows from this one. An open picture swaps in its own.'
            : 'Buttons, links and the chosen tab wear it. An open picture swaps in its own.'
        }
      >
        <div
          className="appearance-accents"
          role="radiogroup"
          aria-labelledby="appearance-accent"
          ref={scrollSidewaysOnWheel}
        >
          {ACCENT_GROUPS.map((group, index) => (
            <div key={index} className="appearance-accent-group">
              {group.map((key) => (
                <label key={key} className="appearance-accent" title={accentLabel(key)}>
                  <input
                    type="radio"
                    name="appearance-accent"
                    value={key}
                    checked={accent === key}
                    onChange={() => setAccent(key)}
                    className="visually-hidden"
                  />
                  <span
                    className={`appearance-accent-swatch appearance-accent-${key === 'mono' ? 'mono' : 'colour'}`}
                    style={
                      key === 'mono'
                        ? undefined
                        : ({ '--swatch': accentSwatch(key) } as CSSProperties)
                    }
                  />
                  <span className="visually-hidden">{accentLabel(key)}</span>
                </label>
              ))}
            </div>
          ))}
        </div>
      </Section>

      <Section
        id="appearance-style"
        title="Style"
        description="The look of the whole app. Saved on this device only."
      >
        <div className="appearance-styles" role="radiogroup" aria-labelledby="appearance-style">
          {STYLES.map(({ value, label, description }) => (
            <label key={value} className="appearance-style">
              <input
                type="radio"
                name="appearance-style"
                value={value}
                checked={style === value}
                onChange={() => setStyle(value)}
                className="visually-hidden"
              />
              <StylePreview style={value} />
              <span className="appearance-style-text">
                <span className="appearance-style-name">{label}</span>
                <span className="block text-muted-foreground text-xs">{description}</span>
              </span>
            </label>
          ))}
        </div>
      </Section>
    </div>
  );
}
