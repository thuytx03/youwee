import { createContext, type ReactNode, useContext } from 'react';
import {
  type PreviewConfirmInfo,
  type ProcessingContextValue,
  useProcessingController,
} from './editor/useVideoEditorController';

const VideoEditorContext = createContext<ProcessingContextValue | null>(null);

export function VideoEditorProvider({ children }: { children: ReactNode }) {
  const value = useProcessingController();
  return <VideoEditorContext.Provider value={value}>{children}</VideoEditorContext.Provider>;
}

export function useVideoEditor() {
  const context = useContext(VideoEditorContext);
  if (!context) {
    throw new Error('useVideoEditor must be used within a VideoEditorProvider');
  }
  return context;
}

export type { PreviewConfirmInfo, ProcessingContextValue };
