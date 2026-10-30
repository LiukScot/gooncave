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
  useAppearanceStore
} from '@/stores/appearanceStore';

const MODES: { value: AppearanceMode; label: string; icon: LucideIcon }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor }
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

export function AppearanceSettings() {
  const mode = useAppearanceStore((state) => state.mode);
  const accent = useAppearanceStore((state) => state.accent);
  const setMode = useAppearanceStore((state) => state.setMode);
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
        description="Buttons, links and the chosen tab wear it. Saved on this device only."
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
    </div>
  );
}
