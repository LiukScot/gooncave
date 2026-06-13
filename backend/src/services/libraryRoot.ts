import path from 'node:path';

/**
 * Resolve a stored library root, treating empty/whitespace as "unset".
 *
 * `path.resolve('')` returns the process cwd, so a blank stored root (e.g. the
 * placeholder used when seeding a user) would otherwise be mistaken for a real,
 * existing directory and uploads would land next to the running backend.
 */
export const resolveStoredRoot = (libraryRoot: string): string | null => {
  const trimmed = libraryRoot.trim();
  return trimmed ? path.resolve(trimmed) : null;
};

/**
 * Pick the effective library root. An unset stored root always yields the
 * preferred (canonical) location; otherwise the preferred location wins only
 * when the stored one is missing or empty.
 */
export const chooseLibraryRoot = (input: {
  storedRoot: string | null;
  preferredRoot: string;
  storedExists: boolean;
  storedHasEntries: boolean;
  preferredExists: boolean;
}): string => {
  const {
    storedRoot,
    preferredRoot,
    storedExists,
    storedHasEntries,
    preferredExists
  } = input;
  if (!storedRoot) return preferredRoot;
  if (
    storedRoot !== preferredRoot &&
    preferredExists &&
    (!storedExists || !storedHasEntries)
  ) {
    return preferredRoot;
  }
  return storedExists ? storedRoot : preferredRoot;
};
