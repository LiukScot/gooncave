import { create } from 'zustand';

/** Whether the side menu is open on a screen too narrow to keep it showing. */
export const useAppMenuStore = create<{
  open: boolean;
  setOpen: (open: boolean) => void;
}>((set) => ({
  open: false,
  setOpen: (open) => set({ open })
}));
