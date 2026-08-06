import { create } from 'zustand';

export type CleanupMode = 'delogo' | 'blur' | 'fill';

/** A region the user drew, in STAGE coordinates (the project's canvas space). */
export interface StageRegion {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface TextRegionState {
  /** True while the Preview overlay is capturing pointer events to draw boxes. */
  active: boolean;
  /** Clip the regions belong to; regions reset when it changes. */
  clipId: string | null;
  regions: StageRegion[];
  mode: CleanupMode;
  selectedId: string | null;
}

interface TextRegionActions {
  /** Enter/leave draw mode for a clip. Leaving keeps the regions. */
  setActive: (active: boolean, clipId?: string | null) => void;
  addRegion: (r: Omit<StageRegion, 'id'>) => void;
  removeRegion: (id: string) => void;
  selectRegion: (id: string | null) => void;
  setMode: (mode: CleanupMode) => void;
  /** Drop everything — after a successful run, or when the clip changes. */
  reset: () => void;
}

let regionSeq = 0;

/**
 * Regions are stored in STAGE space, not source pixels.
 *
 * The overlay has to redraw them on every resize and aspect-ratio change, which
 * is a stage→screen mapping; keeping the source-pixel conversion for submit time
 * means it happens exactly once, against the clip's live transform.
 *
 * Not persisted: this is scratch state for one operation.
 */
export const useTextRegionStore = create<TextRegionState & TextRegionActions>((set) => ({
  active: false,
  clipId: null,
  regions: [],
  mode: 'delogo',
  selectedId: null,

  setActive: (active, clipId) =>
    set((s) => {
      const nextClip = clipId === undefined ? s.clipId : clipId;
      // Switching to a different clip invalidates the boxes — they were drawn
      // against the old clip's placement.
      const clipChanged = nextClip !== s.clipId;
      return {
        active,
        clipId: nextClip,
        regions: clipChanged ? [] : s.regions,
        selectedId: clipChanged ? null : s.selectedId,
      };
    }),

  addRegion: (r) =>
    set((s) => {
      const id = `r${++regionSeq}`;
      return { regions: [...s.regions, { ...r, id }], selectedId: id };
    }),

  removeRegion: (id) =>
    set((s) => ({
      regions: s.regions.filter((r) => r.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
    })),

  selectRegion: (selectedId) => set({ selectedId }),
  setMode: (mode) => set({ mode }),
  reset: () => set({ active: false, clipId: null, regions: [], selectedId: null }),
}));
