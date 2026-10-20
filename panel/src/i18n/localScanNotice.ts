import { t } from './index'
import type { LocalScanProgress } from '../services/localScanSession'

/** Translate only structured session notices; preserve older callers' text. */
export function formatLocalScanNotice(progress: Pick<LocalScanProgress, 'notice' | 'noticeDetails'>): string {
  const details = progress.noticeDetails
  if (!details) return progress.notice || ''
  switch (details.type) {
    case 'cancelled':
      return details.operation === 'match' ? t('lora.scan.notice.cancelMatch') : t('lora.scan.notice.cancelScan')
    case 'failed':
      return t('lora.scan.notice.failed', { error: details.error || t('lora.scan.notice.unknownError') })
    case 'scan-complete': {
      if (details.added + details.changed + details.removed === 0) {
        return t('lora.scan.notice.unchanged', { count: details.unchanged })
      }
      const summary = t('lora.scan.notice.complete', {
        added: details.added, changed: details.changed, removed: details.removed, unchanged: details.unchanged,
      })
      return summary + (details.removedDescriptions ? t('lora.scan.notice.removedDescriptions', { count: details.removedDescriptions }) : '')
    }
    case 'match-complete':
      if (details.errors) return t('lora.scan.notice.matchErrors', { count: details.errors })
      return details.total ? t('lora.scan.notice.matchComplete', { count: details.done }) : t('lora.scan.notice.allMatched')
  }
}
