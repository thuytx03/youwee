import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

// Elah's library components (SourcePanel, Timeline, AudioDropDialog) ship
// hard-coded English text with no i18n hook. This localizes them by rewriting
// the DOM inside `.elah-root`: exact-match text nodes, plus `placeholder`,
// `title` and `aria-label` attributes. Exact-match only, so user data (clip
// names, track names) is never touched. If Elah changes wording it becomes a
// no-op — safe, never throws. Matches @elah/editor v0.3.0 copy.
export function useElahDialogI18n() {
  const { t } = useTranslation('pages');

  useEffect(() => {
    // English source string → localized. Only exact (trimmed) matches replace.
    const dict: Record<string, string> = {
      // AudioDropDialog
      'This video has audio': t('editor.audioDrop.title'),
      'be added to the timeline?': t('editor.audioDrop.descriptionTail'),
      'How should': t('editor.audioDrop.descriptionHead'),
      'Video + Audio': t('editor.audioDrop.both'),
      'Add the video and its audio on a separate audio track': t('editor.audioDrop.bothHint'),
      'Video only': t('editor.audioDrop.videoOnly'),
      'Drop the audio track': t('editor.audioDrop.videoOnlyHint'),
      'Audio only': t('editor.audioDrop.audioOnly'),
      'Add just the audio, no video': t('editor.audioDrop.audioOnlyHint'),
      // SourcePanel tabs / lanes / element tiles
      Media: t('editor.lib.media'),
      Elements: t('editor.lib.elements'),
      Add: t('editor.lib.add'),
      Added: t('editor.lib.added'),
      All: t('editor.lib.all'),
      Video: t('editor.lib.video'),
      Audio: t('editor.lib.audio'),
      Image: t('editor.lib.image'),
      Text: t('editor.lib.text'),
      Rectangle: t('editor.lib.rectangle'),
      Circle: t('editor.lib.circle'),
      Triangle: t('editor.lib.triangle'),
      'Drop files here': t('editor.lib.dropFiles'),
      'No matches': t('editor.lib.noMatches'),
      Name: t('editor.lib.name'),
      Duration: t('editor.lib.duration'),
      Type: t('editor.lib.type'),
    };
    // Attribute values (placeholder / title / aria-label).
    const attrDict: Record<string, string> = {
      'Search…': t('editor.lib.search'),
      'Search elements…': t('editor.lib.searchElements'),
      'Delete clip': t('editor.lib.deleteClip'),
      'Paste clip': t('editor.lib.pasteClip'),
      'Delete track': t('editor.lib.deleteTrack'),
      'Hide track': t('editor.lib.hideTrack'),
      'Show track': t('editor.lib.showTrack'),
      'Lock track': t('editor.lib.lockTrack'),
      'Unlock track': t('editor.lib.unlockTrack'),
      'Mute track': t('editor.lib.muteTrack'),
      'Unmute track': t('editor.lib.unmuteTrack'),
      Close: t('editor.audioDrop.close'),
    };

    const translateRoot = (root: HTMLElement) => {
      // Text nodes (exact trimmed match only).
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      let n = walker.nextNode();
      while (n) {
        nodes.push(n as Text);
        n = walker.nextNode();
      }
      for (const node of nodes) {
        const raw = node.textContent?.trim();
        if (raw && dict[raw] && node.textContent) {
          node.textContent = node.textContent.replace(raw, dict[raw]);
        }
      }
      // Attributes: placeholder / title / aria-label.
      root.querySelectorAll<HTMLElement>('[placeholder],[title],[aria-label]').forEach((el) => {
        for (const attr of ['placeholder', 'title', 'aria-label']) {
          const v = el.getAttribute(attr)?.trim();
          if (v && attrDict[v]) el.setAttribute(attr, attrDict[v]);
        }
      });
    };

    let observer: MutationObserver | null = null;
    let scheduled = false;

    const scan = () => {
      // Pause observation while we mutate, so our own edits don't retrigger the
      // observer (that caused an infinite loop → app freeze).
      observer?.disconnect();
      document.querySelectorAll<HTMLElement>('.elah-root').forEach(translateRoot);
      // AudioDropDialog portals to <body>, outside .elah-root.
      document
        .querySelectorAll<HTMLElement>('[aria-label="Choose how to add this media"]')
        .forEach(translateRoot);
      if (observer) observer.observe(document.body, { childList: true, subtree: true });
    };

    // Coalesce bursts of mutations into one scan on the next frame.
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        scan();
      });
    };

    // childList/subtree only (NOT characterData) — we react to nodes being
    // added, not to our own text edits.
    observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    scan();

    return () => observer?.disconnect();
  }, [t]);
}
