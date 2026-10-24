import { Icon } from './Icon';
import { formatBytes } from '../lib/format-utils';
import type { WorkItem } from '../lib/types';

const STATUS_LABEL: Record<WorkItem['status'], string> = {
  queued: '排队中',
  inspecting: '检查中',
  ready: '已检查',
  cleaning: '清理中',
  cleaned: '已清理',
  error: '出错了',
};

export interface FileListProps {
  items: WorkItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
}

export function FileList({ items, selectedId, onSelect, onRemove }: FileListProps) {
  if (items.length === 0) return null;

  return (
    <ul className="file-list" data-testid="file-list">
      {items.map((item) => {
        const info = item.inspection?.info;
        const risk = item.inspection?.risk ?? 'none';
        const isSelected = item.id === selectedId;
        return (
          <li key={item.id}>
            <div
              className={`file-row${isSelected ? ' selected' : ''}`}
              onClick={() => onSelect(item.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(item.id);
                }
              }}
              data-testid="file-row"
              data-file-name={item.fileName}
            >
              <span className="file-thumb">
                <img src={item.previewUrl} alt="" loading="lazy" />
              </span>
              <span className="file-main">
                <span className="file-name" title={item.fileName}>
                  {item.fileName}
                </span>
                <span className="file-meta">
                  {info ? (
                    <>
                      {info.format.toUpperCase()} · {info.dimension ? `${info.dimension.width}×${info.dimension.height}` : '尺寸未知'} ·{' '}
                      {formatBytes(info.bytes)}
                    </>
                  ) : (
                    formatBytes(item.original.length)
                  )}
                </span>
                <span className="file-status-line">
                  <span className={`status-dot ${item.status}`} />
                  {STATUS_LABEL[item.status]}
                  {item.result?.verified ? <span className="chip ok">已验证</span> : null}
                  {risk === 'high' && !item.result ? <span className="chip danger">含敏感信息</span> : null}
                  {item.inspection?.gps && !item.result ? <span className="chip danger">含 GPS</span> : null}
                </span>
              </span>
              <button
                type="button"
                className="btn btn-icon btn-subtle"
                title="从工作区移除"
                aria-label={`移除 ${item.fileName}`}
                data-testid="remove-file"
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove(item.id);
                }}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
