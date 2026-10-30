import { Ban } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { parseBlacklistInput } from "./blacklist";
import { ShowMoreList } from "./ShowMoreList";
import { SubscriptionRow } from "./SubscriptionRow";
import { TagDatabaseStatus } from "./TagDatabaseStatus";

import { PillSwitch } from "@/components/pill-switch";
import {
  useBlacklistSettings,
  useUpdateBlacklistSettings,
} from "@/hooks/settings";

type BlacklistTarget = "applyToExplore" | "applyToGallery";

const TARGETS: {
  key: BlacklistTarget;
  label: string;
  description: string;
}[] = [
  {
    key: "applyToExplore",
    label: "Explore",
    description: "Hide booru results carrying a blacklisted tag.",
  },
  {
    key: "applyToGallery",
    label: "Gallery",
    description: "Hide your own files carrying a blacklisted tag.",
  },
];

export function BlacklistSettings() {
  const settings = useBlacklistSettings();
  const update = useUpdateBlacklistSettings();
  const [draft, setDraft] = useState<string | null>(null);
  const saved = settings.tags.join("\n");

  // Re-seeded only when the stored list itself changes — after a save, or
  // after an edit made elsewhere. A refetch that returns the same list
  // leaves whatever is being typed alone.
  useEffect(() => {
    setDraft(null);
  }, [saved]);

  const value = draft ?? saved;
  const dirty = parseBlacklistInput(value).join("\n") !== saved;
  const [newTag, setNewTag] = useState("");
  const added = parseBlacklistInput(newTag);
  const error = update.error?.message ?? null;

  const save = (tags: string[]) => update.mutateAsync({ tags });

  const add = async () => {
    const next = [...new Set([...settings.tags, ...added])];
    if (!added.length || next.length === settings.tags.length) return;
    try {
      await save(next);
      setNewTag("");
    } catch {
      // The mutation error is shown under the list.
    }
  };

  const remove = async (tag: string) => {
    const before = settings.tags;
    try {
      await save(before.filter((item) => item !== tag));
    } catch {
      return;
    }
    toast.success(`Removed “${tag}” from the blacklist`, {
      action: { label: "Undo", onClick: () => void save(before) },
    });
  };

  const toggle = (key: BlacklistTarget) =>
    update.mutate({ [key]: !settings[key] });

  return (
    <div className="col-12">
      <section className="settings-section">
        <h2 className="h5 mb-1">Blacklisted tags</h2>
        <p className="text-muted-foreground text-xs mb-3">
          A tag you search for explicitly still shows, so the blacklist never
          leaves you with no results.
        </p>
        <form
          className="flex gap-2 mb-3"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <label className="visually-hidden" htmlFor="blacklist-new-tag">
            New tag
          </label>
          <input
            className="form-control form-control-sm"
            id="blacklist-new-tag"
            name="blacklist-new-tag"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="Add tags, separated by spaces or commas"
            value={newTag}
            onChange={(event) => setNewTag(event.target.value)}
          />
          <button
            className="btn btn-primary btn-sm shrink-0"
            type="submit"
            disabled={!added.length || update.isPending}
          >
            Add
          </button>
        </form>

        {settings.tags.length ? (
          <ShowMoreList
            items={settings.tags}
            getKey={(tag) => tag}
            label="tags"
            renderRow={(tag) => (
              <SubscriptionRow
                removeLabel={`Remove ${tag} from the blacklist`}
                removeDisabled={update.isPending}
                onRemove={() => void remove(tag)}
                open={
                  <span className="subscription-row-open">
                    <Ban className="subscription-row-icon" aria-hidden="true" />
                    <span className="subscription-row-text">
                      <span className="subscription-row-title">{tag}</span>
                    </span>
                  </span>
                }
              />
            )}
          />
        ) : (
          <p className="text-muted-foreground text-sm mb-3">
            No blacklisted tags yet.
          </p>
        )}

        <details className="subscription-text-editor">
          <summary className="text-sm font-medium">Edit as text</summary>
          <label
            className="block font-medium mt-3 mb-2"
            htmlFor="blacklist-tags"
          >
            One tag per line
          </label>
          <textarea
            className="form-control mb-2"
            id="blacklist-tags"
            name="blacklist-tags"
            rows={7}
            spellCheck={false}
            value={value}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex items-center gap-3">
            <button
              className="btn btn-primary btn-sm"
              type="button"
              disabled={update.isPending || !dirty}
              onClick={() => void save(parseBlacklistInput(value))}
            >
              {update.isPending ? "Saving…" : "Save list"}
            </button>
            {dirty ? (
              <span className="text-muted-foreground text-xs">
                Unsaved changes
              </span>
            ) : null}
          </div>
        </details>
      </section>

      <div className="list-group">
        {TARGETS.map(({ key, label, description }) => (
          <div key={key} className="list-group-item flex items-center gap-3">
            <span className="flex-1 min-w-0">
              <label className="block font-medium" htmlFor={`blacklist-${key}`}>
                {label}
              </label>
              <span className="block text-muted-foreground text-xs">
                {description}
              </span>
            </span>
            <PillSwitch
              id={`blacklist-${key}`}
              name={`blacklist-${key}`}
              checked={settings[key]}
              onChange={() => toggle(key)}
            />
          </div>
        ))}
      </div>

      <TagDatabaseStatus />

      {error ? (
        <div className="text-destructive text-sm mt-2">{error}</div>
      ) : null}
    </div>
  );
}
