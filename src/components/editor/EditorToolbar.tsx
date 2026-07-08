import type { PlaybackEngine, TimelineEngine } from '@elah/editor';
import { exportVideo, insertMediaAsset, useMediaLibraryStore, useSelectionStore } from '@elah/editor';
import { Download, Plus, Redo2, Scissors, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useToast } from '@/components/ui/toast';
import {
  pickProcessingOutputDirectory,
  revealOutputInFolder,
  saveEditorExport,
} from '@/contexts/editor/editor-client';

interface EditorToolbarProps {
  engine: TimelineEngine | null;
  playback: PlaybackEngine | null;
}

function timestamp(): string {
  // Date is available in the renderer (only workflow scripts forbid it).
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function EditorToolbar({ engine, playback }: EditorToolbarProps) {
  const toast = useToast();
  const selectedClipIds = useSelectionStore((s) => s.selectedClipIds);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<string>('');

  // Drag-drop / double-click into the timeline is unreliable in the desktop
  // webview, so add the selected (or first) media asset via the engine API.
  const handleAddToTimeline = async () => {
    if (!engine) return;
    const { assets, order } = useMediaLibraryStore.getState();
    const assetId = order[order.length - 1]; // most recently imported
    if (!assetId) {
      toast.info({ title: 'Chưa có media', message: 'Thêm video vào panel Media trước.' });
      return;
    }
    const res = await insertMediaAsset(engine, assetId, { desiredStartFrame: 0 });
    if (res.ok) {
      toast.success({ title: 'Đã thêm vào timeline', message: assets[assetId]?.name ?? '' });
    } else {
      toast.error({ title: 'Không thêm được', message: `Lý do: ${res.reason}` });
    }
  };

  const handleSplit = () => {
    if (!engine || !playback) return;
    const firstId = selectedClipIds.values().next().value as string | undefined;
    if (!firstId) {
      toast.info({ title: 'Chưa chọn clip', message: 'Chọn một clip rồi tách tại vị trí con trỏ.' });
      return;
    }
    const found = engine.findClip(firstId);
    if (!found) return;
    const at = playback.currentFrame;
    const res = engine.splitClip(found.clip.id, found.trackId, at);
    if (!res) {
      toast.warning({ title: 'Không tách được', message: 'Con trỏ không nằm trong clip đã chọn.' });
    }
  };

  const handleExport = async () => {
    if (!engine || exporting) return;
    const project = engine.getProject();
    const clipCount = Object.values(project.clips).flat().length;
    if (clipCount === 0) {
      toast.warning({ title: 'Timeline trống', message: 'Thêm clip vào timeline trước khi xuất.' });
      return;
    }

    const dir = await pickProcessingOutputDirectory();
    if (!dir) return;
    const outputPath = `${dir.replace(/[/\\]+$/, '')}/elah_export_${timestamp()}.mp4`;

    setExporting(true);
    setProgress('Đang chuẩn bị…');
    try {
      const blob = await exportVideo(project, {
        videoCodec: 'avc',
        onProgress: (p) => setProgress(`Đang xuất ${p.frame}/${p.totalFrames} khung`),
      });
      setProgress('Đang lưu…');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const saved = await saveEditorExport({ bytes, outputPath, inputName: 'timeline' });
      toast.success({
        title: 'Xuất video thành công',
        message: `${(blob.size / 1_000_000).toFixed(1)} MB`,
        action: { label: 'Mở thư mục', onClick: () => void revealOutputInFolder(saved) },
      });
    } catch (e) {
      toast.error({ title: 'Xuất video thất bại', message: String(e) });
    } finally {
      setExporting(false);
      setProgress('');
    }
  };

  const btn = 'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm border border-ed-border text-ed-text';

  return (
    <div className="elah-root" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 4px' }}>
      <button type="button" className={btn} onClick={handleExport} disabled={exporting}
        style={{ cursor: exporting ? 'wait' : 'pointer', background: 'var(--elah-accent-soft)' }}>
        <Download className="w-4 h-4" />
        {exporting ? 'Đang xuất…' : 'Xuất MP4'}
      </button>
      <button type="button" className={btn} onClick={handleAddToTimeline} style={{ cursor: 'pointer', background: 'transparent' }}>
        <Plus className="w-4 h-4" /> Thêm vào timeline
      </button>
      <button type="button" className={btn} onClick={() => engine?.undo()} style={{ cursor: 'pointer', background: 'transparent' }}>
        <Undo2 className="w-4 h-4" /> Hoàn tác
      </button>
      <button type="button" className={btn} onClick={() => engine?.redo()} style={{ cursor: 'pointer', background: 'transparent' }}>
        <Redo2 className="w-4 h-4" /> Làm lại
      </button>
      <button type="button" className={btn} onClick={handleSplit} style={{ cursor: 'pointer', background: 'transparent' }}>
        <Scissors className="w-4 h-4" /> Tách
      </button>
      {progress && <span className="text-ed-text-muted" style={{ fontSize: 12 }}>{progress}</span>}
    </div>
  );
}
