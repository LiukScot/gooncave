export {};

declare global {
  interface Window {
    electronAPI?: {
      pickFolder: () => Promise<string | null>;
    };
  }
}
